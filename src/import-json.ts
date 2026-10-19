import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { CACHE, privateMediaKey } from "./keys.js";
import { sha256 } from "./publishing.js";
import { createStorage } from "./storage.js";

type Row = Record<string, unknown>;
type JsonStore = Partial<Record<"admins" | "invitations" | "events" | "media" | "invitationMedia" | "invitationAccess" | "products" | "productImages", Row[]>>;

const dryRun = !process.argv.includes("--apply");
const source = JSON.parse(await readFile(config.dataFile, "utf8")) as JsonStore;
const storage = createStorage();
const counts: Record<string, { found: number; created: number; skipped: number }> = {};
const problems: string[] = [];

const date = (value: unknown) => (typeof value === "string" && value ? new Date(value) : null);
const text = (value: unknown) => (typeof value === "string" ? value : "");
const tally = (name: string, outcome: "created" | "skipped") => {
  counts[name] ||= { found: 0, created: 0, skipped: 0 };
  counts[name].found += 1;
  counts[name][outcome] += 1;
};

for (const admin of source.admins || []) {
  const email = text(admin.email).toLowerCase();
  const exists = await prisma.admin.findFirst({ where: { OR: [{ id: text(admin.id) }, { email }] }, select: { id: true } });
  if (exists || !admin.passwordHash) {
    tally("admins", "skipped");
    continue;
  }
  if (admin.role === "super_admin") {
    problems.push(`${email}: not imported, because new studio logins are not created by the import.`);
    tally("admins", "skipped");
    continue;
  }
  if (!dryRun) {
    await prisma.admin.create({
      data: { id: text(admin.id), email, passwordHash: text(admin.passwordHash), role: "customer", createdAt: date(admin.createdAt) || new Date() },
    });
  }
  tally("admins", "created");
}

for (const invitation of source.invitations || []) {
  if (await prisma.invitation.findUnique({ where: { id: text(invitation.id) }, select: { id: true } })) {
    tally("invitations", "skipped");
    continue;
  }
  if (!dryRun) {
    const { id, slug, title, template, status, theme, guessOptions, weddingAt, expiresAt, createdAt, updatedAt, publishedAt, ...fields } = invitation;
    const strings = Object.fromEntries(Object.entries(fields).filter(([, value]) => typeof value === "string"));
    await prisma.invitation.create({
      data: {
        ...strings,
        id: text(id),
        slug: text(slug),
        title: text(title) || "Untitled invitation",
        template: text(template) || "classic-envelope",
        status: "draft",
        theme: (theme as object) || { accent: "gold", paper: "cream", script: "great-vibes" },
        guessOptions: (guessOptions as object) || [],
        weddingAt: date(weddingAt),
        expiresAt: date(expiresAt),
        createdAt: date(createdAt) || new Date(),
        updatedAt: date(updatedAt) || new Date(),
      },
    });
  }
  if (status(invitation) === "published") problems.push(`${text(invitation.slug)}: imported as a draft. Publish it again from the studio.`);
  tally("invitations", "created");
}

function status(row: Row) {
  return text(row.status);
}

const ownerOf = (mediaId: string) =>
  text((source.invitationMedia || []).find((link) => link.mediaId === mediaId)?.invitationId) ||
  text((source.events || []).find((event) => event.mediaId === mediaId)?.invitationId) ||
  null;

for (const media of source.media || []) {
  const id = text(media.id);
  if (await prisma.media.findUnique({ where: { id }, select: { id: true } })) {
    tally("media", "skipped");
    continue;
  }
  const oldKey = text(media.storageKey);
  const file = await readFile(path.resolve(config.storageDir, oldKey)).catch(() => null);
  if (!file) {
    problems.push(`${id}: the photograph file is missing locally, so it was not imported.`);
    tally("media", "skipped");
    continue;
  }
  if (!dryRun) {
    const key = privateMediaKey(id);
    await storage.private.put(key, file, { contentType: "image/webp", cacheControl: CACHE.privateMedia });
    await prisma.media.create({
      data: {
        id,
        storageKey: key,
        mimeType: "image/webp",
        width: Number(media.width) || 0,
        height: Number(media.height) || 0,
        byteSize: file.length,
        status: "ready",
        ownerInvitationId: ownerOf(id),
        checksum: sha256(file),
        createdAt: date(media.createdAt) || new Date(),
      },
    });
  }
  tally("media", "created");
}

for (const event of source.events || []) {
  if (await prisma.ceremonyEvent.findUnique({ where: { id: text(event.id) }, select: { id: true } })) {
    tally("events", "skipped");
    continue;
  }
  if (!dryRun) {
    await prisma.ceremonyEvent.create({
      data: {
        id: text(event.id),
        invitationId: text(event.invitationId),
        sortOrder: Number(event.sortOrder) || 0,
        title: text(event.title),
        subtitle: text(event.subtitle),
        dateLabel: text(event.dateLabel),
        venue: text(event.venue),
        description: text(event.description),
        imageAlt: text(event.imageAlt),
        details: (event.details as object) || [],
        mediaId: text(event.mediaId) || null,
      },
    });
  }
  tally("events", "created");
}

for (const link of source.invitationMedia || []) {
  if (await prisma.invitationMedia.findUnique({ where: { id: text(link.id) }, select: { id: true } })) {
    tally("invitationMedia", "skipped");
    continue;
  }
  if (!dryRun) {
    await prisma.invitationMedia.create({
      data: {
        id: text(link.id),
        invitationId: text(link.invitationId),
        mediaId: text(link.mediaId),
        role: text(link.role),
        sortOrder: Number(link.sortOrder) || 0,
        alt: text(link.alt),
      },
    });
  }
  tally("invitationMedia", "created");
}

for (const access of source.invitationAccess || []) {
  const where = { adminId_invitationId: { adminId: text(access.adminId), invitationId: text(access.invitationId) } };
  if (await prisma.invitationAccess.findUnique({ where, select: { id: true } })) {
    tally("invitationAccess", "skipped");
    continue;
  }
  if (!dryRun) await prisma.invitationAccess.create({ data: { adminId: text(access.adminId), invitationId: text(access.invitationId) } });
  tally("invitationAccess", "created");
}

if ((source.products || []).length || (source.productImages || []).length) {
  problems.push("Products in the JSON file were not imported. There is no product editor yet.");
}

console.log(JSON.stringify({ dryRun, counts, problems }, null, 2));
if (dryRun) console.log("Dry run only. Run with --apply to write to Neon and the private bucket.");
await prisma.$disconnect();
