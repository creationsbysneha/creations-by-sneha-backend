import { logInfo, logWarn, safeError } from "./logger.js";
import type { Purger } from "./publishing.js";

export function cloudflarePurger(zoneId: string, apiToken: string): Purger | undefined {
  if (!zoneId || !apiToken) return undefined;
  return async (urls) => {
    const started = Date.now();
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(zoneId)}/purge_cache`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files: urls }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`Cache purge failed (${response.status}).`);
      logInfo("R2", "cache_purge", { urlCount: urls.length, durationMs: Date.now() - started });
    } catch (error) {
      logWarn("R2", "cache_purge_failed", { urlCount: urls.length, durationMs: Date.now() - started, ...safeError(error) });
      throw error;
    }
  };
}
