import "dotenv/config";
import { cloneInvitation } from "./cloneInvitation.js";
import { fallbackImageUrl } from "./config.js";
import { prisma } from "./db.js";
import { LEGACY_SAMPLE_SLUG, SAMPLE_SLUG } from "./security.js";
import { createPublisher } from "./publishing.js";
import { cloudflarePurger } from "./purge.js";
import { createPrismaRepo } from "./repo.js";
import { loadGraph } from "./store.js";
import { createStorage } from "./storage.js";
import { config } from "./config.js";

const LOOKS = [
  { slug: "demo2", theme: { accent: "rose", paper: "blush", script: "parisienne" } as const },
  { slug: "demo3", theme: { accent: "olive", paper: "ivory", script: "playfair" } as const },
];

const sourceRow =
  (await prisma.invitation.findFirst({ where: { slug: SAMPLE_SLUG } })) ||
  (await prisma.invitation.findFirst({ where: { slug: LEGACY_SAMPLE_SLUG } })) ||
  (await prisma.invitation.findFirst({ where: { isDemo: true }, orderBy: { createdAt: "asc" } }));

if (!sourceRow) {
  console.error("No sample invitation to copy. Publish Saanvi & Kabir first.");
  process.exit(1);
}

await prisma.invitation.update({ where: { id: sourceRow.id }, data: { isDemo: true } });
const source = await loadGraph(prisma, sourceRow.id);
if (!source) {
  console.error("The sample invitation could not be read.");
  process.exit(1);
}

const storage = createStorage();
const publisher = createPublisher({
  repo: createPrismaRepo(prisma),
  storage,
  fallbackImage: fallbackImageUrl,
  purge: cloudflarePurger(config.cloudflareZoneId, config.cloudflareApiToken),
});

for (const look of LOOKS) {
  const existing = await prisma.invitation.findUnique({ where: { slug: look.slug } });
  if (existing) {
    await prisma.invitation.update({
      where: { id: existing.id },
      data: { isDemo: true, theme: look.theme },
    });
    await publisher.publish(existing.id, "seed-demo-looks");
    console.log(`updated ${look.slug}`);
    continue;
  }
  const cloned = await cloneInvitation(prisma, storage, source, { slug: look.slug, isDemo: true, theme: look.theme });
  await publisher.publish(cloned.id, "seed-demo-looks");
  console.log(`created ${look.slug}`);
}

await prisma.$disconnect();
