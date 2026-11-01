import { createHash, randomBytes } from "node:crypto";

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const SAMPLE_SLUG = "demo";
export const LEGACY_SAMPLE_SLUG = "saanvi-and-kabir";

export function nextDemoSlug(existing: string[]) {
  const used = new Set(existing);
  let n = 2;
  while (used.has(`demo${n}`)) n += 1;
  return `demo${n}`;
}

export const FAMILY_EMAIL_DOMAIN = "creationsbysneha.in";

/* The public link of the Royal Wedding demo. */
export const ROYAL_DEMO_SLUG = "demo-royal";

export const RESERVED_SLUGS = new Set(["admin", "login", "demo", "invite", "images", "brand", ROYAL_DEMO_SLUG]);

export function slugReserved(slug: string, isDemo = false) {
  if (isDemo && (slug === "demo" || slug === ROYAL_DEMO_SLUG)) return false;
  return RESERVED_SLUGS.has(slug);
}

export function familyLoginEmail(raw: string) {
  const trimmed = raw.trim().toLowerCase();
  const at = trimmed.indexOf("@");
  const local = (at === -1 ? trimmed : trimmed.slice(0, at)).replace(/[^a-z0-9._+-]/g, "");
  return local ? `${local}@${FAMILY_EMAIL_DOMAIN}` : "";
}

export function newSecret() {
  return randomBytes(32).toString("hex");
}

export function hashSecret(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function csrfMatches(sessionToken: string, header: string | undefined) {
  if (!sessionToken || !header) return false;
  const left = Buffer.from(sessionToken);
  const right = Buffer.from(header);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function timingSafeEqual(left: Buffer, right: Buffer) {
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left[index] ^ right[index];
  }
  return mismatch === 0;
}

export type AccountRole = "super_admin" | "customer";
export type InvitationAction = "read" | "update" | "create" | "delete" | "publish" | "unpublish";

export function invitationAccess(
  role: AccountRole,
  invitationIds: readonly string[],
  action: InvitationAction,
  invitationId?: string,
) {
  if (role === "super_admin") return "allow" as const;
  if (action === "create" || action === "delete" || action === "publish" || action === "unpublish") return "deny" as const;
  if (!invitationId || !invitationIds.includes(invitationId)) return "deny" as const;
  return "allow" as const;
}

export function productAccess(role: AccountRole, action: "read" | "write") {
  if (role === "super_admin") return "allow" as const;
  if (action === "write") return "deny" as const;
  return "allow" as const;
}

export type PublishInput = {
  title: string;
  slug: string;
  brideName: string;
  groomName: string;
  weddingAt: Date | null;
  venueName: string;
  isDemo?: boolean;
};

export function publishErrors(invitation: PublishInput) {
  const errors: string[] = [];
  if (!invitation.title.trim()) errors.push("Title is required.");
  if (!SLUG_PATTERN.test(invitation.slug) || slugReserved(invitation.slug, invitation.isDemo)) {
    errors.push("The public link must use lowercase letters, numbers, and hyphens.");
  }
  if (!invitation.brideName.trim() || !invitation.groomName.trim()) errors.push("Both couple names are required.");
  if (!invitation.weddingAt) errors.push("A wedding date is required.");
  if (!invitation.venueName.trim()) errors.push("A venue name is required.");
  return errors;
}

export function passwordProblems(password: string) {
  const problems: string[] = [];
  if (password.length < 8) problems.push("Use at least 8 characters.");
  if (!/[a-zA-Z]/.test(password)) problems.push("Include a letter.");
  if (!/[0-9]/.test(password)) problems.push("Include a number.");
  return problems;
}

export function ordinalSuffix(day: number) {
  if (day % 10 === 1 && day !== 11) return "st";
  if (day % 10 === 2 && day !== 12) return "nd";
  if (day % 10 === 3 && day !== 13) return "rd";
  return "th";
}

export function formatWeddingDate(value: Date | null, venueName: string) {
  if (!value) return { iso: "", day: "", suffix: "", monthYear: "", weekday: "", footer: venueName };
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "numeric",
    month: "long",
    year: "numeric",
    weekday: "long",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  const day = read("day");
  const suffix = ordinalSuffix(Number(day));
  const monthYear = `${read("month")} ${read("year")}`.trim();
  const weekday = read("weekday");
  return {
    iso: value.toISOString(),
    day,
    suffix,
    monthYear,
    weekday,
    footer: [`${day}${suffix} ${monthYear}`, weekday, venueName].filter(Boolean).join(" • "),
  };
}

export function toWeddingInput(value: Date | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}T${read("hour")}:${read("minute")}`;
}

export function parseWeddingAt(value: string) {
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  const withSeconds = value.length === 16 ? `${value}:00` : value;
  return new Date(`${withSeconds}+05:30`);
}

export function parseExpiryDate(value: string) {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (day) return new Date(`${day[1]}-${day[2]}-${day[3]}T23:59:59.999+05:30`);
  return parseWeddingAt(value);
}

export function toExpiryInput(value: Date | null) {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const read = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? "";
  return `${read("year")}-${read("month")}-${read("day")}`;
}

export function splitName(name: string) {
  const trimmed = name.trim();
  if (!trimmed) return { first: "", rest: "" };
  return { first: trimmed.slice(0, 1), rest: trimmed.slice(1) };
}

const romans = ["Ceremony I", "Ceremony II", "Ceremony III", "Ceremony IV", "Ceremony V", "Ceremony VI", "Ceremony VII", "Ceremony VIII", "Ceremony IX", "Ceremony X", "Ceremony XI", "Ceremony XII"];

export function romanFor(index: number) {
  return romans[index] || `Ceremony ${index + 1}`;
}
