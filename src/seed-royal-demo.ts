import "dotenv/config";
import { cloneInvitation } from "./cloneInvitation.js";
import { config, fallbackImageUrl } from "./config.js";
import { prisma } from "./db.js";
import { createPublisher } from "./publishing.js";
import { cloudflarePurger } from "./purge.js";
import { createPrismaRepo } from "./repo.js";
import { LEGACY_SAMPLE_SLUG, parseWeddingAt, ROYAL_DEMO_SLUG, SAMPLE_SLUG } from "./security.js";
import { loadGraph } from "./store.js";
import { createStorage } from "./storage.js";

/*
 * Creates (or refreshes) the Royal Wedding demo at /demo-royal and publishes it.
 * It copies the sample invitation's photographs, then gives it its own fictional couple, places and ceremonies.
 * Run once after the migration: npx tsx src/seed-royal-demo.ts
 */

const DETAILS = {
  title: "Devika & Aryan | Royal Wedding Sample Invitation",
  description: "A sample Royal Wedding invitation for Devika and Aryan. Names, dates, and the venue are illustrative.",
  brideName: "Devika",
  brideFull: "Devika Rathore",
  brideParents: "Daughter of Smt. Gayatri & Shri Mahendra Rathore",
  brideGrandparents: "Granddaughter of Smt. Kamla & Shri Bhanu Pratap Rathore",
  groomName: "Aryan",
  groomFull: "Aryan Singhania",
  groomParents: "Son of Smt. Radhika & Shri Ajay Singhania",
  groomGrandparents: "Grandson of Smt. Vimla & Shri Suresh Singhania",
  families: "The Rathore & Singhania families",
  blessing: "With the blessings of our elders",
  complimentOne: "Smt. Gayatri Rathore",
  complimentTwo: "Shri Mahendra Rathore",
  rsvpFamily: "Rathore Family",
  cousinsLabel: "The Rathore cousins",
  cousins: "Kavya, Ishaan, Tara & Yuvraj Rathore",
  introOpening: "Together with their families",
  introRequest: "request the pleasure of your company",
  introOccasion: "at the celebration of their wedding",
  introClosing: "We cordially invite you to celebrate with us",
  weddingAt: "2027-11-20T19:30",
  venueName: "The Ivory Palace",
  venueAddress1: "Lake Palace Road",
  venueAddress2: "Udaipur",
  venueNote: "Illustrative venue for this sample invitation",
  mapEmbed: "https://www.google.com/maps?output=embed&q=Lake%20Pichola%2C%20Udaipur%2C%20Rajasthan",
  directionsUrl: "https://www.google.com/maps/search/?api=1&query=Lake%20Pichola%20Udaipur",
};

// In the order of the sample's photographs: rituals at home, haldi, rings, an evening party, the wedding, the farewell.
const CEREMONIES = [
  {
    title: "Tilak & Ganesh Puja",
    subtitle: "Blessings to begin the celebrations",
    dateLabel: "Tuesday, 16th November 2027",
    venue: "The Rathore Haveli, Udaipur",
    details: [{ time: "11:00 AM onwards", dressCode: "Traditional wear" }],
  },
  {
    title: "Haldi & Mehendi",
    subtitle: "Turmeric, henna and music in the courtyard",
    dateLabel: "Wednesday, 17th November 2027",
    venue: "The Rathore Haveli, Udaipur",
    details: [
      { label: "Haldi", time: "10:00 AM onwards", dressCode: "Shades of yellow" },
      { label: "Mehendi", time: "4:00 PM onwards", dressCode: "Greens and florals" },
    ],
  },
  {
    title: "Sagai",
    subtitle: "The exchange of rings",
    dateLabel: "Thursday, 18th November 2027",
    venue: "The Mirror Hall, The Ivory Palace",
    details: [{ time: "6:00 PM onwards", dressCode: "Pastels" }],
  },
  {
    title: "Sangeet Under the Stars",
    subtitle: "An evening of song and dance by the lake",
    dateLabel: "Friday, 19th November 2027",
    venue: "The Lake Terrace, The Ivory Palace",
    details: [{ label: "Sangeet", time: "7:00 PM onwards", dressCode: "Indo-western glamour" }],
  },
  {
    title: "Shubh Vivah",
    subtitle: "The wedding, beneath the palace chandeliers",
    dateLabel: "Saturday, 20th November 2027",
    venue: "The Grand Durbar Hall, The Ivory Palace",
    details: [
      { label: "Baraat", time: "6:30 PM onwards" },
      { label: "Varmala", time: "7:30 PM onwards (followed by Pheras)", dressCode: "Royal traditional wear" },
    ],
  },
  {
    title: "Vidaai",
    subtitle: "A tearful, joyful farewell",
    dateLabel: "Sunday, 21st November 2027",
    venue: "The Ivory Palace, Udaipur",
    details: [{ label: "Vidaai", time: "Early morning" }],
  },
];

const existing = await prisma.invitation.findFirst({ where: { OR: [{ slug: ROYAL_DEMO_SLUG }, { publishedSlug: ROYAL_DEMO_SLUG }] } });
if (existing && !existing.isDemo) {
  console.error(`The link /${ROYAL_DEMO_SLUG} already belongs to a customer invitation. Nothing was changed.`);
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
  const storage = createStorage();
  const cloned = await cloneInvitation(prisma, storage, source, { slug: ROYAL_DEMO_SLUG, isDemo: true, template: "royal-wedding" });
  id = cloned.id;
  console.log(`created /${ROYAL_DEMO_SLUG}`);
} else {
  console.log(`refreshing /${ROYAL_DEMO_SLUG}`);
}

const { weddingAt, ...text } = DETAILS;
await prisma.invitation.update({
  where: { id },
  data: {
    ...text,
    template: "royal-wedding",
    isDemo: true,
    rsvpMode: "local-demo",
    weddingAt: parseWeddingAt(weddingAt),
    guessOptions: [
      { id: "D", label: "Devika" },
      { id: "A", label: "Aryan" },
      { id: "B", label: "Both" },
    ],
  },
});

const events = await prisma.ceremonyEvent.findMany({ where: { invitationId: id }, orderBy: { sortOrder: "asc" } });
for (const [index, event] of events.entries()) {
  const ceremony = CEREMONIES[index];
  if (!ceremony) break;
  // The photographs and their descriptions stay as they are; only the words change.
  await prisma.ceremonyEvent.update({ where: { id: event.id }, data: ceremony });
}

const publisher = createPublisher({
  repo: createPrismaRepo(prisma),
  storage: createStorage(),
  fallbackImage: fallbackImageUrl,
  purge: cloudflarePurger(config.cloudflareZoneId, config.cloudflareApiToken),
});
await publisher.publish(id, "seed-royal-demo");
console.log(`published /${ROYAL_DEMO_SLUG}`);

await prisma.$disconnect();
