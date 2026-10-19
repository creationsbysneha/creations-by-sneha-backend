import "dotenv/config";
import { runCleanup } from "./cleanup.js";
import { config } from "./config.js";
import { prisma } from "./db.js";
import { createPrismaRepo } from "./repo.js";
import { createStorage } from "./storage.js";

const apply = process.argv.includes("--apply");
const report = await runCleanup({
  repo: createPrismaRepo(prisma),
  storage: createStorage(),
  prisma,
  apply,
  graceHours: config.cleanupGraceHours,
  actor: "cli",
});
console.log(JSON.stringify(report, null, 2));
if (!apply) console.log("Dry run only. Nothing was deleted. Run with --apply to delete the items above.");
await prisma.$disconnect();
process.exit(report.errors.length ? 1 : 0);
