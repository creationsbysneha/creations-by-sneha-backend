import "dotenv/config";

const isProduction = process.env.NODE_ENV === "production";

function envFlag(name: string, fallback: boolean) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  return raw === "true" || raw === "1";
}

export const config = {
  port: Number(process.env.PORT || 4000),
  databaseUrl: process.env.DATABASE_URL || "",
  frontendOrigin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  publicApiUrl: (process.env.API_PUBLIC_URL || "http://localhost:4000").replace(/\/$/, ""),
  sessionTtlHours: Number(process.env.SESSION_TTL_HOURS || 12),
  cookieSecure: isProduction,
  storageDriver: process.env.STORAGE_DRIVER || "local",
  storageDir: process.env.STORAGE_DIR || "storage",
  dataFile: process.env.DATA_FILE || "data/store.json",
  trustProxy: process.env.TRUST_PROXY === "true",
  cleanupGraceHours: Number(process.env.STORAGE_CLEANUP_GRACE_HOURS || 48),
  cloudflareZoneId: process.env.CLOUDFLARE_ZONE_ID || "",
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || "",
  logging: {
    level: process.env.LOG_LEVEL || (isProduction ? "info" : "debug"),
    httpRequests: envFlag("LOG_HTTP_REQUESTS", true),
    databaseQueries: envFlag("LOG_DATABASE_QUERIES", false),
    r2Operations: envFlag("LOG_R2_OPERATIONS", true),
    authEvents: envFlag("LOG_AUTH_EVENTS", true),
  },
};

export const allowedOrigins = config.frontendOrigin.split(",").map((origin) => origin.trim()).filter(Boolean);

function isPrivateDevHost(host: string) {
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".local")) return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
  const [first, second] = parts;
  return first === 10 || (first === 192 && second === 168) || (first === 172 && second >= 16 && second <= 31);
}

export function isAllowedBrowserOrigin(origin: string | undefined) {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (isProduction) return false;
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    const vitePort = url.port === "" || url.port === "5173" || url.port === "4173";
    return vitePort && isPrivateDevHost(url.hostname);
  } catch {
    return false;
  }
}

export const publicSiteUrl = (process.env.PUBLIC_SITE_URL || allowedOrigins[0] || "http://localhost:5173").replace(/\/$/, "");

export const fallbackImageUrl = `${publicSiteUrl}/demo/fallback.jpg`;
