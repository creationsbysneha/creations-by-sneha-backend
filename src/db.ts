import { PrismaClient } from "@prisma/client";
import { config } from "./config.js";
import { logDebug, logError, logWarn } from "./logger.js";

const globalForPrisma = globalThis as unknown as { cbsPrisma?: PrismaClient };

function isIdleDisconnect(message: string) {
  return /kind:\s*Closed/i.test(message) || /connection.*(closed|reset|terminated)/i.test(message);
}

function attachPrismaLogs(client: PrismaClient) {
  const events = client as PrismaClient & {
    $on(event: "error" | "warn", callback: (event: { message: string; target: string }) => void): void;
    $on(event: "query", callback: (event: { duration: number; target: string; query: string }) => void): void;
  };
  events.$on("error", (event) => {
    // Neon closes idle pooled sockets. Prisma reports each one as an engine error;
    // the next query opens a new connection. That is not an application failure.
    if (isIdleDisconnect(event.message)) {
      logDebug("DB", "connection_closed", { target: event.target });
      return;
    }
    logError("DB", "prisma_error", { errorMessage: event.message, target: event.target });
  });
  events.$on("warn", (event) => logWarn("DB", "prisma_warn", { errorMessage: event.message, target: event.target }));
  if (config.logging.databaseQueries) {
    events.$on("query", (event) => logDebug("DB", "query", { durationMs: event.duration, target: event.target, query: event.query.slice(0, 200) }));
  }
}

function createPrisma() {
  const client = new PrismaClient({
    log: [
      { emit: "event", level: "error" },
      { emit: "event", level: "warn" },
      ...(config.logging.databaseQueries ? ([{ emit: "event", level: "query" }] as const) : []),
    ],
  });
  attachPrismaLogs(client);
  return client;
}

export const prisma = globalForPrisma.cbsPrisma ?? createPrisma();
globalForPrisma.cbsPrisma = prisma;
