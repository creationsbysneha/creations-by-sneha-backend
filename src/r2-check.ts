import "dotenv/config";
import { randomUUID } from "node:crypto";
import { CACHE, privateMediaKey, publicMediaKey } from "./keys.js";
import { createR2Storage } from "./storage.js";

const storage = createR2Storage();
const origin = (process.env.FRONTEND_ORIGIN || "http://localhost:5173").split(",")[0].trim();
const report: Record<string, unknown> = {};

for (const kind of ["private", "public"] as const) {
  const page = await storage[kind].list("media/");
  report[`${kind}.list`] = `ok, ${page.objects.length} media object(s) on the first page`;
}

const privateKey = privateMediaKey(randomUUID());
await storage.private.put(privateKey, Buffer.from("probe"), { contentType: "image/webp", cacheControl: CACHE.privateMedia });
report["private.put"] = (await storage.private.exists(privateKey)) ? "ok" : "missing after upload";
await storage.private.delete(privateKey);
report["private.delete"] = (await storage.private.exists(privateKey)) ? "still present" : "ok";

const publicKey = publicMediaKey(randomUUID(), "0".repeat(64));
await storage.public.put(publicKey, Buffer.from("probe"), { contentType: "image/webp", cacheControl: CACHE.publicMedia });
const url = storage.publicUrl(publicKey);
const live = await fetch(url, { headers: { Origin: origin } });
report["public.get"] = live.status;
report["public.contentType"] = live.headers.get("content-type");
report["public.cacheControl"] = live.headers.get("cache-control");
report["public.cors"] = live.headers.get("access-control-allow-origin") || "not set for this origin";
await storage.public.delete(publicKey);
const gone = await fetch(url);
report["public.afterDelete"] = gone.status;

console.log(JSON.stringify(report, null, 2));
