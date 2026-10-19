import type { Prisma, PrismaClient } from "@prisma/client";
import type { PublicationRecord, PublishRepo, PublishTx } from "./publishing.js";
import { addLog, loadGraph, type Db } from "./store.js";

const TRANSACTION = { maxWait: 15_000, timeout: 90_000 } as const;

const asStrings = (value: Prisma.JsonValue): string[] => (Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);

function toPublication(row: {
  id: string;
  invitationId: string;
  slug: string;
  version: number;
  objectKey: string;
  mediaIds: Prisma.JsonValue;
  assetKeys: Prisma.JsonValue;
  snapshot: Prisma.JsonValue;
  publishedAt: Date;
}): PublicationRecord {
  return { ...row, mediaIds: asStrings(row.mediaIds), assetKeys: asStrings(row.assetKeys) };
}

export async function lock(tx: Prisma.TransactionClient, key: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))::text AS locked`;
}

export async function mediaInUse(db: Db, mediaId: string) {
  const [links, events, products] = await Promise.all([
    db.invitationMedia.count({ where: { mediaId } }),
    db.ceremonyEvent.count({ where: { mediaId } }),
    db.productImage.count({ where: { mediaId } }),
  ]);
  if (links || events || products) return true;
  const live = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM invitation_publications
    WHERE state = 'active' AND media_ids @> ${JSON.stringify([mediaId])}::jsonb
    LIMIT 1`;
  return live.length > 0;
}

export function prismaTx(tx: Prisma.TransactionClient): PublishTx {
  return {
    loadGraph: (id) => loadGraph(tx, id),
    async slugTaken(slug, exceptInvitationId) {
      const other = await tx.invitation.findFirst({
        where: { id: { not: exceptInvitationId }, OR: [{ slug }, { publishedSlug: slug }] },
        select: { id: true },
      });
      return Boolean(other);
    },
    async activePublication(invitationId) {
      const row = await tx.invitationPublication.findFirst({ where: { invitationId, state: "active" }, orderBy: { version: "desc" } });
      return row ? toPublication(row) : null;
    },
    findMedia: (mediaId) => tx.media.findUnique({ where: { id: mediaId } }),
    async setMediaChecksum(mediaId, checksum) {
      await tx.media.update({ where: { id: mediaId }, data: { checksum } });
    },
    async recordPublication(publication) {
      await tx.invitationPublication.updateMany({
        where: { invitationId: publication.invitationId, state: "active" },
        data: { state: "withdrawn", withdrawnAt: publication.publishedAt },
      });
      await tx.invitationPublication.create({
        data: {
          invitationId: publication.invitationId,
          slug: publication.slug,
          version: publication.version,
          objectKey: publication.objectKey,
          mediaIds: publication.mediaIds,
          assetKeys: publication.assetKeys,
          snapshot: publication.snapshot as Prisma.InputJsonValue,
          actor: publication.actor,
          publishedAt: publication.publishedAt,
        },
      });
      await tx.invitation.update({
        where: { id: publication.invitationId },
        data: {
          status: "published",
          publishedVersion: publication.version,
          publishedSlug: publication.slug,
          publishedKey: publication.objectKey,
          publishedAt: publication.publishedAt,
          updatedAt: publication.publishedAt,
        },
      });
    },
    async recordWithdrawal(invitationId, at) {
      await tx.invitationPublication.updateMany({ where: { invitationId, state: "active" }, data: { state: "withdrawn", withdrawnAt: at } });
      await tx.invitation.update({
        where: { id: invitationId },
        data: { status: "draft", publishedSlug: null, publishedKey: null, updatedAt: at },
      });
    },
    async deleteInvitation(invitationId) {
      await tx.invitationPublication.updateMany({ where: { invitationId, state: "active" }, data: { state: "withdrawn", withdrawnAt: new Date() } });
      await tx.invitation.delete({ where: { id: invitationId } });
    },
    mediaInUse: (mediaId) => mediaInUse(tx, mediaId),
    async deleteMedia(mediaId) {
      await tx.media.delete({ where: { id: mediaId } });
    },
    async keyIsLive(publicKey) {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM invitation_publications
        WHERE state = 'active' AND (object_key = ${publicKey} OR asset_keys @> ${JSON.stringify([publicKey])}::jsonb)
        LIMIT 1`;
      return rows.length > 0;
    },
  };
}

export async function withLock<T>(prisma: PrismaClient, key: string, fn: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    await lock(tx, key);
    return fn(tx);
  }, TRANSACTION);
}

export function createPrismaRepo(prisma: PrismaClient): PublishRepo {
  return {
    locked: (key, fn) => withLock(prisma, key, (tx) => fn(prismaTx(tx))),
    log: (entry) => addLog(prisma, entry),
  };
}
