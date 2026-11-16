import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { cloneInvitation } from "./cloneInvitation.js";
import { config, fallbackImageUrl } from "./config.js";
import { prisma } from "./db.js";
import { CACHE, privateMediaKey } from "./keys.js";
import { createPublisher, sha256 } from "./publishing.js";
import { cloudflarePurger } from "./purge.js";
import { createPrismaRepo } from "./repo.js";
import { LEGACY_SAMPLE_SLUG, parseWeddingAt, SAMPLE_SLUG, SHUBH_DEMO_SLUG } from "./security.js";
import { loadGraph } from "./store.js";
import { createStorage } from "./storage.js";

/*
 * Creates (or refreshes) the Shubh Aarambh demo at /demo-shubh and publishes it.
 * It gives it its own fictional couple, places and ceremonies, and only its own photographs from fixtures/shubh-demo
 * (made by creations-by-sneha-frontend/scripts/build_shubh_assets.py).
 * Run once after the migration: npm run demo:shubh
 */

const DETAILS = {
  title: "Karan & Siya | Shubh Aarambh Sample Invitation",
  description: "A sample Shubh Aarambh invitation for Karan and Siya. Names, dates, and the venue are illustrative.",
  nameOrder: "groom-first",
  groomName: "Karan",
  groomFull: "Karan Mehra",
  groomParents: "Son of Smt. Kavita & Shri Rajesh Mehra",
  groomGrandparents: "Grandson of Smt. Shanti & Shri Om Prakash Mehra",
  groomBio: "An architect who sketches every city he visits, and the one who planned the proposal for a year.",
  brideName: "Siya",
  brideFull: "Siya Bansal",
  brideParents: "Daughter of Smt. Neelam & Shri Anil Bansal",
  brideGrandparents: "Granddaughter of Smt. Usha & Shri Ram Kumar Bansal",
  brideBio: "A Kathak dancer with a weakness for chai at dusk, and the one who said yes before he finished asking.",
  families: "The Mehra & Bansal families",
  blessing: "With the blessings of our elders",
  invocation: "॥ श्री गणेशाय नमः ॥",
  introOpening: "With the blessings of our elders",
  introRequest: "joyfully invite you to the wedding of",
  introOccasion: "and seek your presence and blessings",
  introClosing: "Your presence will make our celebration complete",
  complimentOne: "Smt. Kavita Mehra",
  complimentTwo: "Shri Rajesh Mehra",
  rsvpFamily: "Mehra Family",
  rsvpPhone: "",
  cousinsLabel: "The Mehra cousins",
  cousins: "Aarav, Diya, Kabeer & Myra Mehra",
  weddingAt: "2027-12-11T19:00",
  venueName: "The Lotus Palace",
  venueAddress1: "Amer Road",
  venueAddress2: "Jaipur",
  venueNote: "Illustrative venue for this sample invitation",
  mapEmbed: "https://www.google.com/maps?output=embed&q=Jal%20Mahal%2C%20Jaipur%2C%20Rajasthan",
  directionsUrl: "https://www.google.com/maps/search/?api=1&query=Jal%20Mahal%20Jaipur",
};

// One per photograph in fixtures/shubh-demo (ceremony-01 … ceremony-06), in this order.
const CEREMONIES = [
  {
    title: "Haldi",
    subtitle: "Turmeric, marigolds and laughter, a golden morning to bless the couple.",
    dateLabel: "Wednesday, 8th December 2027",
    venue: "The Lotus Palace courtyard, Jaipur",
    imageAlt: "The couple in yellow at their haldi, surrounded by marigolds",
    details: [{ time: "11:00 AM onwards", dressCode: "Shades of yellow" }],
  },
  {
    title: "Mehndi",
    subtitle: "Intricate henna, jasmine strands and songs under the evening trees.",
    dateLabel: "Thursday, 9th December 2027",
    venue: "The Lotus Palace gardens, Jaipur",
    imageAlt: "The bride showing her henna beside the groom, jasmine in her hair",
    details: [{ time: "4:00 PM onwards", dressCode: "Greens and florals" }],
  },
  {
    title: "Sangeet",
    subtitle: "A night of music, dance and the family's best performances.",
    dateLabel: "Friday, 10th December 2027",
    venue: "The Lotus Palace lawns, Jaipur",
    imageAlt: "The couple dancing at their sangeet under evening lights",
    details: [{ time: "7:00 PM onwards", dressCode: "Indo-western" }],
  },
  {
    title: "Shubh Vivah",
    subtitle: "Seven vows around the sacred fire, under a canopy of flowers.",
    dateLabel: "Saturday, 11th December 2027",
    venue: "The Lotus Palace, Durbar Hall, Jaipur",
    imageAlt: "The bride in red and the groom in ivory seated at the mandap",
    details: [
      { label: "Baraat", time: "6:30 PM onwards" },
      { label: "Pheras", time: "8:00 PM", dressCode: "Traditional wear" },
    ],
  },
  {
    title: "Reception",
    subtitle: "An evening of dinner and blessings as we begin our life together.",
    dateLabel: "Sunday, 12th December 2027",
    venue: "The Lotus Palace, Mirror Hall, Jaipur",
    imageAlt: "The couple in a navy bandhgala and a pale blue saree beneath floral arches",
    details: [{ time: "7:30 PM onwards", dressCode: "Evening formal" }],
  },
  {
    title: "Griha Pravesh",
    subtitle: "Welcoming the bride home with rice, roses and an open door.",
    dateLabel: "Monday, 13th December 2027",
    venue: "The Mehra residence, Jaipur",
    imageAlt: "The couple arm in arm in ivory and pink among roses",
    details: [{ time: "11:00 AM" }],
  },
];

// The Moments stack, top to bottom: fixtures/shubh-demo/moment-01 … moment-06.
const MOMENTS = [
  "The couple in a palace courtyard on their wedding day",
  "The bride in her wedding jewellery",
  "The couple side by side in wedding attire",
  "The couple in gold, smiling at each other",
  "The couple strolling through the palace in wedding attire",
  "The couple together under warm palace light",
];

const existing = await prisma.invitation.findFirst({ where: { OR: [{ slug: SHUBH_DEMO_SLUG }, { publishedSlug: SHUBH_DEMO_SLUG }] } });
if (existing && !existing.isDemo) {
  console.error(`The link /${SHUBH_DEMO_SLUG} already belongs to a customer invitation. Nothing was changed.`);
  process.exit(1);
}

let id = existing?.id;
if (!id) {
  const sourceRow =
    (await prisma.invitation.findFirst({ where: { slug: SAMPLE_SLUG } })) ||
    (await prisma.invitation.findFirst({ where: { slug: LEGACY_SAMPLE_SLUG } })) ||
    (await prisma.invitation.findFirst({ where: { isDemo: true }, orderBy: { createdAt: "asc" } }));
  const source = sourceRow ? await loadGraph(prisma, sourceRow.id) : null;
  if (!source) {
    console.error("No sample invitation to copy photographs from. Publish the sample first.");
    process.exit(1);
  }
  const cloned = await cloneInvitation(prisma, createStorage(), source, { slug: SHUBH_DEMO_SLUG, isDemo: true, template: "shubh-aarambh" });
  id = cloned.id;
  console.log(`created /${SHUBH_DEMO_SLUG}`);
} else {
  console.log(`refreshing /${SHUBH_DEMO_SLUG}`);
}

const { weddingAt, ...text } = DETAILS;
await prisma.invitation.update({
  where: { id },
  data: {
    ...text,
    template: "shubh-aarambh",
    isDemo: true,
    rsvpMode: "disabled",
    weddingAt: parseWeddingAt(weddingAt),
    guessOptions: [
      { id: "K", label: "Karan" },
      { id: "S", label: "Siya" },
      { id: "B", label: "Both" },
    ],
  },
});

// The demo's own photographs, made the same way an upload in the studio is (see POST /api/invitations/:id/images),
// but smaller: they show at most about 360 px wide, so 1000 px covers a 3x phone screen. The source files are only
// needed to put new photographs on the demo: make them with
//   python3 ../creations-by-sneha-frontend/scripts/build_shubh_assets.py ~/Downloads
// When a file is not there, the photograph already stored for that place is kept as it is.
const storage = createStorage();
const invitationId: string = id;
const fixtures = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../fixtures/shubh-demo");

async function photo(file: string, purpose: "ceremony" | "gallery" | "bride" | "groom", current: string | null | undefined) {
  const source = await readFile(path.join(fixtures, file)).catch(() => null);
  if (!source) {
    if (current) return current;
    console.error(`fixtures/shubh-demo/${file} is missing and the demo has no photograph there yet. Build the fixtures first.`);
    process.exit(1);
  }
  const output = await sharp(source)
    .rotate()
    .resize({ width: 1000, height: 1000, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 78 })
    .toBuffer();
  const checksum = sha256(output);
  const known = await prisma.media.findFirst({ where: { ownerInvitationId: invitationId, checksum, status: "ready" } });
  if (known) return known.id;
  const info = await sharp(output).metadata();
  const mediaId = randomUUID();
  const storageKey = privateMediaKey(mediaId);
  await storage.private.put(storageKey, output, { contentType: "image/webp", cacheControl: CACHE.privateMedia });
  await prisma.media.create({
    data: {
      id: mediaId,
      storageKey,
      mimeType: "image/webp",
      width: info.width || 0,
      height: info.height || 0,
      byteSize: output.length,
      status: "ready",
      ownerInvitationId: invitationId,
      purpose,
      checksum,
    },
  });
  return mediaId;
}

const replaced: string[] = [];

// Exactly one event per ceremony, each with its photograph.
let events = await prisma.ceremonyEvent.findMany({ where: { invitationId: id }, orderBy: { sortOrder: "asc" } });
for (const extra of events.slice(CEREMONIES.length)) {
  if (extra.mediaId) replaced.push(extra.mediaId);
  await prisma.ceremonyEvent.delete({ where: { id: extra.id } });
}
events = events.slice(0, CEREMONIES.length);
for (const [index, ceremony] of CEREMONIES.entries()) {
  const event = events[index];
  const mediaId = await photo(`ceremony-${String(index + 1).padStart(2, "0")}.webp`, "ceremony", event?.mediaId);
  if (event) {
    if (event.mediaId && event.mediaId !== mediaId) replaced.push(event.mediaId);
    await prisma.ceremonyEvent.update({ where: { id: event.id }, data: { ...ceremony, sortOrder: index, mediaId } });
  } else {
    await prisma.ceremonyEvent.create({ data: { ...ceremony, invitationId: id, sortOrder: index, mediaId } });
  }
}

// The demo shows only its own photographs: the six Moments, the bride and the groom. Every other photograph the
// sample brought with it (hero, envelope, venue, the old gallery) is taken off.
const links = await prisma.invitationMedia.findMany({ where: { invitationId: id }, orderBy: { sortOrder: "asc" } });
const stored = (role: string) => links.filter((link) => link.role === role).map((link) => link.mediaId);
const momentIds: string[] = [];
for (const [index] of MOMENTS.entries()) momentIds.push(await photo(`moment-${String(index + 1).padStart(2, "0")}.webp`, "gallery", stored("gallery")[index]));
const brideId = await photo("bride.webp", "bride", stored("bride")[0]);
const groomId = await photo("groom.webp", "groom", stored("groom")[0]);
const keep = new Set([...momentIds, brideId, groomId]);
await prisma.invitationMedia.deleteMany({ where: { invitationId: id } });
await prisma.invitationMedia.createMany({
  data: [
    ...MOMENTS.map((alt, index) => ({ invitationId: id, mediaId: momentIds[index], role: "gallery", sortOrder: index, alt })),
    { invitationId: id, mediaId: brideId, role: "bride", sortOrder: 0, alt: "The bride in a red and gold lehenga" },
    { invitationId: id, mediaId: groomId, role: "groom", sortOrder: 0, alt: "The groom in an embroidered navy sherwani" },
  ],
});
replaced.push(...links.map((link) => link.mediaId).filter((mediaId) => !keep.has(mediaId)));

const publisher = createPublisher({
  repo: createPrismaRepo(prisma),
  storage,
  fallbackImage: fallbackImageUrl,
  purge: cloudflarePurger(config.cloudflareZoneId, config.cloudflareApiToken),
});
await publisher.publish(id, "seed-shubh-demo");
console.log(`published /${SHUBH_DEMO_SLUG}`);
// The sample photographs this demo no longer shows.
const released = await publisher.releaseMedia(replaced, "seed-shubh-demo");
if (released.length) console.log(`released ${released.length} old photographs`);

await prisma.$disconnect();
