import type { Prisma, PrismaClient } from "@prisma/client";

export type AccountRole = "super_admin" | "customer";

export type MediaInfo = {
  id: string;
  storageKey: string;
  mimeType: string;
  width: number;
  height: number;
  byteSize: number;
  status: string;
  ownerInvitationId: string | null;
  purpose: string;
  checksum: string | null;
  createdAt: Date;
};

export type InvitationFields = {
  id: string;
  slug: string;
  title: string;
  template: string;
  status: string;
  description: string;
  brideName: string;
  brideFull: string;
  brideParents: string;
  brideGrandparents: string;
  groomName: string;
  groomFull: string;
  groomParents: string;
  groomGrandparents: string;
  families: string;
  blessing: string;
  complimentOne: string;
  complimentTwo: string;
  rsvpFamily: string;
  cousinsLabel: string;
  cousins: string;
  weddingAt: Date | null;
  expiresAt: Date | null;
  venueName: string;
  venueAddress1: string;
  venueAddress2: string;
  venueNote: string;
  mapEmbed: string;
  directionsUrl: string;
  rsvpMode: string;
  albumMode: string;
  isDemo: boolean;
  theme: unknown;
  guessOptions: unknown;
  createdAt: Date;
  updatedAt: Date;
  publishedAt: Date | null;
  publishedVersion: number;
  publishedSlug: string | null;
  publishedKey: string | null;
};

export type InvitationGraph = InvitationFields & {
  events: Array<{
    id: string;
    invitationId: string;
    sortOrder: number;
    title: string;
    subtitle: string;
    dateLabel: string;
    venue: string;
    description: string;
    imageAlt: string;
    details: unknown;
    mediaId: string | null;
    media: MediaInfo | null;
  }>;
  mediaLinks: Array<{
    id: string;
    invitationId: string;
    mediaId: string;
    role: string;
    sortOrder: number;
    alt: string;
    media: MediaInfo;
  }>;
};

export type Db = PrismaClient | Prisma.TransactionClient;

export const graphInclude = {
  events: { orderBy: { sortOrder: "asc" }, include: { media: true } },
  mediaLinks: { orderBy: { sortOrder: "asc" }, include: { media: true } },
} satisfies Prisma.InvitationInclude;

export async function loadGraph(db: Db, id: string): Promise<InvitationGraph | null> {
  return db.invitation.findUnique({ where: { id }, include: graphInclude });
}

export function referencedMediaIds(graph: Pick<InvitationGraph, "events" | "mediaLinks">) {
  return [
    ...new Set([
      ...graph.mediaLinks.map((link) => link.mediaId),
      ...graph.events.flatMap((event) => (event.mediaId ? [event.mediaId] : [])),
    ]),
  ];
}

export function hasUnpublishedChanges(invitation: Pick<InvitationFields, "status" | "updatedAt" | "publishedAt">) {
  if (invitation.status !== "published" || !invitation.publishedAt) return false;
  return invitation.updatedAt.getTime() > invitation.publishedAt.getTime();
}

export type LogEntry = { action: string; actor: string; ok: boolean; detail: string };

export async function addLog(db: Db, entry: LogEntry) {
  await db.auditLog.create({ data: { ...entry, detail: entry.detail.slice(0, 1000) } });
}
