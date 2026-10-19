import { createHash } from "node:crypto";
import { CACHE, publicMediaKey, snapshotKey } from "./keys.js";
import { logDebug, logError, logInfo, logWarn, safeError } from "./logger.js";
import { buildSnapshot, type PublishedAsset, type PublishedSnapshot } from "./publicSnapshot.js";
import { publishErrors } from "./security.js";
import type { ObjectStorage } from "./storage.js";
import { referencedMediaIds, type InvitationGraph, type LogEntry, type MediaInfo } from "./store.js";

export class PublishError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export type PublicationRecord = {
  id: string;
  invitationId: string;
  slug: string;
  version: number;
  objectKey: string;
  mediaIds: string[];
  assetKeys: string[];
  snapshot: unknown;
  publishedAt: Date;
};

export type NewPublication = Omit<PublicationRecord, "id"> & { actor: string };

export interface PublishTx {
  loadGraph(invitationId: string): Promise<InvitationGraph | null>;
  slugTaken(slug: string, exceptInvitationId: string): Promise<boolean>;
  activePublication(invitationId: string): Promise<PublicationRecord | null>;
  findMedia(mediaId: string): Promise<MediaInfo | null>;
  setMediaChecksum(mediaId: string, checksum: string): Promise<void>;
  recordPublication(publication: NewPublication): Promise<void>;
  recordWithdrawal(invitationId: string, at: Date): Promise<void>;
  deleteInvitation(invitationId: string): Promise<void>;
  mediaInUse(mediaId: string): Promise<boolean>;
  deleteMedia(mediaId: string): Promise<void>;
  keyIsLive(publicKey: string): Promise<boolean>;
}

export interface PublishRepo {
  locked<T>(lockKey: string, fn: (tx: PublishTx) => Promise<T>): Promise<T>;
  log(entry: LogEntry): Promise<void>;
}

export type Purger = (urls: string[]) => Promise<void>;

export type PublisherOptions = {
  repo: PublishRepo;
  storage: ObjectStorage;
  fallbackImage: string;
  purge?: Purger;
  now?: () => Date;
};

export function sha256(bytes: Buffer) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function mediaLockKey(media: Pick<MediaInfo, "id" | "ownerInvitationId">) {
  return media.ownerInvitationId || `media:${media.id}`;
}

function serialize(snapshot: unknown) {
  return Buffer.from(JSON.stringify(snapshot));
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : "unknown error");

export function createPublisher(options: PublisherOptions) {
  const { repo, storage } = options;
  const now = options.now || (() => new Date());

  async function purge(keys: string[]) {
    if (!options.purge || !keys.length) return;
    await options.purge(keys.map((key) => storage.publicUrl(key))).catch((error) =>
      repo.log({ action: "cache.purge", actor: "system", ok: false, detail: errorText(error) }).catch(() => undefined),
    );
  }

  async function putSnapshot(key: string, snapshot: unknown) {
    await storage.public.put(key, serialize(snapshot), { contentType: "application/json; charset=utf-8", cacheControl: CACHE.snapshot });
  }

  /** Puts the live JSON back the way the database still describes it. */
  async function restore(previous: PublicationRecord | null, writtenKey: string | null) {
    const problems: string[] = [];
    if (previous) {
      await putSnapshot(previous.objectKey, previous.snapshot).catch((error) => problems.push(errorText(error)));
    }
    if (writtenKey && writtenKey !== previous?.objectKey) {
      await storage.public.delete(writtenKey).catch((error) => problems.push(errorText(error)));
    }
    return problems;
  }

  async function copyAsset(tx: PublishTx, mediaId: string): Promise<PublishedAsset> {
    const media = await tx.findMedia(mediaId);
    if (!media || media.status !== "ready") {
      throw new PublishError(400, "A photograph on this invitation has not finished uploading. Upload it again, then publish.");
    }
    const bytes = await storage.private.get(media.storageKey);
    if (!bytes) throw new PublishError(400, "A photograph on this invitation is missing from storage. Upload it again, then publish.");
    const checksum = sha256(bytes);
    if (media.checksum && media.checksum !== checksum) {
      throw new PublishError(409, "A stored photograph does not match its checksum. Upload it again, then publish.");
    }
    if (!media.checksum) await tx.setMediaChecksum(media.id, checksum);
    const key = publicMediaKey(media.id, checksum);
    if (!(await storage.public.exists(key))) {
      await storage.public.put(key, bytes, { contentType: "image/webp", cacheControl: CACHE.publicMedia });
    } else {
      logDebug("R2", "already_public", { key, mediaId: media.id });
    }
    return { mediaId: media.id, key, url: storage.publicUrl(key), width: media.width, height: media.height };
  }

  async function publish(invitationId: string, actor: string) {
    const started = Date.now();
    let stage = "requested";
    let slug: string | undefined;
    let version: number | undefined;
    logInfo("PUBLISH", "requested", { invitationId });
    let written: { key: string; previous: PublicationRecord | null } | null = null;
    try {
      const result = await repo.locked(invitationId, async (tx) => {
        stage = "load_draft";
        const graph = await tx.loadGraph(invitationId);
        if (!graph) throw new PublishError(404, "Invitation not found");
        slug = graph.slug;

        stage = "validate_draft";
        const errors = publishErrors(graph);
        if (errors.length) throw new PublishError(400, "This invitation is not ready to publish", errors);
        if (await tx.slugTaken(graph.slug, invitationId)) throw new PublishError(409, "That public link is already in use.");
        logInfo("PUBLISH", "draft_validated", { invitationId, slug });

        const previous = await tx.activePublication(invitationId);
        version = Math.max(graph.publishedVersion, previous?.version || 0) + 1;
        logInfo("PUBLISH", "start", { invitationId, slug, version });

        stage = "validate_media";
        const assets = new Map<string, PublishedAsset>();
        const assetStarted = Date.now();
        for (const mediaId of referencedMediaIds(graph)) assets.set(mediaId, await copyAsset(tx, mediaId));
        const mediaCount = assets.size;
        logInfo("PUBLISH", "media_validated", { invitationId, slug, mediaCount });
        logInfo("PUBLISH", "assets_ready", { invitationId, slug, mediaCount, durationMs: Date.now() - assetStarted });
        logInfo("PUBLISH", "urls_generated", { invitationId, slug, mediaCount });

        const publishedAt = now();

        stage = "build_snapshot";
        const snapshot = buildSnapshot(graph, { version, publishedAt, assets, fallbackImage: options.fallbackImage });
        const objectKey = snapshotKey(graph.slug);
        logInfo("PUBLISH", "snapshot_built", { invitationId, slug, version });

        stage = "upload_snapshot";
        await putSnapshot(objectKey, snapshot);
        written = { key: objectKey, previous };
        logInfo("PUBLISH", "snapshot_uploaded", { invitationId, slug, version, key: objectKey });
        if (previous && previous.objectKey !== objectKey) await storage.public.delete(previous.objectKey);

        stage = "database_commit";
        await tx.recordPublication({
          invitationId,
          slug: graph.slug,
          version,
          objectKey,
          mediaIds: [...assets.keys()],
          assetKeys: [...assets.values()].map((asset) => asset.key),
          snapshot,
          publishedAt,
          actor,
        });
        logInfo("PUBLISH", "database_committed", { invitationId, slug, version });
        const dropped = (previous?.mediaIds || []).filter((mediaId) => !assets.has(mediaId));
        return { snapshot, objectKey, previousKey: previous?.objectKey || null, dropped };
      });

      stage = "cache_purge";
      await purge([...new Set([result.objectKey, result.previousKey].filter((key): key is string => Boolean(key)))]);
      await repo.log({ action: "invitation.publish", actor, ok: true, detail: `${result.objectKey} v${result.snapshot.version}` });
      await releaseMedia(result.dropped, actor);
      logInfo("PUBLISH", "success", {
        invitationId,
        slug: result.snapshot.slug,
        version: result.snapshot.version,
        mediaCount: result.snapshot.assets.length,
        durationMs: Date.now() - started,
      });
      return result as { snapshot: PublishedSnapshot; objectKey: string; previousKey: string | null; dropped: string[] };
    } catch (error) {
      const pending = written as { key: string; previous: PublicationRecord | null } | null;
      if (pending) {
        logWarn("PUBLISH", "restoring", { invitationId, slug, key: pending.key });
      }
      const problems = pending ? await restore(pending.previous, pending.key) : [];
      if (pending && problems.length) logError("PUBLISH", "restore_failed", { invitationId, slug, problems });
      else if (pending) logInfo("PUBLISH", "restored", { invitationId, slug });
      await repo
        .log({
          action: "invitation.publish",
          actor,
          ok: false,
          detail: `${invitationId}: ${errorText(error)}${problems.length ? ` | restore failed: ${problems.join("; ")}` : ""}`,
        })
        .catch(() => undefined);
      logError("PUBLISH", "failed", {
        invitationId,
        slug,
        version,
        stage,
        durationMs: Date.now() - started,
        ...safeError(error),
      });
      if (error instanceof PublishError) throw error;
      throw new PublishError(502, "Publishing failed. The live invitation was left as it was.");
    }
  }

  async function unpublish(invitationId: string, actor: string) {
    let removed: PublicationRecord | null = null;
    try {
      const key = await repo.locked(invitationId, async (tx) => {
        const graph = await tx.loadGraph(invitationId);
        if (!graph) throw new PublishError(404, "Invitation not found");
        const active = await tx.activePublication(invitationId);
        if (!active && graph.status !== "published") return null;
        const objectKey = active?.objectKey || graph.publishedKey || snapshotKey(graph.slug);
        await storage.public.delete(objectKey);
        removed = active;
        await tx.recordWithdrawal(invitationId, now());
        return objectKey;
      });
      if (key) {
        await purge([key]);
        await repo.log({ action: "invitation.unpublish", actor, ok: true, detail: key });
        const withdrawn = removed as PublicationRecord | null;
        if (withdrawn) await releaseMedia(withdrawn.mediaIds, actor);
      }
      return { objectKey: key };
    } catch (error) {
      const problems = removed ? await restore(removed, null) : [];
      await repo
        .log({ action: "invitation.unpublish", actor, ok: false, detail: `${invitationId}: ${errorText(error)}${problems.length ? ` | restore failed: ${problems.join("; ")}` : ""}` })
        .catch(() => undefined);
      if (error instanceof PublishError) throw error;
      throw new PublishError(502, "Unpublishing failed. The invitation is still live.");
    }
  }

  async function releaseMedia(mediaIds: string[], actor = "system") {
    const released: string[] = [];
    for (const mediaId of [...new Set(mediaIds)]) {
      const lookup = await repo.locked(`media:${mediaId}`, (tx) => tx.findMedia(mediaId));
      if (!lookup) continue;
      const deleted = await repo.locked(mediaLockKey(lookup), async (tx) => {
        const media = await tx.findMedia(mediaId);
        if (!media || (await tx.mediaInUse(mediaId))) return null;
        await tx.deleteMedia(mediaId);
        return media;
      });
      if (!deleted) continue;
      try {
        await storage.private.delete(deleted.storageKey);
        released.push(mediaId);
      } catch (error) {
        await repo.log({ action: "media.release", actor, ok: false, detail: `${mediaId}: ${errorText(error)}` }).catch(() => undefined);
      }
    }
    return released;
  }

  async function deleteInvitation(invitationId: string, actor: string) {
    let removed: PublicationRecord | null = null;
    try {
      const result = await repo.locked(invitationId, async (tx) => {
        const graph = await tx.loadGraph(invitationId);
        if (!graph) throw new PublishError(404, "Invitation not found");
        const active = await tx.activePublication(invitationId);
        const liveKey = active?.objectKey || (graph.status === "published" ? graph.publishedKey || snapshotKey(graph.slug) : null);
        if (liveKey) {
          await storage.public.delete(liveKey);
          removed = active;
        }
        await tx.deleteInvitation(invitationId);
        return { liveKey, mediaIds: referencedMediaIds(graph), slug: graph.slug };
      });
      if (result.liveKey) await purge([result.liveKey]);
      await repo.log({ action: "invitation.delete", actor, ok: true, detail: result.slug });
      await releaseMedia(result.mediaIds, actor);
      return result;
    } catch (error) {
      const problems = removed ? await restore(removed, null) : [];
      await repo
        .log({ action: "invitation.delete", actor, ok: false, detail: `${invitationId}: ${errorText(error)}${problems.length ? ` | restore failed: ${problems.join("; ")}` : ""}` })
        .catch(() => undefined);
      if (error instanceof PublishError) throw error;
      throw new PublishError(502, "Deleting failed. Nothing was removed.");
    }
  }

  return { publish, unpublish, deleteInvitation, releaseMedia };
}

export type Publisher = ReturnType<typeof createPublisher>;
