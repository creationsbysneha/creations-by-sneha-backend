import { config } from "./config.js";
import { createApp } from "./app.js";
import { prisma } from "./db.js";
import { logError, logInfo, safeError } from "./logger.js";
import { createStorage } from "./storage.js";

function handleFatal(kind: "unhandled_rejection" | "uncaught_exception", reason: unknown) {
  logError("API", kind, safeError(reason));
}

process.on("unhandledRejection", (reason) => handleFatal("unhandled_rejection", reason));
process.on("uncaughtException", (error) => handleFatal("uncaught_exception", error));

let shuttingDown = false;

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logInfo("API", "shutdown", { signal });
  try {
    await prisma.$disconnect();
    logInfo("API", "shutdown_complete", { signal });
    process.exit(0);
  } catch (error) {
    logError("API", "shutdown_failed", { signal, ...safeError(error) });
    process.exit(1);
  }
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

try {
  const storage = createStorage();
  await prisma.$queryRaw`SELECT 1`;
  logInfo("DB", "connected");
  const app = createApp({ prisma, storage });
  app.listen(config.port, "0.0.0.0", () => {
    logInfo("API", "listening", {
      port: config.port,
      storage: storage.driver,
      env: process.env.NODE_ENV || "development",
    });
  });
} catch (error) {
  logError("API", "startup_failed", safeError(error));
  process.exit(1);
}
