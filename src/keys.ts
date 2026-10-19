import { SLUG_PATTERN } from "./security.js";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PRIVATE_MEDIA = new RegExp(`^media/${UUID}\\.webp$`);
const PUBLIC_MEDIA = new RegExp(`^media/${UUID}/[0-9a-f]{16}\\.webp$`);
const SNAPSHOT = /^published\/([a-z0-9]+(?:-[a-z0-9]+)*)\.json$/;

export const CACHE = {
  privateMedia: "private, no-store",
  publicMedia: "public, max-age=31536000, immutable",
  snapshot: "public, max-age=60, must-revalidate",
} as const;

function requireUuid(id: string) {
  if (!new RegExp(`^${UUID}$`).test(id)) throw new Error("Invalid media id");
}

export function privateMediaKey(mediaId: string) {
  requireUuid(mediaId);
  return `media/${mediaId}.webp`;
}

export function publicMediaKey(mediaId: string, checksum: string) {
  requireUuid(mediaId);
  if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error("Invalid checksum");
  return `media/${mediaId}/${checksum.slice(0, 16)}.webp`;
}

export function snapshotKey(slug: string) {
  if (!SLUG_PATTERN.test(slug) || slug.length > 120) throw new Error("Invalid slug");
  return `published/${slug}.json`;
}

export function isPrivateMediaKey(key: string) {
  return PRIVATE_MEDIA.test(key);
}

export function isPublicMediaKey(key: string) {
  return PUBLIC_MEDIA.test(key);
}

export function slugFromSnapshotKey(key: string) {
  return SNAPSHOT.exec(key)?.[1] || null;
}

export function mediaIdFromKey(key: string) {
  return new RegExp(`^media/(${UUID})`).exec(key)?.[1] || null;
}

export function assertStorageKey(kind: "private" | "public", key: string) {
  const valid = kind === "private" ? isPrivateMediaKey(key) : isPublicMediaKey(key) || SNAPSHOT.test(key);
  if (!valid) throw new Error(`Refusing an unexpected ${kind} storage key`);
}
