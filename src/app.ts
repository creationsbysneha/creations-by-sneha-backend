import cookieParser from "cookie-parser";
import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import multer from "multer";
import { randomUUID } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import type { Prisma, PrismaClient } from "@prisma/client";
import { ZodError } from "zod";
import { config, fallbackImageUrl, isAllowedBrowserOrigin } from "./config.js";
import { prisma as defaultPrisma } from "./db.js";
import { requestLogging } from "./httpLogging.js";
import { CACHE, privateMediaKey } from "./keys.js";
import { bindRequestUser, logError, logInfo, logWarn, safeError, timed } from "./logger.js";
import { cloneInvitation } from "./cloneInvitation.js";
import { presentInvitation } from "./present.js";
import { createPublisher, PublishError, sha256, type Publisher } from "./publishing.js";
import { cloudflarePurger } from "./purge.js";
import { createPrismaRepo, withLock } from "./repo.js";
import { csrfMatches, familyLoginEmail, hashSecret, invitationAccess, newSecret, nextDemoSlug, parseExpiryDate, parseWeddingAt, passwordProblems, slugReserved, type AccountRole, type InvitationAction } from "./security.js";
import { createStorage, type ObjectStorage } from "./storage.js";
import { addLog, loadGraph, referencedMediaIds } from "./store.js";
import { runCleanup } from "./cleanup.js";
import { accessSchema, cleanupSchema, createCustomerSchema, createInvitationSchema, defaultTheme, loginSchema, updateSchema } from "./validate.js";

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024, files: 1 },
});

class HttpError extends Error {
  status: number;
  details?: unknown;
  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

type StudioSession = {
  id: string;
  csrfToken: string;
  admin: { id: string; email: string; role: AccountRole; invitationIds: string[] };
};

const MEDIA_ROLES = ["hero", "envelope", "venue", "gallery", "ceremony"] as const;

const TEXT_FIELDS = [
  "title",
  "description",
  "brideName",
  "brideFull",
  "brideParents",
  "brideGrandparents",
  "groomName",
  "groomFull",
  "groomParents",
  "groomGrandparents",
  "families",
  "blessing",
  "complimentOne",
  "complimentTwo",
  "rsvpFamily",
  "cousinsLabel",
  "cousins",
  "venueName",
  "venueAddress1",
  "venueAddress2",
  "venueNote",
  "mapEmbed",
  "directionsUrl",
  "rsvpMode",
] as const;

function assertInvitation(session: StudioSession, action: InvitationAction, invitationId?: string) {
  if (invitationAccess(session.admin.role, session.admin.invitationIds, action, invitationId) === "deny") {
    if (config.logging.authEvents) {
      logWarn("AUTH", "forbidden", { userId: session.admin.id, role: session.admin.role, action, invitationId });
    }
    throw new HttpError(403, "This login cannot change that invitation.");
  }
}

function assertSuperAdmin(session: StudioSession) {
  if (session.admin.role !== "super_admin") {
    if (config.logging.authEvents) {
      logWarn("AUTH", "forbidden", { userId: session.admin.id, role: session.admin.role, action: "admin" });
    }
    throw new HttpError(403, "Only a studio login can do that.");
  }
}

function cookieOptions() {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: config.cookieSecure,
    path: "/",
    maxAge: config.sessionTtlHours * 60 * 60 * 1000,
  };
}

function looksLikeImage(buffer: Buffer, mime: string) {
  if (mime === "image/jpeg") return buffer.length > 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
  if (mime === "image/png") {
    return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  }
  if (mime === "image/webp") return buffer.subarray(0, 4).toString() === "RIFF" && buffer.subarray(8, 12).toString() === "WEBP";
  return false;
}

/** A card may only use photographs uploaded to it; imported photographs without an owner are claimed. */
async function claimMedia(tx: Prisma.TransactionClient, mediaId: string, invitationId: string) {
  const media = await tx.media.findUnique({ where: { id: mediaId } });
  if (!media || media.status !== "ready") throw new HttpError(400, "One of the selected photographs no longer exists.");
  if (media.ownerInvitationId && media.ownerInvitationId !== invitationId) {
    throw new HttpError(400, "That photograph belongs to another invitation.");
  }
  if (!media.ownerInvitationId) await tx.media.update({ where: { id: mediaId }, data: { ownerInvitationId: invitationId } });
}

async function replaceRole(tx: Prisma.TransactionClient, invitationId: string, role: string, mediaId: string | null | undefined) {
  if (mediaId === undefined) return;
  await tx.invitationMedia.deleteMany({ where: { invitationId, role } });
  if (mediaId) {
    await claimMedia(tx, mediaId, invitationId);
    await tx.invitationMedia.create({ data: { invitationId, mediaId, role, sortOrder: 0, alt: "" } });
  }
}

export type AppDeps = {
  prisma?: PrismaClient;
  storage?: ObjectStorage;
  publisher?: Publisher;
};

export function createApp(deps: AppDeps = {}) {
  const prisma = deps.prisma || defaultPrisma;
  const storage = deps.storage || createStorage();
  const repo = createPrismaRepo(prisma);
  const publisher =
    deps.publisher ||
    createPublisher({ repo, storage, fallbackImage: fallbackImageUrl, purge: cloudflarePurger(config.cloudflareZoneId, config.cloudflareApiToken) });

  async function currentSession(req: Request): Promise<StudioSession | null> {
    const token = req.cookies?.cbs_session as string | undefined;
    if (!token) return null;
    const session = await prisma.session.findUnique({
      where: { tokenHash: hashSecret(token) },
      include: { admin: { include: { access: { select: { invitationId: true } } } } },
    });
    if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) return null;
    return {
      id: session.id,
      csrfToken: session.csrfToken,
      admin: {
        id: session.admin.id,
        email: session.admin.email,
        role: session.admin.role,
        invitationIds: session.admin.access.map((item) => item.invitationId),
      },
    };
  }

  async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    try {
      const token = req.cookies?.cbs_session as string | undefined;
      if (!token) {
        if (config.logging.authEvents) logWarn("AUTH", "unauthorized", { reason: "missing_session" });
        return res.status(401).json({ error: "Sign in required" });
      }
      const session = await currentSession(req);
      if (!session) {
        if (config.logging.authEvents) logWarn("AUTH", "unauthorized", { reason: "invalid_or_expired" });
        return res.status(401).json({ error: "Sign in required" });
      }
      const method = req.method.toUpperCase();
      if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
        if (!csrfMatches(session.csrfToken, req.get("x-csrf-token"))) {
          if (config.logging.authEvents) logWarn("AUTH", "forbidden", { userId: session.admin.id, reason: "csrf" });
          return res.status(403).json({ error: "The session check failed. Refresh and try again." });
        }
      }
      res.locals.session = session;
      bindRequestUser(session.admin.id, session.admin.role);
      next();
    } catch (error) {
      next(error);
    }
  }

  async function presentById(id: string) {
    const graph = await loadGraph(prisma, id);
    if (!graph) throw new HttpError(404, "Invitation not found");
    return presentInvitation(graph, { badge: "" });
  }

  async function knownInvitationIds(ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await prisma.invitation.count({ where: { id: { in: unique }, isDemo: false } });
    if (found !== unique.length) throw new HttpError(400, "Choose invitations that exist.");
    return unique;
  }

  async function unusedDemoSlug() {
    const rows = await prisma.invitation.findMany({ where: { slug: { startsWith: "demo" } }, select: { slug: true } });
    return nextDemoSlug(rows.map((row) => row.slug));
  }

  async function presentAccount(adminId: string) {
    const admin = await prisma.admin.findUnique({ where: { id: adminId }, include: { access: { select: { invitationId: true } } } });
    if (!admin) throw new HttpError(404, "That login was not found.");
    return {
      id: admin.id,
      email: admin.email,
      role: admin.role,
      createdAt: admin.createdAt.toISOString(),
      invitationIds: admin.access.map((item) => item.invitationId),
    };
  }

  const app = express();
  if (config.trustProxy) app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(helmet({ crossOriginResourcePolicy: { policy: "cross-origin" }, contentSecurityPolicy: false }));
  app.use(
    cors({
      origin(origin, callback) {
        callback(null, isAllowedBrowserOrigin(origin));
      },
      credentials: true,
      allowedHeaders: ["Content-Type", "X-CSRF-Token"],
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    }),
  );
  app.use(requestLogging);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());

  if (storage.driver === "local") {
    app.use(
      "/dev-public",
      express.static(path.resolve(config.storageDir, "public"), {
        fallthrough: false,
        index: false,
        setHeaders(res, file) {
          res.setHeader("Cache-Control", file.endsWith(".json") ? CACHE.snapshot : CACHE.publicMedia);
        },
      }),
    );
  }

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 8,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: "Too many sign-in attempts. Try again later." },
  });

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true, storage: storage.driver });
  });

  app.post("/api/auth/login", loginLimiter, async (req, res, next) => {
    try {
      const body = loginSchema.parse(req.body);
      const email = body.email.toLowerCase();
      const admin = await prisma.admin.findUnique({ where: { email } }).catch((error) => {
        logError("DB", "auth_lookup_failed", safeError(error));
        throw error;
      });
      const { verify } = await import("argon2");
      const valid = admin ? await verify(admin.passwordHash, body.password) : false;
      if (!admin || !valid) {
        await addLog(prisma, { action: "login", actor: email, ok: false, detail: "Rejected sign-in" });
        if (config.logging.authEvents) logWarn("AUTH", "login_failed");
        throw new HttpError(401, "Email or password is incorrect");
      }
      const token = newSecret();
      const csrfToken = newSecret();
      await prisma.session.create({
        data: {
          adminId: admin.id,
          tokenHash: hashSecret(token),
          csrfToken,
          expiresAt: new Date(Date.now() + config.sessionTtlHours * 60 * 60 * 1000),
        },
      });
      await addLog(prisma, { action: "login", actor: admin.email, ok: true, detail: "Signed in" });
      if (config.logging.authEvents) logInfo("AUTH", "login_success", { userId: admin.id, role: admin.role });
      res.cookie("cbs_session", token, cookieOptions());
      res.json({ email: admin.email, role: admin.role, csrfToken });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/auth/me", requireAdmin, (_req, res) => {
    const session = res.locals.session as StudioSession;
    res.json({ email: session.admin.email, role: session.admin.role, csrfToken: session.csrfToken });
  });

  app.post("/api/auth/logout", requireAdmin, async (_req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      await prisma.session.update({ where: { id: session.id }, data: { revokedAt: new Date() } });
      await addLog(prisma, { action: "logout", actor: session.admin.email, ok: true, detail: "Signed out" });
      if (config.logging.authEvents) logInfo("AUTH", "logout", { userId: session.admin.id });
      res.clearCookie("cbs_session", { path: "/", sameSite: "lax", secure: config.cookieSecure, httpOnly: true });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/media/:id", requireAdmin, async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      const media = await prisma.media.findUnique({
        where: { id: req.params.id },
        include: { links: { select: { invitationId: true } }, events: { select: { invitationId: true } } },
      });
      if (!media || media.status !== "ready") throw new HttpError(404, "Photograph not found");
      const owners = new Set(
        [media.ownerInvitationId, ...media.links.map((link) => link.invitationId), ...media.events.map((event) => event.invitationId)].filter(
          (owner): owner is string => Boolean(owner),
        ),
      );
      const allowed = session.admin.role === "super_admin" || [...owners].some((owner) => session.admin.invitationIds.includes(owner));
      if (!allowed) {
        if (config.logging.authEvents) logWarn("AUTH", "media_denied", { userId: session.admin.id, mediaId: req.params.id });
        throw new HttpError(404, "Photograph not found");
      }
      const bytes = await storage.private.get(media.storageKey);
      if (!bytes) {
        logWarn("MEDIA", "missing_asset", { mediaId: media.id });
        throw new HttpError(404, "Photograph not found");
      }
      res.setHeader("Content-Type", "image/webp");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Cache-Control", CACHE.privateMedia);
      res.send(bytes);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/invitations", requireAdmin);

  app.get("/api/invitations", async (_req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      const rows = await prisma.invitation.findMany({
        where: {
          ...(session.admin.role === "super_admin" ? {} : { isDemo: false, id: { in: session.admin.invitationIds } }),
        },
        orderBy: { updatedAt: "desc" },
        select: {
          id: true,
          title: true,
          slug: true,
          status: true,
          isDemo: true,
          theme: true,
          updatedAt: true,
          publishedAt: true,
          publishedVersion: true,
          weddingAt: true,
          expiresAt: true,
          brideName: true,
          groomName: true,
          mediaLinks: {
            where: { role: { in: ["hero", "envelope"] } },
            select: { mediaId: true, role: true },
          },
        },
      });
      res.json({
        invitations: rows.map((item) => {
          const cover = item.mediaLinks.find((link) => link.role === "hero") || item.mediaLinks.find((link) => link.role === "envelope");
          const pair = [item.brideName, item.groomName].filter(Boolean).join(" & ");
          const theme = (item.theme || defaultTheme) as typeof defaultTheme;
          return {
            id: item.id,
            title: item.title,
            slug: item.slug,
            status: item.status,
            isDemo: item.isDemo,
            theme,
            couple: pair,
            coverUrl: cover?.mediaId ? `/api/media/${cover.mediaId}` : "",
            updatedAt: item.updatedAt.toISOString(),
            weddingAt: item.weddingAt?.toISOString() || null,
            expiresAt: item.expiresAt?.toISOString() || null,
            publishedVersion: item.publishedVersion,
            hasUnpublishedChanges: item.status === "published" && Boolean(item.publishedAt) && item.updatedAt > (item.publishedAt as Date),
          };
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/invitations", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertInvitation(session, "create");
      const body = createInvitationSchema.parse(req.body || {});
      const isDemo = body.isDemo === true;
      let createdId = "";
      if (body.cloneId) {
        const source = await loadGraph(prisma, body.cloneId);
        if (!source) throw new HttpError(404, "Invitation not found");
        const slug = body.slug || (isDemo || source.isDemo ? await unusedDemoSlug() : `draft-${newSecret().slice(0, 8)}`);
        if (slugReserved(slug, isDemo || source.isDemo)) throw new HttpError(400, "That public link is reserved.");
        const taken = await prisma.invitation.findFirst({
          where: { OR: [{ slug }, { publishedSlug: slug }] },
          select: { id: true },
        });
        if (taken) throw new HttpError(409, "That public link is already in use.");
        const cloned = await cloneInvitation(prisma, storage, source, { slug, isDemo: isDemo || source.isDemo, theme: body.theme });
        createdId = cloned.id;
      } else {
        const created = await prisma.invitation.create({
          data: {
            slug: isDemo ? await unusedDemoSlug() : `draft-${newSecret().slice(0, 8)}`,
            isDemo,
            theme: body.theme || defaultTheme,
            guessOptions: [
              { id: "A", label: "Partner one" },
              { id: "B", label: "Partner two" },
              { id: "C", label: "Both" },
            ],
          },
        });
        createdId = created.id;
      }
      await addLog(prisma, { action: "invitation.create", actor: session.admin.email, ok: true, detail: createdId });
      logInfo("DB", "invitation_created", { invitationId: createdId, userId: session.admin.id, isDemo });
      res.status(201).json(await presentById(createdId));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/invitations/:id", async (req, res, next) => {
    try {
      assertInvitation(res.locals.session as StudioSession, "read", req.params.id);
      res.json(await presentById(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/invitations/:id", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      const input = updateSchema.parse(req.body);
      assertInvitation(session, "update", req.params.id);
      const invitationId = req.params.id;

      const released = await timed("DB", "invitation_saved", () => withLock(prisma, invitationId, async (tx) => {
        const before = await loadGraph(tx, invitationId);
        if (!before) throw new HttpError(404, "Invitation not found");
        const data: Prisma.InvitationUpdateInput = {};
        const studio = session.admin.role === "super_admin";
        if (studio && input.slug && input.slug !== before.slug) {
          if (slugReserved(input.slug, before.isDemo || input.isDemo === true)) throw new HttpError(400, "That public link is reserved.");
          const taken = await tx.invitation.findFirst({
            where: { id: { not: invitationId }, OR: [{ slug: input.slug }, { publishedSlug: input.slug }] },
            select: { id: true },
          });
          if (taken) throw new HttpError(409, "That public link is already in use.");
          data.slug = input.slug;
        }
        for (const field of TEXT_FIELDS) {
          if (input[field] !== undefined) (data as Record<string, unknown>)[field] = input[field];
        }
        if (input.theme !== undefined) data.theme = input.theme;
        if (studio && input.isDemo !== undefined) data.isDemo = input.isDemo;
        if (input.guessOptions !== undefined) data.guessOptions = input.guessOptions;
        if (input.weddingAt !== undefined) {
          if (!input.weddingAt) data.weddingAt = null;
          else {
            const parsed = parseWeddingAt(input.weddingAt);
            if (Number.isNaN(parsed.getTime())) throw new HttpError(400, "Enter a valid wedding date.");
            data.weddingAt = parsed;
          }
        }
        if (studio && input.expiresAt !== undefined) {
          if (!input.expiresAt) data.expiresAt = null;
          else {
            const parsed = parseExpiryDate(input.expiresAt);
            if (Number.isNaN(parsed.getTime())) throw new HttpError(400, "Enter a valid expiry date.");
            data.expiresAt = parsed;
          }
        }

        await replaceRole(tx, invitationId, "hero", input.heroMediaId);
        await replaceRole(tx, invitationId, "envelope", input.envelopeMediaId);
        await replaceRole(tx, invitationId, "venue", input.venueMediaId);
        if (input.gallery) {
          await tx.invitationMedia.deleteMany({ where: { invitationId, role: "gallery" } });
          for (const [index, photo] of input.gallery.entries()) {
            await claimMedia(tx, photo.mediaId, invitationId);
            await tx.invitationMedia.create({
              data: { invitationId, mediaId: photo.mediaId, role: "gallery", sortOrder: index, alt: photo.alt || "" },
            });
          }
        }
        if (input.ceremonies) {
          await tx.ceremonyEvent.deleteMany({ where: { invitationId } });
          for (const [index, ceremony] of input.ceremonies.entries()) {
            if (ceremony.mediaId) await claimMedia(tx, ceremony.mediaId, invitationId);
            await tx.ceremonyEvent.create({
              data: {
                invitationId,
                sortOrder: index,
                title: ceremony.title,
                subtitle: ceremony.subtitle || "",
                dateLabel: ceremony.date || "",
                venue: ceremony.venue || "",
                description: ceremony.description || "",
                imageAlt: ceremony.imageAlt || "",
                details: ceremony.events || [],
                mediaId: ceremony.mediaId || null,
              },
            });
          }
        }
        await tx.invitation.update({ where: { id: invitationId }, data: { ...data, updatedAt: new Date() } });
        const after = await loadGraph(tx, invitationId);
        const kept = new Set(after ? referencedMediaIds(after) : []);
        return referencedMediaIds(before).filter((mediaId) => !kept.has(mediaId));
      }), { invitationId });

      await addLog(prisma, { action: "invitation.save", actor: session.admin.email, ok: true, detail: invitationId });
      await publisher.releaseMedia(released, session.admin.email);
      res.json(await presentById(invitationId));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/invitations/:id/publish", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertInvitation(session, "publish", req.params.id);
      if (config.logging.authEvents) {
        logInfo("AUTH", "authorized", { userId: session.admin.id, action: "publish", invitationId: req.params.id });
      }
      const result = await publisher.publish(req.params.id, session.admin.email);
      res.json({ ...(await presentById(req.params.id)), liveUrl: storage.publicUrl(result.objectKey) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/invitations/:id/unpublish", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertInvitation(session, "unpublish", req.params.id);
      await publisher.unpublish(req.params.id, session.admin.email);
      res.json(await presentById(req.params.id));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/invitations/:id", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertInvitation(session, "delete", req.params.id);
      await publisher.deleteInvitation(req.params.id, session.admin.email);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/invitations/:id/images", upload.single("file"), async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      const invitationId = req.params.id;
      assertInvitation(session, "update", invitationId);
      const file = req.file;
      const role = String(req.body.role || "") as (typeof MEDIA_ROLES)[number];
      if (!file) {
        logWarn("MEDIA", "validation_failed", { reason: "missing_file", invitationId });
        throw new HttpError(400, "Choose a photograph to upload.");
      }
      if (!MEDIA_ROLES.includes(role)) {
        logWarn("MEDIA", "validation_failed", { reason: "unsupported_role", invitationId });
        throw new HttpError(400, "That photograph does not have a place on the invitation.");
      }
      if (!looksLikeImage(file.buffer, file.mimetype)) {
        logWarn("MEDIA", "validation_failed", { reason: "unsupported_type", invitationId, contentType: file.mimetype });
        throw new HttpError(400, "Upload a JPEG, PNG, or WebP photograph.");
      }
      if (!(await prisma.invitation.findUnique({ where: { id: invitationId }, select: { id: true } }))) {
        throw new HttpError(404, "Invitation not found");
      }
      const meta = await sharp(file.buffer, { failOn: "error" }).metadata();
      if (!meta.width || !meta.height || !["jpeg", "png", "webp"].includes(meta.format || "")) {
        logWarn("MEDIA", "validation_failed", { reason: "unusable_image", invitationId });
        throw new HttpError(400, "That file is not a usable photograph.");
      }
      if (meta.width > 8000 || meta.height > 8000) {
        logWarn("MEDIA", "validation_failed", { reason: "pixel_limit", invitationId });
        throw new HttpError(400, "Photographs must be 8000 pixels or smaller on each side.");
      }
      const output = await sharp(file.buffer)
        .rotate()
        .resize({ width: 2000, height: 2000, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer();
      const info = await sharp(output).metadata();

      const mediaId = randomUUID();
      const storageKey = privateMediaKey(mediaId);
      const pending = await prisma.media.create({
        data: {
          id: mediaId,
          storageKey,
          mimeType: "image/webp",
          width: info.width || meta.width,
          height: info.height || meta.height,
          byteSize: output.length,
          status: "pending",
          ownerInvitationId: invitationId,
          purpose: role,
          checksum: sha256(output),
        },
      });
      let stored = false;
      try {
        await storage.private.put(storageKey, output, { contentType: "image/webp", cacheControl: CACHE.privateMedia });
        stored = true;
        const replaced = await withLock(prisma, invitationId, async (tx) => {
          const current = await tx.invitation.findUnique({ where: { id: invitationId }, select: { id: true } });
          if (!current) throw new HttpError(404, "Invitation not found");
          await tx.media.update({ where: { id: pending.id }, data: { status: "ready" } });
          const previous: string[] = [];
          if (role === "ceremony") {
            const events = await tx.ceremonyEvent.findMany({ where: { invitationId }, orderBy: { sortOrder: "asc" } });
            const event = events[Number(req.body.ceremonyIndex)];
            if (event) {
              if (event.mediaId) previous.push(event.mediaId);
              await tx.ceremonyEvent.update({ where: { id: event.id }, data: { mediaId: pending.id } });
            }
          } else if (role === "gallery") {
            const count = await tx.invitationMedia.count({ where: { invitationId, role: "gallery" } });
            await tx.invitationMedia.create({ data: { invitationId, mediaId: pending.id, role: "gallery", sortOrder: count, alt: "" } });
          } else {
            const links = await tx.invitationMedia.findMany({ where: { invitationId, role } });
            previous.push(...links.map((link) => link.mediaId));
            await replaceRole(tx, invitationId, role, pending.id);
          }
          await tx.invitation.update({ where: { id: invitationId }, data: { updatedAt: new Date() } });
          return previous;
        });
        await addLog(prisma, { action: "image.upload", actor: session.admin.email, ok: true, detail: `${invitationId} ${role}` });
        logInfo("MEDIA", "uploaded", { invitationId, mediaId: pending.id, role });
        await publisher.releaseMedia(replaced, session.admin.email);
        res.status(201).json({ mediaId: pending.id, url: `${config.publicApiUrl}/api/media/${pending.id}` });
      } catch (error) {
        if (stored) await storage.private.delete(storageKey).catch(() => undefined);
        await prisma.media.deleteMany({ where: { id: pending.id, status: "pending" } }).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/invitations/:id/images/:mediaId", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      const { id: invitationId, mediaId } = req.params;
      assertInvitation(session, "update", invitationId);
      await withLock(prisma, invitationId, async (tx) => {
        const current = await tx.invitation.findUnique({ where: { id: invitationId }, select: { id: true } });
        if (!current) throw new HttpError(404, "Invitation not found");
        await tx.invitationMedia.deleteMany({ where: { invitationId, mediaId } });
        await tx.ceremonyEvent.updateMany({ where: { invitationId, mediaId }, data: { mediaId: null } });
        await tx.invitation.update({ where: { id: invitationId }, data: { updatedAt: new Date() } });
      });
      await addLog(prisma, { action: "image.delete", actor: session.admin.email, ok: true, detail: mediaId });
      logInfo("MEDIA", "detached", { invitationId, mediaId });
      await publisher.releaseMedia([mediaId], session.admin.email);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admin/storage/cleanup", requireAdmin, async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertSuperAdmin(session);
      const body = cleanupSchema.parse(req.body || {});
      const report = await runCleanup({ repo, storage, prisma, apply: body.apply === true, graceHours: config.cleanupGraceHours, actor: session.admin.email });
      res.json(report);
    } catch (error) {
      next(error);
    }
  });

  app.use("/api/admins", requireAdmin);

  app.get("/api/admins", async (_req, res, next) => {
    try {
      assertSuperAdmin(res.locals.session as StudioSession);
      const rows = await prisma.admin.findMany({ orderBy: { email: "asc" }, select: { id: true } });
      res.json({ admins: await Promise.all(rows.map((row) => presentAccount(row.id))) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/admins", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertSuperAdmin(session);
      const body = createCustomerSchema.parse(req.body);
      const email = familyLoginEmail(body.email);
      if (!email) throw new HttpError(400, "Enter a login name.");
      const problems = passwordProblems(body.password);
      if (problems.length) throw new HttpError(400, problems[0], problems);
      if (await prisma.admin.findUnique({ where: { email }, select: { id: true } })) {
        throw new HttpError(409, "That email already has a login.");
      }
      const invitationIds = await knownInvitationIds(body.invitationIds || []);
      const { hash, argon2id } = await import("argon2");
      const passwordHash = await hash(body.password, { type: argon2id });
      const admin = await prisma.admin
        .create({
          data: { email, passwordHash, role: "customer", access: { create: invitationIds.map((invitationId) => ({ invitationId })) } },
        })
        .catch((error) => {
          logError("DB", "user_created_failed", safeError(error));
          throw error;
        });
      await addLog(prisma, { action: "admin.create", actor: session.admin.email, ok: true, detail: email });
      logInfo("DB", "user_created", { userId: admin.id, role: admin.role });
      res.status(201).json(await presentAccount(admin.id));
    } catch (error) {
      next(error);
    }
  });

  app.put("/api/admins/:id/access", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertSuperAdmin(session);
      const body = accessSchema.parse(req.body);
      const admin = await prisma.admin.findUnique({ where: { id: req.params.id } });
      if (!admin) throw new HttpError(404, "That login was not found.");
      if (admin.role !== "customer") throw new HttpError(400, "Studio logins already open every invitation.");
      const invitationIds = await knownInvitationIds(body.invitationIds);
      await prisma.$transaction([
        prisma.invitationAccess.deleteMany({ where: { adminId: admin.id } }),
        prisma.invitationAccess.createMany({ data: invitationIds.map((invitationId) => ({ adminId: admin.id, invitationId })) }),
      ]);
      await addLog(prisma, { action: "admin.access", actor: session.admin.email, ok: true, detail: `${admin.email} ${invitationIds.length}` });
      res.json(await presentAccount(admin.id));
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/admins/:id", async (req, res, next) => {
    try {
      const session = res.locals.session as StudioSession;
      assertSuperAdmin(session);
      const admin = await prisma.admin.findUnique({ where: { id: req.params.id } });
      if (!admin) throw new HttpError(404, "That login was not found.");
      if (admin.role === "super_admin") throw new HttpError(403, "A studio login cannot be removed here.");
      await prisma.admin.delete({ where: { id: admin.id } });
      await addLog(prisma, { action: "admin.delete", actor: session.admin.email, ok: true, detail: admin.email });
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use(async (error: unknown, req: Request, res: Response, _next: NextFunction) => {
    const message = error instanceof Error ? error.message : "Something went wrong";
    if (!(error instanceof HttpError && error.status === 401)) {
      await addLog(prisma, {
        action: "request.error",
        actor: (res.locals.session as StudioSession | undefined)?.admin.email || "anonymous",
        ok: false,
        detail: `${req.method} ${req.path}: ${message}`,
      }).catch(() => undefined);
    }
    if (error instanceof multer.MulterError) {
      logWarn("MEDIA", "validation_failed", { reason: "file_too_large", requestId: res.locals.requestId });
      return res.status(400).json({ error: "Photographs must be 8 MB or smaller." });
    }
    if (error instanceof ZodError) {
      return res.status(400).json({ error: "Check the highlighted fields.", details: error.issues.map((issue) => issue.message) });
    }
    if (error instanceof HttpError || error instanceof PublishError) {
      return res.status(error.status).json({ error: error.message, details: error.details });
    }
    if ((error as { status?: number }).status === 404 && req.path.startsWith("/dev-public")) {
      return res.status(404).json({ error: "Not found" });
    }
    logError("HTTP", "unhandled", {
      requestId: res.locals.requestId,
      method: req.method,
      path: req.path,
      ...safeError(error),
    });
    return res.status(500).json({ error: "Something went wrong" });
  });

  return app;
}
