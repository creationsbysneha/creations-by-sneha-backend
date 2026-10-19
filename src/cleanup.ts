import type { PrismaClient } from "@prisma/client";
import { isPrivateMediaKey, isPublicMediaKey, mediaIdFromKey, slugFromSnapshotKey } from "./keys.js";
import { logError, logInfo } from "./logger.js";
import { mediaLockKey, type PublishRepo } from "./publishing.js";
import type { Bucket, ObjectStorage, StoredObject } from "./storage.js";
import type { MediaInfo } from "./store.js";

export interface CleanupSource {
  staleMedia(before: Date): Promise<MediaInfo[]>;
  mediaById(ids: string[]): Promise<Map<string, MediaInfo>>;
  invitationIdForSlug(slug: string): Promise<string | null>;
}

export function prismaCleanupSource(prisma: PrismaClient): CleanupSource {
  return {
    staleMedia: (before) => prisma.media.findMany({ where: { createdAt: { lt: before } }, orderBy: { createdAt: "asc" }, take: 1000 }),
    async mediaById(ids) {
      const rows = await prisma.media.findMany({ where: { id: { in: ids } } });
      return new Map(rows.map((row) => [row.id, row]));
    },
    async invitationIdForSlug(slug) {
      const row = await prisma.invitation.findFirst({ where: { OR: [{ slug }, { publishedSlug: slug }] }, select: { id: true } });
      return row?.id || null;
    },
  };
}

export type CleanupOptions = {
  repo: PublishRepo;
  storage: ObjectStorage;
  source?: CleanupSource;
  prisma?: PrismaClient;
  apply: boolean;
  graceHours: number;
  actor: string;
  now?: Date;
};

export type CleanupReport = {
  apply: boolean;
  graceHours: number;
  cutoff: string;
  mediaRows: { pending: string[]; unused: string[] };
  privateObjects: string[];
  publicAssets: string[];
  publicSnapshots: string[];
  deleted: number;
  skipped: number;
  errors: string[];
};

async function listAll(bucket: Bucket, prefix: string) {
  const objects: StoredObject[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list(prefix, cursor);
    objects.push(...page.objects);
    cursor = page.cursor;
  } while (cursor);
  return objects;
}

export async function runCleanup(options: CleanupOptions): Promise<CleanupReport> {
  const { repo, storage, apply } = options;
  const source = options.source || (options.prisma ? prismaCleanupSource(options.prisma) : null);
  if (!source) throw new Error("Cleanup needs a data source.");
  const graceHours = Math.max(1, options.graceHours);
  const cutoff = new Date((options.now || new Date()).getTime() - graceHours * 60 * 60 * 1000);
  const report: CleanupReport = {
    apply,
    graceHours,
    cutoff: cutoff.toISOString(),
    mediaRows: { pending: [], unused: [] },
    privateObjects: [],
    publicAssets: [],
    publicSnapshots: [],
    deleted: 0,
    skipped: 0,
    errors: [],
  };
  const fail = (what: string, error: unknown) => {
    const message = error instanceof Error ? error.message : "failed";
    report.errors.push(`${what}: ${message}`);
    logError("CLEANUP", "delete_failed", { target: what, errorMessage: message });
  };
  logInfo("CLEANUP", apply ? "apply" : "dry_run", { graceHours, apply });

  // Phase 1: database rows for photographs nothing uses any more.
  for (const media of await source.staleMedia(cutoff)) {
    try {
      const candidate = await repo.locked(mediaLockKey(media), async (tx) => {
        const current = await tx.findMedia(media.id);
        if (!current) return null;
        if (current.status === "pending") return { media: current, kind: "pending" as const };
        if (!(await tx.mediaInUse(current.id))) return { media: current, kind: "unused" as const };
        return null;
      });
      if (!candidate) continue;
      report.mediaRows[candidate.kind].push(candidate.media.id);
      if (!apply) continue;
      const removed = await repo.locked(mediaLockKey(candidate.media), async (tx) => {
        const current = await tx.findMedia(candidate.media.id);
        if (!current) return null;
        if (current.status !== "pending" && (await tx.mediaInUse(current.id))) return null;
        await tx.deleteMedia(current.id);
        return current;
      });
      if (!removed) {
        report.skipped += 1;
        continue;
      }
      report.deleted += 1;
      logInfo("CLEANUP", "deleted", { kind: "media_row", mediaId: removed.id });
      if (removed.storageKey && isPrivateMediaKey(removed.storageKey)) {
        await storage.private.delete(removed.storageKey).catch((error) => fail(removed.storageKey, error));
      }
    } catch (error) {
      fail(media.id, error);
    }
  }

  // Phase 2: stored objects older than the grace period that nothing points to.
  const privateObjects = (await listAll(storage.private, "media/")).filter((item) => item.lastModified < cutoff);
  const publicObjects = (await listAll(storage.public, "media/")).filter((item) => item.lastModified < cutoff);
  const snapshots = (await listAll(storage.public, "published/")).filter((item) => item.lastModified < cutoff);
  const ids = [...new Set([...privateObjects, ...publicObjects].map((item) => mediaIdFromKey(item.key)).filter((id): id is string => Boolean(id)))];
  const rows = ids.length ? await source.mediaById(ids) : new Map<string, MediaInfo>();

  for (const object of privateObjects) {
    const mediaId = mediaIdFromKey(object.key);
    if (!mediaId || !isPrivateMediaKey(object.key) || rows.has(mediaId)) continue;
    report.privateObjects.push(object.key);
    if (!apply) continue;
    try {
      const gone = await repo.locked(`media:${mediaId}`, async (tx) => !(await tx.findMedia(mediaId)));
      if (!gone) {
        report.skipped += 1;
        continue;
      }
      await storage.private.delete(object.key);
      report.deleted += 1;
      logInfo("CLEANUP", "deleted", { kind: "private_object", key: object.key });
    } catch (error) {
      fail(object.key, error);
    }
  }

  for (const object of publicObjects) {
    const mediaId = mediaIdFromKey(object.key);
    if (!mediaId || !isPublicMediaKey(object.key)) continue;
    const media = rows.get(mediaId);
    const lockKey = media ? mediaLockKey(media) : `media:${mediaId}`;
    try {
      const live = await repo.locked(lockKey, (tx) => tx.keyIsLive(object.key));
      if (live) continue;
      report.publicAssets.push(object.key);
      if (!apply) continue;
      const removed = await repo.locked(lockKey, async (tx) => {
        if (await tx.keyIsLive(object.key)) return false;
        await storage.public.delete(object.key);
        return true;
      });
      if (removed) {
        report.deleted += 1;
        logInfo("CLEANUP", "deleted", { kind: "public_asset", key: object.key });
      } else report.skipped += 1;
    } catch (error) {
      fail(object.key, error);
    }
  }

  for (const object of snapshots) {
    const slug = slugFromSnapshotKey(object.key);
    if (!slug) continue;
    try {
      const lockKey = (await source.invitationIdForSlug(slug)) || `slug:${slug}`;
      const live = await repo.locked(lockKey, (tx) => tx.keyIsLive(object.key));
      if (live) continue;
      report.publicSnapshots.push(object.key);
      if (!apply) continue;
      const removed = await repo.locked(lockKey, async (tx) => {
        if (await tx.keyIsLive(object.key)) return false;
        await storage.public.delete(object.key);
        return true;
      });
      if (removed) {
        report.deleted += 1;
        logInfo("CLEANUP", "deleted", { kind: "public_snapshot", key: object.key });
      } else report.skipped += 1;
    } catch (error) {
      fail(object.key, error);
    }
  }

  await repo
    .log({
      action: apply ? "storage.cleanup" : "storage.cleanup.dry-run",
      actor: options.actor,
      ok: report.errors.length === 0,
      detail: `rows ${report.mediaRows.pending.length + report.mediaRows.unused.length}, private ${report.privateObjects.length}, public ${report.publicAssets.length}, snapshots ${report.publicSnapshots.length}, deleted ${report.deleted}, errors ${report.errors.length}`,
    })
    .catch(() => undefined);
  logInfo("CLEANUP", apply ? "apply_complete" : "dry_run_complete", {
    deleted: report.deleted,
    skipped: report.skipped,
    errors: report.errors.length,
    mediaRows: report.mediaRows.pending.length + report.mediaRows.unused.length,
    privateObjects: report.privateObjects.length,
    publicAssets: report.publicAssets.length,
    publicSnapshots: report.publicSnapshots.length,
  });
  return report;
}
