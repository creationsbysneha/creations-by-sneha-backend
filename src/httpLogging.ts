import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { bindRequestUser, logAt, newRequestId, requestContext, type RequestStore } from "./logger.js";

const REQUEST_ID = /^[\w-]{6,64}$/;

function incomingRequestId(req: Request) {
  const value = req.get("x-request-id");
  return value && REQUEST_ID.test(value) ? value : newRequestId();
}

function requestIp(req: Request) {
  if (config.trustProxy) return req.ip;
  return req.socket.remoteAddress || undefined;
}

function requestPath(req: Request) {
  return req.originalUrl.split("?")[0] || req.path;
}

export function requestLogging(req: Request, res: Response, next: NextFunction) {
  const requestId = incomingRequestId(req);
  const store: RequestStore = { requestId };
  res.locals.requestId = requestId;
  res.setHeader("X-Request-Id", requestId);

  requestContext.run(store, () => {
    const started = process.hrtime.bigint();
    res.on("finish", () => {
      if (!config.logging.httpRequests) return;
      const session = res.locals.session as { admin?: { id: string; role: string } } | undefined;
      if (session?.admin) bindRequestUser(session.admin.id, session.admin.role);
      const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
      const status = res.statusCode;
      const path = requestPath(req);
      const quiet = path === "/api/health" || path.startsWith("/dev-public");
      const level = status >= 500 ? "error" : status >= 400 ? "warn" : quiet ? "debug" : "info";
      logAt(level, "HTTP", `${req.method} ${path} ${status} ${Math.round(durationMs)}ms`, {
        requestId,
        method: req.method,
        path,
        status,
        durationMs: Math.round(durationMs),
        ok: status < 400,
        userId: session?.admin?.id || store.userId,
        role: session?.admin?.role || store.role,
        ip: requestIp(req),
      });
    });
    next();
  });
}
