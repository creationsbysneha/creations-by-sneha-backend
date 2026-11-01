import { z } from "zod";
import { presentContent, type InvitationGraph } from "./present.js";
import { SLUG_PATTERN } from "./security.js";
import { TEMPLATES } from "./validate.js";

export const SNAPSHOT_SCHEMA_VERSION = 1;
export const SNAPSHOT_KIND = "creations-by-sneha.invitation";

const absoluteUrl = z
  .string()
  .url()
  .refine((value) => /^https?:\/\//.test(value), "Image URLs must be absolute")
  .refine((value) => !/[?&](X-Amz-|Signature=|Expires=)/i.test(value), "Image URLs must not be signed or expiring");

const text = z.string().max(2000);

const contentSchema = z
  .object({
    badge: z.literal(""),
    title: text,
    description: text,
    blessing: text,
    rsvpMode: z.enum(["local-demo", "disabled"]),
    albumMode: z.enum(["sample", "disabled"]),
    theme: z
      .object({
        accent: z.enum(["gold", "rose", "olive"]),
        paper: z.enum(["cream", "ivory", "blush"]),
        script: z.enum(["great-vibes", "parisienne", "playfair"]),
      })
      .strict(),
    couple: z
      .object({
        brideFirst: text,
        brideRest: text,
        brideName: text,
        brideFull: text,
        brideParents: text,
        brideGrandparents: text,
        groomFirst: text,
        groomRest: text,
        groomName: text,
        groomFull: text,
        groomParents: text,
        groomGrandparents: text,
        pair: text,
        monogram: text,
        families: text,
        compliments: z.array(text).max(4),
        rsvpFamily: text,
        cousinsLabel: text,
        cousins: text,
      })
      .strict(),
    date: z
      .object({ iso: text, day: text, suffix: text, monthYear: text, weekday: text, footer: text })
      .strict(),
    venue: z
      .object({ name: text, addressLine1: text, addressLine2: text, note: text, mapEmbed: text, directionsUrl: text })
      .strict(),
    images: z
      .object({ envelope: absoluteUrl, hero: absoluteUrl, venue: absoluteUrl, og: absoluteUrl, fallback: absoluteUrl })
      .strict(),
    gallery: z.array(z.object({ src: absoluteUrl, alt: text }).strict()).max(24),
    ceremonies: z
      .array(
        z
          .object({
            roman: text,
            title: text,
            subtitle: text,
            date: text,
            venue: text,
            description: text.optional(),
            icon: text,
            image: absoluteUrl,
            imageAlt: text,
            events: z
              .array(z.object({ time: text, label: text.optional(), dressCode: text.optional() }).strict())
              .max(8),
          })
          .strict(),
      )
      .max(12),
    guessOptions: z.array(z.object({ id: z.string().max(8), label: z.string().max(40) }).strict()).max(6),
    intro: z.object({ opening: text, request: text, occasion: text, closing: text }).strict().optional(),
  })
  .strict();

export const snapshotSchema = z
  .object({
    schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
    kind: z.literal(SNAPSHOT_KIND),
    slug: z.string().regex(SLUG_PATTERN).max(120),
    template: z.enum(TEMPLATES),
    version: z.number().int().positive(),
    publishedAt: z.string().datetime(),
    generatedAt: z.string().datetime(),
    expiresAt: z.string().datetime().optional(),
    seo: z.object({ title: text, description: text, image: absoluteUrl, noindex: z.literal(true) }).strict(),
    content: contentSchema,
    assets: z
      .array(
        z
          .object({ mediaId: z.string().uuid(), url: absoluteUrl, width: z.number().int().nonnegative(), height: z.number().int().nonnegative() })
          .strict(),
      )
      .max(64),
  })
  .strict();

export type PublishedSnapshot = z.infer<typeof snapshotSchema>;

export type PublishedAsset = { mediaId: string; key: string; url: string; width: number; height: number };

export function buildSnapshot(
  graph: InvitationGraph,
  options: { version: number; publishedAt: Date; assets: Map<string, PublishedAsset>; fallbackImage: string },
): PublishedSnapshot {
  const image = (mediaId: string | null | undefined) => (mediaId ? options.assets.get(mediaId)?.url || "" : "");
  const content = presentContent(graph, { badge: "", image, fallback: options.fallbackImage });
  const { gallery, ceremonies, ...rest } = content;
  const iso = options.publishedAt.toISOString();

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    kind: SNAPSHOT_KIND,
    slug: graph.slug,
    template: graph.template === "royal-wedding" ? ("royal-wedding" as const) : ("classic-envelope" as const),
    version: options.version,
    publishedAt: iso,
    generatedAt: iso,
    ...(graph.expiresAt ? { expiresAt: graph.expiresAt.toISOString() } : {}),
    seo: {
      title: content.couple.pair || content.title,
      description: content.description,
      image: content.images.og,
      noindex: true as const,
    },
    content: {
      ...rest,
      gallery: gallery.map(({ src, alt }) => ({ src, alt })),
      ceremonies: ceremonies.map(({ mediaId: _mediaId, ...ceremony }) => ({
        ...ceremony,
        events: ceremony.events.map((event) => ({
          time: event.time,
          ...(event.label ? { label: event.label } : {}),
          ...(event.dressCode ? { dressCode: event.dressCode } : {}),
        })),
      })),
    },
    assets: [...options.assets.values()].map(({ mediaId, url, width, height }) => ({ mediaId, url, width, height })),
  };
  return snapshotSchema.parse(snapshot);
}
