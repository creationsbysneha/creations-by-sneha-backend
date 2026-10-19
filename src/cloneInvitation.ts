import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { CACHE, privateMediaKey } from "./keys.js";
import { referencedMediaIds, type InvitationGraph } from "./store.js";
import type { ObjectStorage } from "./storage.js";
import type { themeSchema } from "./validate.js";
import type { z } from "zod";

type Theme = z.infer<typeof themeSchema>;

export async function cloneInvitation(
  prisma: PrismaClient,
  storage: ObjectStorage,
  source: InvitationGraph,
  options: { slug: string; isDemo: boolean; theme?: Theme },
) {
  const mediaIds = referencedMediaIds(source);
  const copied = new Map<string, string>();

  for (const mediaId of mediaIds) {
    const media = await prisma.media.findUnique({ where: { id: mediaId } });
    if (!media || media.status !== "ready") continue;
    const bytes = await storage.private.get(media.storageKey);
    if (!bytes) continue;
    const id = randomUUID();
    const storageKey = privateMediaKey(id);
    await storage.private.put(storageKey, bytes, { contentType: media.mimeType, cacheControl: CACHE.privateMedia });
    await prisma.media.create({
      data: {
        id,
        storageKey,
        mimeType: media.mimeType,
        width: media.width,
        height: media.height,
        byteSize: media.byteSize,
        status: "ready",
        purpose: media.purpose,
        checksum: media.checksum,
      },
    });
    copied.set(mediaId, id);
  }

  const created = await prisma.invitation.create({
    data: {
      slug: options.slug,
      title: source.title,
      template: source.template,
      status: "draft",
      description: source.description,
      brideName: source.brideName,
      brideFull: source.brideFull,
      brideParents: source.brideParents,
      brideGrandparents: source.brideGrandparents,
      groomName: source.groomName,
      groomFull: source.groomFull,
      groomParents: source.groomParents,
      groomGrandparents: source.groomGrandparents,
      families: source.families,
      blessing: source.blessing,
      complimentOne: source.complimentOne,
      complimentTwo: source.complimentTwo,
      rsvpFamily: source.rsvpFamily,
      cousinsLabel: source.cousinsLabel,
      cousins: source.cousins,
      weddingAt: source.weddingAt,
      expiresAt: source.expiresAt,
      venueName: source.venueName,
      venueAddress1: source.venueAddress1,
      venueAddress2: source.venueAddress2,
      venueNote: source.venueNote,
      mapEmbed: source.mapEmbed,
      directionsUrl: source.directionsUrl,
      rsvpMode: source.rsvpMode,
      isDemo: options.isDemo,
      theme: options.theme || source.theme || { accent: "gold", paper: "cream", script: "great-vibes" },
      guessOptions: source.guessOptions as object,
    },
  });

  await prisma.media.updateMany({
    where: { id: { in: [...copied.values()] } },
    data: { ownerInvitationId: created.id },
  });

  for (const link of source.mediaLinks) {
    const mediaId = copied.get(link.mediaId);
    if (!mediaId) continue;
    await prisma.invitationMedia.create({
      data: { invitationId: created.id, mediaId, role: link.role, sortOrder: link.sortOrder, alt: link.alt },
    });
  }

  for (const event of source.events) {
    await prisma.ceremonyEvent.create({
      data: {
        invitationId: created.id,
        sortOrder: event.sortOrder,
        title: event.title,
        subtitle: event.subtitle,
        dateLabel: event.dateLabel,
        venue: event.venue,
        description: event.description,
        imageAlt: event.imageAlt,
        details: event.details as object,
        mediaId: event.mediaId ? copied.get(event.mediaId) || null : null,
      },
    });
  }

  return created;
}
