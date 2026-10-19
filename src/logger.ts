import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import pino, { type DestinationStream, type Logger } from "pino";

export const SENSITIVE_PATHS = [
  "password",
  "passwordHash",
  "authorization",
  "cookie",
  "cookies",
  "csrfToken",
  "token",
  "tokenHash",
  "accessKey",
  "secretAccessKey",
  "signedUrl",
  "sessionId",
  "cbs_session",
  "DATABASE_URL",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "CLOUDFLARE_API_TOKEN",
  "ADMIN_PASSWORD",
  "headers.authorization",
  "headers.cookie",
  "headers.x-csrf-token",
  "req.headers.authorization",
  "req.headers.cookie",
  "err.config.headers.Authorization",
  "*.password",
  "*.passwordHash",
  "*.authorization",
  "*.cookie",
  "*.token",
  "*.csrfToken",
];

export type RequestStore = {
  requestId: string;
  userId?: string;
  role?: string;
};

export const requestContext = new AsyncLocalStorage<RequestStore>();

export function newRequestId() {
  return `req_${randomBytes(4).toString("hex")}`;
}

export function getRequestId() {
  return requestContext.getStore()?.requestId;
}

export function bindRequestUser(userId: string, role: string) {
  const store = requestContext.getStore();
  if (!store) return;
  store.userId = userId;
  store.role = role;
}

function mixin() {
  return requestContext.getStore() || {};
}

export type LoggerOptions = {
  destination?: DestinationStream;
  pretty?: boolean;
  level?: string;
  env?: NodeJS.ProcessEnv;
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const env = options.env || process.env;
  const nodeEnv = env.NODE_ENV || "development";
  const isProd = nodeEnv === "production";
  const isTest = env.VITEST === "true" || nodeEnv === "test";
  const level = options.level || env.LOG_LEVEL || (isTest ? "silent" : isProd ? "info" : "debug");
  const pretty = options.pretty ?? (!isProd && !isTest && !options.destination);

  const base = {
    service: "creations-by-sneha-api",
    env: nodeEnv,
  };
  const redact = { paths: SENSITIVE_PATHS, censor: "[redacted]" };

  if (pretty) {
    return pino({
      name: "creations-by-sneha-api",
      level,
      base,
      mixin,
      redact,
      timestamp: pino.stdTimeFunctions.isoTime,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname,name,service,env",
          messageFormat: "{category} {msg}",
          singleLine: true,
        },
      },
    });
  }

  return pino(
    {
      name: "creations-by-sneha-api",
      level,
      base,
      mixin,
      redact,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    options.destination,
  );
}

let current = createLogger();

export function getLogger() {
  return current;
}

export function resetLogger(options?: LoggerOptions) {
  current = createLogger(options);
  return current;
}

export function logAt(level: "debug" | "info" | "warn" | "error", category: string, msg: string, fields?: Record<string, unknown>) {
  current[level]({ category, ...fields }, msg);
}

export const logDebug = (category: string, msg: string, fields?: Record<string, unknown>) => logAt("debug", category, msg, fields);
export const logInfo = (category: string, msg: string, fields?: Record<string, unknown>) => logAt("info", category, msg, fields);
export const logWarn = (category: string, msg: string, fields?: Record<string, unknown>) => logAt("warn", category, msg, fields);
export const logError = (category: string, msg: string, fields?: Record<string, unknown>) => logAt("error", category, msg, fields);

export function safeError(error: unknown) {
  if (error instanceof Error) {
    const details: Record<string, unknown> = { errorName: error.name, errorMessage: error.message };
    if ((process.env.NODE_ENV || "development") !== "production" && error.stack) details.stack = error.stack;
    const status = (error as { status?: number }).status;
    if (typeof status === "number") details.status = status;
    const code = (error as { code?: string }).code;
    if (code) details.code = code;
    const attempts = (error as { attempts?: number }).attempts;
    if (typeof attempts === "number") details.attempts = attempts;
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (typeof statusCode === "number") details.statusCode = statusCode;
    return details;
  }
  return { errorName: "Error", errorMessage: "Unknown error" };
}

export async function timed<T>(category: string, msg: string, fn: () => Promise<T>, fields?: Record<string, unknown>) {
  const started = Date.now();
  try {
    const result = await fn();
    logInfo(category, msg, { ...fields, durationMs: Date.now() - started, ok: true });
    return result;
  } catch (error) {
    logError(category, `${msg}_failed`, { ...fields, durationMs: Date.now() - started, ok: false, ...safeError(error) });
    throw error;
  }
}

export function collectLogs() {
  const records: Array<Record<string, unknown>> = [];
  const destination = {
    write(chunk: string) {
      const line = String(chunk).trim();
      if (line) records.push(JSON.parse(line) as Record<string, unknown>);
    },
  };
  resetLogger({ destination, pretty: false, level: "debug" });
  return records;
}
