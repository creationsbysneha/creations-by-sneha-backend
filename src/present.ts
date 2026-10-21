import { formatWeddingDate, romanFor, splitName, toExpiryInput, toWeddingInput } from "./security.js";
import { hasUnpublishedChanges, type InvitationGraph } from "./store.js";

export type { InvitationGraph };

export type ImageResolver = (mediaId: string | null | undefined) => string;

export const draftImage: ImageResolver = (id) => (id ? `/api/media/${id}` : "");

function linkFor(invitation: InvitationGraph, role: string) {
  return invitation.mediaLinks.find((link) => link.role === role) || null;
}

type Theme = {
  accent: "gold" | "rose" | "olive";
  paper: "cream" | "ivory" | "blush";
  script: "great-vibes" | "parisienne" | "playfair";
};

export function presentContent(invitation: InvitationGraph, options: { badge: string; image: ImageResolver; fallback: string }) {
  const image = options.image;
  const bride = splitName(invitation.brideName);
  const groom = splitName(invitation.groomName);
  const hero = linkFor(invitation, "hero");
  const envelope = linkFor(invitation, "envelope");
  const venueImage = linkFor(invitation, "venue");
  const fallback = options.fallback;
  const theme = (invitation.theme || { accent: "gold", paper: "cream", script: "great-vibes" }) as Theme;
  const guessOptions = Array.isArray(invitation.guessOptions) ? (invitation.guessOptions as Array<{ id: string; label: string }>) : [];

  return {
    badge: options.badge,
    title: invitation.title,
    description: invitation.description,
    blessing: invitation.blessing,
    rsvpMode: invitation.rsvpMode as "local-demo" | "disabled",
    theme,
    couple: {
      brideFirst: bride.first,
      brideRest: bride.rest,
      brideName: invitation.brideName,
      brideFull: invitation.brideFull || invitation.brideName,
      brideParents: invitation.brideParents,
      brideGrandparents: invitation.brideGrandparents,
      groomFirst: groom.first,
      groomRest: groom.rest,
      groomName: invitation.groomName,
      groomFull: invitation.groomFull || invitation.groomName,
      groomParents: invitation.groomParents,
      groomGrandparents: invitation.groomGrandparents,
      pair: [invitation.brideName, invitation.groomName].filter(Boolean).join(" & "),
      monogram: [bride.first, groom.first].filter(Boolean).join(" & "),
      families: invitation.families,
      compliments: [invitation.complimentOne, invitation.complimentTwo],
      rsvpFamily: invitation.rsvpFamily,
      cousinsLabel: invitation.cousinsLabel,
      cousins: invitation.cousins,
    },
    date: formatWeddingDate(invitation.weddingAt, invitation.venueName),
    venue: {
      name: invitation.venueName,
      addressLine1: invitation.venueAddress1,
      addressLine2: invitation.venueAddress2,
      note: invitation.venueNote,
      mapEmbed: invitation.mapEmbed,
      directionsUrl: invitation.directionsUrl,
    },
    images: {
      envelope: image(envelope?.mediaId) || fallback,
      hero: image(hero?.mediaId) || fallback,
      venue: image(venueImage?.mediaId) || fallback,
      og: image(hero?.mediaId) || fallback,
      fallback,
    },
    gallery: invitation.mediaLinks
      .filter((link) => link.role === "gallery")
      .map((link) => ({ src: image(link.mediaId), alt: link.alt, mediaId: link.mediaId as string | null })),
    ceremonies: invitation.events.map((event, index) => ({
      roman: romanFor(index),
      title: event.title,
      subtitle: event.subtitle,
      date: event.dateLabel,
      venue: event.venue,
      description: event.description || undefined,
      icon: "",
      image: image(event.mediaId) || fallback,
      imageAlt: event.imageAlt || event.title,
      mediaId: event.mediaId,
      events: (Array.isArray(event.details) ? event.details : []) as Array<{ time: string; label?: string; dressCode?: string }>,
    })),
    guessOptions,
  };
}

export type PresentedContent = ReturnType<typeof presentContent>;

export function presentInvitation(invitation: InvitationGraph, options: { badge: string }) {
  const hero = linkFor(invitation, "hero");
  const envelope = linkFor(invitation, "envelope");
  const venueImage = linkFor(invitation, "venue");
  const theme = (invitation.theme || { accent: "gold", paper: "cream", script: "great-vibes" }) as Theme;
  const guessOptions = Array.isArray(invitation.guessOptions) ? invitation.guessOptions : [];
  const content = presentContent(invitation, { badge: options.badge, image: draftImage, fallback: "/demo/fallback.jpg" });

  const form = {
    title: invitation.title,
    slug: invitation.slug,
    description: invitation.description,
    brideName: invitation.brideName,
    brideFull: invitation.brideFull,
    brideParents: invitation.brideParents,
    brideGrandparents: invitation.brideGrandparents,
    groomName: invitation.groomName,
    groomFull: invitation.groomFull,
    groomParents: invitation.groomParents,
    groomGrandparents: invitation.groomGrandparents,
    families: invitation.families,
    blessing: invitation.blessing,
    complimentOne: invitation.complimentOne,
    complimentTwo: invitation.complimentTwo,
    rsvpFamily: invitation.rsvpFamily,
    cousinsLabel: invitation.cousinsLabel,
    cousins: invitation.cousins,
    weddingAt: toWeddingInput(invitation.weddingAt),
    expiresAt: toExpiryInput(invitation.expiresAt),
    venueName: invitation.venueName,
    venueAddress1: invitation.venueAddress1,
    venueAddress2: invitation.venueAddress2,
    venueNote: invitation.venueNote,
    mapEmbed: invitation.mapEmbed,
    directionsUrl: invitation.directionsUrl,
    rsvpMode: invitation.rsvpMode,
    theme,
    guessOptions,
    ceremonies: invitation.events.map((event) => ({
      title: event.title,
      subtitle: event.subtitle,
      date: event.dateLabel,
      venue: event.venue,
      description: event.description,
      imageAlt: event.imageAlt,
      mediaId: event.mediaId,
      imageUrl: draftImage(event.mediaId),
      events: Array.isArray(event.details) && event.details.length ? event.details : [{ time: "", label: "", dressCode: "" }],
    })),
    gallery: invitation.mediaLinks
      .filter((link) => link.role === "gallery")
      .map((link) => ({ mediaId: link.mediaId, alt: link.alt, url: draftImage(link.mediaId) })),
    heroMediaId: hero?.mediaId || null,
    heroUrl: draftImage(hero?.mediaId),
    envelopeMediaId: envelope?.mediaId || null,
    envelopeUrl: draftImage(envelope?.mediaId),
    venueMediaId: venueImage?.mediaId || null,
    venueUrl: draftImage(venueImage?.mediaId),
  };

  return {
    id: invitation.id,
    status: invitation.status,
    isDemo: invitation.isDemo,
    updatedAt: invitation.updatedAt.toISOString(),
    publishedAt: invitation.publishedAt?.toISOString() || null,
    expiresAt: invitation.expiresAt?.toISOString() || null,
    publication: {
      version: invitation.publishedVersion,
      slug: invitation.publishedSlug,
      hasUnpublishedChanges: hasUnpublishedChanges(invitation),
    },
    form,
    content,
  };
}
