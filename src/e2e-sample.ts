import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { snapshotSchema, type PublishedSnapshot } from "./publicSnapshot.js";

const API = (process.env.E2E_API_URL || "http://localhost:4100").replace(/\/$/, "");
const EMAIL = process.env.E2E_EMAIL || "";
const PASSWORD = process.env.E2E_PASSWORD || "";
const SLUG = process.env.E2E_SLUG || "saanvi-and-kabir";
const DEMO = path.resolve(process.env.E2E_DEMO_DIR || "../creations-by-sneha-frontend/public/demo");
const ORIGIN = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").split(",")[0].trim();

if (!EMAIL || !PASSWORD) {
  console.error("Set E2E_EMAIL and E2E_PASSWORD for a studio login.");
  process.exit(1);
}

let cookie = "";
let csrf = "";
const results: Array<{ check: string; ok: boolean; detail?: string }> = [];
const check = (name: string, ok: boolean, detail?: string) => {
  results.push({ check: name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

async function call<T>(method: string, route: string, body?: unknown, form?: FormData): Promise<{ status: number; data: T }> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (cookie) headers.Cookie = cookie;
  if (method !== "GET") headers["X-CSRF-Token"] = csrf;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API}${route}`, { method, headers, body: form || (body !== undefined ? JSON.stringify(body) : undefined) });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie?.startsWith("cbs_session=")) cookie = setCookie.split(";")[0];
  const text = await response.text();
  return { status: response.status, data: (text ? JSON.parse(text) : null) as T };
}

async function uploadDemo(id: string, file: string, role: string, ceremonyIndex?: number) {
  const form = new FormData();
  form.set("file", new Blob([await readFile(path.join(DEMO, file))], { type: "image/jpeg" }), file);
  form.set("role", role);
  if (ceremonyIndex !== undefined) form.set("ceremonyIndex", String(ceremonyIndex));
  const result = await call<{ mediaId: string; error?: string }>("POST", `/api/invitations/${id}/images`, undefined, form);
  if (result.status !== 201) throw new Error(`Upload of ${file} failed: ${result.status} ${result.data?.error || ""}`);
  return result.data.mediaId;
}

async function liveJson(url: string, bust = true) {
  const response = await fetch(bust ? `${url}?check=${Date.now()}` : url, { headers: { Origin: ORIGIN } });
  return { response, body: response.ok ? ((await response.json()) as PublishedSnapshot) : null };
}

const ceremonies = [
  ["Parampara & Pratishtha", "Lagun & Shiv Vivah", "Monday, 8th February 2027", "The Malhotra residence", "Bride and groom holding hands under a floral mandap", [{ time: "2:00 PM onwards" }]],
  ["Phoolon Ki Mehfil & Sangeet", "Phoolon ki Haldi & Ladies Sangeet", "Tuesday, 9th February 2027", "The Malhotra residence", "Bride smiling as family apply haldi", [
    { label: "Haldi", time: "11:00 AM onwards", dressCode: "Shades of yellow and orange" },
    { label: "Ladies Sangeet", time: "5:00 PM onwards", dressCode: "Indian wear" },
  ]],
  ["Sagai & Shagun", "The ring ceremony", "Wednesday, 10th February 2027", "The Malhotra residence", "Groom placing an engagement ring on the bride's finger", [{ time: "5:00 PM onwards", dressCode: "Pastels" }]],
  ["Sitaaron Wali Shaam", "Pool Party & Mayra (Bhaat)", "Thursday, 11th February 2027", "The Amber Pavilion, Jaipur", "Bride dancing with friends at a sangeet night", [
    { label: "Pool Party", time: "5:00 PM onwards", dressCode: "Co-ord set & sunglasses" },
    { label: "Mayra (Bhaat)", time: "7:00 PM onwards", dressCode: "Shades of Rajasthani touch" },
  ]],
  ["Together Forever", "Sacred vows, eternal bond, blessed beginnings", "Friday, 12th February 2027", "The Amber Pavilion, Jaipur", "Bride placing the varmala on the groom", [
    { label: "Baraat", time: "8:00 PM onwards" },
    { label: "Varmala", time: "9:00 PM onwards (followed by Pheras)", dressCode: "Traditional wear" },
  ]],
  ["Bheegi Palken", "From celebration to farewell, wrapped in love and tears", "Saturday, 13th February 2027", "The Malhotra residence", "Bride embracing her mother at the vidaai", [{ label: "Vidaai", time: "Early morning" }]],
] as const;

const galleryAlts = [
  "Bride and groom in traditional Indian wedding attire",
  "Couple standing together under wedding lights",
  "Family celebrating a haldi ceremony",
  "Bride and groom during a marigold haldi celebration",
  "Newlywed couple holding hands, with henna and wedding rings",
  "Engagement ceremony with mehendi and traditional attire",
  "Couple seated on a floral wedding stage",
  "Hindu wedding ceremony under a floral mandap",
  "Couple seated on a flower-covered wedding swing",
  "Palace courtyard dressed for a wedding celebration",
];

const login = await call<{ role: string; csrfToken: string }>("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
if (login.status !== 200) throw new Error(`Sign-in failed (${login.status}).`);
csrf = login.data.csrfToken;
check("studio sign-in", login.data.role === "super_admin");

const existing = await call<{ invitations: Array<{ id: string; slug: string }> }>("GET", "/api/invitations");
for (const card of existing.data.invitations.filter((item) => item.slug === SLUG)) {
  await call("DELETE", `/api/invitations/${card.id}`);
}

const created = await call<{ id: string }>("POST", "/api/invitations");
const id = created.data.id;
check("card created", created.status === 201, id);

const fields = {
  title: "Saanvi & Kabir | Sample Wedding Invitation",
  slug: SLUG,
  description: "A sample digital wedding invitation for Saanvi and Kabir. Names, dates, and the venue are illustrative.",
  brideName: "Saanvi",
  brideFull: "Saanvi Malhotra",
  brideParents: "Daughter of Smt. Nandini & Shri Vikram Malhotra",
  brideGrandparents: "Granddaughter of Smt. Lata & Shri Devendra Malhotra",
  groomName: "Kabir",
  groomFull: "Kabir Sethi",
  groomParents: "Son of Smt. Pooja & Shri Rohan Sethi",
  groomGrandparents: "Grandson of Smt. Savitri & Shri Harish Sethi",
  families: "The Malhotra & Sethi families",
  complimentOne: "Smt. Nandini Malhotra",
  complimentTwo: "Shri Vikram Malhotra",
  rsvpFamily: "Malhotra Family",
  cousinsLabel: "The Sethi cousins",
  cousins: "Kunal Sethi, Neel Sethi, Riya Sethi & Aditya Sethi",
  weddingAt: "2027-02-12T00:00",
  venueName: "The Amber Pavilion",
  venueAddress1: "Amber Road",
  venueAddress2: "Jaipur",
  venueNote: "Illustrative venue for this sample invitation",
  mapEmbed: "https://www.google.com/maps?output=embed&q=Amber%20Fort%2C%20Jaipur%2C%20Rajasthan",
  directionsUrl: "https://www.google.com/maps/search/?api=1&query=Amber%20Fort%20Jaipur",
  rsvpMode: "local-demo",
  albumMode: "sample",
  isDemo: true,
  theme: { accent: "gold", paper: "cream", script: "great-vibes" },
  guessOptions: [
    { id: "S", label: "Saanvi" },
    { id: "K", label: "Kabir" },
    { id: "B", label: "Both" },
  ],
  ceremonies: ceremonies.map(([title, subtitle, date, venue, imageAlt, events]) => ({ title, subtitle, date, venue, imageAlt, events })),
};
const saved = await call("PUT", `/api/invitations/${id}`, fields);
check("draft fields saved", saved.status === 200);

await uploadDemo(id, "hero.jpg", "hero");
await uploadDemo(id, "envelope.jpg", "envelope");
await uploadDemo(id, "venue.jpg", "venue");
const galleryIds: string[] = [];
for (let index = 1; index <= 10; index += 1) galleryIds.push(await uploadDemo(id, `gallery-${String(index).padStart(2, "0")}.jpg`, "gallery"));
for (let index = 0; index < 6; index += 1) await uploadDemo(id, `ceremony-${String(index + 1).padStart(2, "0")}.jpg`, "ceremony", index);
const altSave = await call("PUT", `/api/invitations/${id}`, { gallery: galleryIds.map((mediaId, index) => ({ mediaId, alt: galleryAlts[index] })) });
check("19 photographs uploaded to the private bucket", altSave.status === 200);

const draftImage = await fetch(`${API}/api/media/${galleryIds[0]}`);
check("draft photograph refused without sign-in", draftImage.status === 401, String(draftImage.status));

const published = await call<{ liveUrl: string; publication: { version: number } }>("POST", `/api/invitations/${id}/publish`);
check("published", published.status === 200, `version ${published.data.publication?.version}`);
const liveUrl = published.data.liveUrl;

const first = await liveJson(liveUrl);
check("live JSON is public", first.response.status === 200);
check("live JSON passes the schema", snapshotSchema.safeParse(first.body).success);
check("live JSON cache header", first.response.headers.get("cache-control") === "public, max-age=60, must-revalidate", first.response.headers.get("cache-control") || "");
check("live JSON content type", (first.response.headers.get("content-type") || "").startsWith("application/json"));
const urls = [...new Set((first.body?.assets || []).map((asset) => asset.url))];
check("19 published photographs listed", urls.length === 19, String(urls.length));
let imagesOk = 0;
for (const url of urls) {
  const image = await fetch(url, { method: "HEAD" });
  if (image.status === 200 && image.headers.get("content-type") === "image/webp" && image.headers.get("cache-control") === "public, max-age=31536000, immutable") {
    imagesOk += 1;
  }
}
check("every published photograph loads with immutable caching", imagesOk === urls.length, `${imagesOk}/${urls.length}`);
check("no API or signed URLs in the live JSON", !/\/api\/media|X-Amz|localhost:4/.test(JSON.stringify(first.body)));

const draftChange = await call<{ publication: { hasUnpublishedChanges: boolean } }>("PUT", `/api/invitations/${id}`, { venueNote: "Draft only: guests must not see this yet" });
const afterSave = await liveJson(liveUrl);
check("saving keeps changes private", afterSave.body?.content.venue.note === "Illustrative venue for this sample invitation" && draftChange.data.publication.hasUnpublishedChanges);

const republished = await call<{ publication: { version: number } }>("POST", `/api/invitations/${id}/publish`);
const second = await liveJson(liveUrl);
check("Publish changes updates the live JSON", second.body?.version === 2 && second.body?.content.venue.note.startsWith("Draft only"), `version ${second.body?.version}`);
const sameImages = JSON.stringify(second.body?.assets) === JSON.stringify(first.body?.assets);
check("unchanged photographs keep the same URLs", sameImages && republished.status === 200);

const restored = await call("PUT", `/api/invitations/${id}`, { venueNote: "Illustrative venue for this sample invitation" });
const third = await call<{ publication: { version: number } }>("POST", `/api/invitations/${id}/publish`);
check("final publish", restored.status === 200 && third.status === 200, `version ${third.data.publication?.version}`);

console.log(JSON.stringify({ invitationId: id, liveUrl, passed: results.filter((item) => item.ok).length, failed: results.filter((item) => !item.ok).length }, null, 2));
process.exit(results.every((item) => item.ok) ? 0 : 1);
