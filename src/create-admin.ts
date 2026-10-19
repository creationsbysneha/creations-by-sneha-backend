import "dotenv/config";
import argon2 from "argon2";
import { prisma } from "./db.js";
import { logInfo } from "./logger.js";
import { passwordProblems } from "./security.js";
import { addLog } from "./store.js";

const email = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD || "";
const problems = passwordProblems(password);

if (!email || !email.includes("@")) {
  console.error("Set ADMIN_EMAIL to the administrator email address.");
  process.exit(1);
}
if (problems.length) {
  console.error(problems.join(" "));
  process.exit(1);
}

if (await prisma.admin.findUnique({ where: { email }, select: { id: true } })) {
  console.error("An administrator with that email already exists. No password was changed.");
  process.exit(1);
}

const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
const admin = await prisma.admin.create({ data: { email, passwordHash, role: "super_admin" } });
await addLog(prisma, { action: "admin.create", actor: email, ok: true, detail: "Added an administrator" });
logInfo("DB", "user_created", { userId: admin.id, role: admin.role });
await prisma.$disconnect();
console.log(`Created administrator ${email}`);
