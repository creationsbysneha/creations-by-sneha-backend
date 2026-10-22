import { z } from "zod";
import { SLUG_PATTERN } from "./security.js";

export const themeSchema = z.object({
  accent: z.enum(["gold", "rose", "olive"]),
  paper: z.enum(["cream", "ivory", "blush"]),
  script: z.enum(["great-vibes", "parisienne", "playfair"]),
});

const detailSchema = z.object({
  time: z.string().max(80).default(""),
  label: z.string().max(80).optional(),
  dressCode: z.string().max(80).optional(),
});

export const ceremonySchema = z.object({
  title: z.string().max(120).default(""),
  subtitle: z.string().max(160).optional(),
  date: z.string().max(80).optional(),
  venue: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  imageAlt: z.string().max(180).optional(),
  mediaId: z.string().uuid().nullable().optional(),
  events: z.array(detailSchema).max(8).optional(),
});

export const updateSchema = z
  .object({
    title: z.string().max(140).optional(),
    slug: z.string().regex(SLUG_PATTERN, "Use lowercase letters, numbers, and hyphens.").optional(),
    description: z.string().max(300).optional(),
    brideName: z.string().max(80).optional(),
    brideFull: z.string().max(120).optional(),
    brideParents: z.string().max(180).optional(),
    brideGrandparents: z.string().max(180).optional(),
    groomName: z.string().max(80).optional(),
    groomFull: z.string().max(120).optional(),
    groomParents: z.string().max(180).optional(),
    groomGrandparents: z.string().max(180).optional(),
    families: z.string().max(180).optional(),
    blessing: z.string().max(400).optional(),
    complimentOne: z.string().max(120).optional(),
    complimentTwo: z.string().max(120).optional(),
    rsvpFamily: z.string().max(120).optional(),
    cousinsLabel: z.string().max(120).optional(),
    cousins: z.string().max(240).optional(),
    weddingAt: z.string().max(40).optional(),
    expiresAt: z.string().max(40).optional(),
    venueName: z.string().max(140).optional(),
    venueAddress1: z.string().max(160).optional(),
    venueAddress2: z.string().max(160).optional(),
    venueNote: z.string().max(240).optional(),
    mapEmbed: z.string().max(500).optional(),
    directionsUrl: z.string().max(500).optional(),
    rsvpMode: z.enum(["local-demo", "disabled"]).optional(),
    albumMode: z.enum(["sample", "disabled"]).optional(),
    isDemo: z.boolean().optional(),
    theme: themeSchema.optional(),
    guessOptions: z.array(z.object({ id: z.string().max(8), label: z.string().max(40) })).max(6).optional(),
    ceremonies: z.array(ceremonySchema).max(12).optional(),
    gallery: z.array(z.object({ mediaId: z.string().uuid(), alt: z.string().max(180).optional() })).max(24).optional(),
    heroMediaId: z.string().uuid().nullable().optional(),
    envelopeMediaId: z.string().uuid().nullable().optional(),
    venueMediaId: z.string().uuid().nullable().optional(),
  });

export const loginSchema = z.object({
  email: z.string().email().max(180),
  password: z.string().min(1).max(200),
});

export const createCustomerSchema = z.object({
  email: z.string().min(1).max(180),
  password: z.string().min(1).max(200),
  invitationIds: z.array(z.string().uuid()).max(50).optional(),
});

export const accessSchema = z.object({
  invitationIds: z.array(z.string().uuid()).max(50),
});

export const cleanupSchema = z.object({
  apply: z.boolean().optional(),
});

export const defaultTheme = { accent: "gold", paper: "cream", script: "great-vibes" } as const;

export const createInvitationSchema = z.object({
  isDemo: z.boolean().optional(),
  cloneId: z.string().uuid().optional(),
  slug: z.string().regex(SLUG_PATTERN, "Use lowercase letters, numbers, and hyphens.").max(80).optional(),
  theme: themeSchema.optional(),
});
