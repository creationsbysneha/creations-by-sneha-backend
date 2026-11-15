import "dotenv/config";
import { cloneInvitation } from "./cloneInvitation.js";
import { config, fallbackImageUrl } from "./config.js";
import { prisma } from "./db.js";
import { createPublisher } from "./publishing.js";
import { cloudflarePurger } from "./purge.js";
import { createPrismaRepo } from "./repo.js";
import { LEGACY_SAMPLE_SLUG, parseWeddingAt, SAMPLE_SLUG, SHUBH_DEMO_SLUG } from "./security.js";
import { loadGraph } from "./store.js";
import { createStorage } from "./storage.js";

/*
 * Creates (or refreshes) the Shubh Aarambh demo at /demo-shubh and publishes it.
 * It copies the sample invitation's photographs, then gives it its own fictional couple, places and ceremonies.
 * Run once after the migration: npm run demo:shubh
 */

const DETAILS = {
  title: "Arnav & Siya | Shubh Aarambh Sample Invitation",
  description: "A sample Shubh Aarambh invitation for Arnav and Siya. Names, dates, and the venue are illustrative.",
  nameOrder: "groom-first",
  groomName: "Arnav",
  groomFull: "Arnav Mehra",
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

// In the order of the sample's photographs: rituals at home, haldi, rings, an evening party, the wedding, the farewell.
const CEREMONIES = [
  {
    title: "Ganesh Puja",
    subtitle: "An auspicious beginning",
    dateLabel: "Tuesday, 7th December 2027",
    venue: "The Mehra residence, Jaipur",
    details: [{ time: "10:00 AM onwards", dressCode: "Traditional wear" }],
  },
  {
    title: "Haldi",
    subtitle: "Turmeric, laughter and marigolds",
    dateLabel: "Wednesday, 8th December 2027",
    venue: "The Lotus Palace courtyard",
    details: [{ time: "11:00 AM onwards", dressCode: "Shades of yellow" }],
  },
  {
    title: "Sagai",
    subtitle: "The exchange of rings",
    dateLabel: "Thursday, 9th December 2027",
    venue: "The Lotus Palace, Mirror Hall",
    details: [{ time: "6:00 PM onwards", dressCode: "Pastels" }],
  },
  {
    title: "Sangeet",
    subtitle: "A night of song and dance",
    dateLabel: "Friday, 10th December 2027",
    venue: "The Lotus Palace lawns",
    details: [{ time: "7:00 PM onwards", dressCode: "Indo-western" }],
  },
  {
    title: "Shubh Vivah",
    subtitle: "The wedding ceremony",
    dateLabel: "Saturday, 11th December 2027",
    venue: "The Lotus Palace, Durbar Hall",
    details: [
      { label: "Baraat", time: "6:30 PM onwards" },
      { label: "Varmala", time: "7:30 PM onwards (followed by Pheras)", dressCode: "Traditional wear" },
    ],
  },
  {
    title: "Vidaai",
    subtitle: "A tearful, joyful farewell",
    dateLabel: "Sunday, 12th December 2027",
    venue: "The Lotus Palace, Jaipur",
    details: [{ label: "Vidaai", time: "Early morning" }],
  },
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
      { id: "A", label: "Arnav" },
      { id: "S", label: "Siya" },
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
await publisher.publish(id, "seed-shubh-demo");
console.log(`published /${SHUBH_DEMO_SLUG}`);

await prisma.$disconnect();
