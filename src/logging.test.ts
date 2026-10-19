import express from "express";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { requestLogging } from "./httpLogging.js";
import { collectLogs, getLogger, logError, resetLogger } from "./logger.js";
import { createPublisher, PublishError } from "./publishing.js";
import { createMemoryStorage, instrumentStorage } from "./storage.js";
import { createFakeRepo } from "./testing/fakeRepo.js";
import { sampleInvitation } from "./testing/sampleGraph.js";

afterEach(() => {
  resetLogger();
});

async function withApp(app: express.Express, run: (base: string) => Promise<void>) {
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

describe("logger", () => {
  it("redacts credentials and session secrets", () => {
    const records = collectLogs();
    getLogger().info(
      {
        password: "Varshney@secret",
        authorization: "Bearer super-secret",
        cookie: "cbs_session=abc123",
        csrfToken: "csrf-secret",
        token: "session-token",
        headers: { authorization: "Bearer xyz", cookie: "cbs_session=abc123" },
      },
      "probe",
    );
    const line = JSON.stringify(records.at(-1));
    expect(line).not.toContain("Varshney@secret");
    expect(line).not.toContain("super-secret");
    expect(line).not.toContain("session-token");
    expect(line).not.toContain("csrf-secret");
    expect(line).not.toContain("cbs_session=abc123");
    expect(records.at(-1)?.password).toBe("[redacted]");
    expect(records.at(-1)?.authorization).toBe("[redacted]");
  });
});

describe("HTTP request logging", () => {
  it("records method, status, duration, and request id without bodies or credentials", async () => {
    const records = collectLogs();
    const app = express();
    app.use(express.json());
    app.use(requestLogging);
    app.post("/api/invitations", (req, res) => {
      res.locals.session = { admin: { id: "usr_123", role: "super_admin" } };
      res.status(200).json({ ok: true, echo: req.body });
    });

    await withApp(app, async (base) => {
      const response = await fetch(`${base}/api/invitations`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer leaked-token",
          Cookie: "cbs_session=leaked-session",
          "X-Request-Id": "req_test1",
        },
        body: JSON.stringify({ password: "should-not-appear", title: "Saanvi and Kabir" }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("x-request-id")).toBe("req_test1");
    });

    const http = records.find((record) => record.category === "HTTP");
    expect(http).toMatchObject({
      category: "HTTP",
      method: "POST",
      path: "/api/invitations",
      status: 200,
      ok: true,
      requestId: "req_test1",
      userId: "usr_123",
    });
    expect(typeof http?.durationMs).toBe("number");
    expect(String(http?.msg)).toMatch(/POST \/api\/invitations 200 \d+ms/);
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("should-not-appear");
    expect(dump).not.toContain("leaked-token");
    expect(dump).not.toContain("leaked-session");
  });

  it("logs 4xx as warn and 5xx as error without leaking credentials", async () => {
    const records = collectLogs();
    const app = express();
    app.use(express.json());
    app.use(requestLogging);
    app.post("/api/invitations", (_req, res) => res.status(400).json({ error: "Check the highlighted fields." }));
    app.post("/api/invitations/publish", (_req, _res, next) => {
      next(Object.assign(new Error("boom"), { password: "secret-password" }));
    });
    app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      logError("HTTP", "unhandled", { password: (error as { password?: string }).password, errorMessage: error instanceof Error ? error.message : "error" });
      res.status(500).json({ error: "Something went wrong" });
    });

    await withApp(app, async (base) => {
      await fetch(`${base}/api/invitations`, { method: "POST", headers: { Authorization: "Bearer hidden" } });
      const failed = await fetch(`${base}/api/invitations/publish`, { method: "POST" });
      expect(failed.status).toBe(500);
      const body = await failed.json();
      expect(body).toEqual({ error: "Something went wrong" });
    });

    const warn = records.find((record) => record.category === "HTTP" && record.status === 400);
    const error = records.find((record) => record.category === "HTTP" && record.status === 500);
    expect(warn?.level).toBe(40);
    expect(error?.level).toBe(50);
    expect(JSON.stringify(records)).not.toContain("secret-password");
    expect(JSON.stringify(records)).not.toContain("Bearer hidden");
  });
});

describe("publish lifecycle logs", () => {
  const fallback = "https://creationsbysneha.in/demo/fallback.jpg";

  it("emits the publish stages and a single success after the work finishes", async () => {
    const records = collectLogs();
    const fake = createFakeRepo();
    const storage = instrumentStorage(createMemoryStorage());
    const publisher = createPublisher({ repo: fake.repo, storage, fallbackImage: fallback });
    const card = sampleInvitation(fake, storage);

    const result = await publisher.publish(card.id, "studio@test");
    expect(result.snapshot.version).toBe(1);

    const publish = records.filter((record) => record.category === "PUBLISH").map((record) => record.msg);
    expect(publish).toEqual([
      "requested",
      "draft_validated",
      "start",
      "media_validated",
      "assets_ready",
      "urls_generated",
      "snapshot_built",
      "snapshot_uploaded",
      "database_committed",
      "success",
    ]);
    expect(records.some((record) => record.category === "PUBLISH" && record.msg === "success")).toBe(true);
    expect(records.some((record) => record.category === "R2" && record.msg === "snapshot_uploaded")).toBe(true);
    const success = records.find((record) => record.category === "PUBLISH" && record.msg === "success");
    expect(success).toMatchObject({ slug: "saanvi-and-kabir", version: 1 });
    expect(typeof success?.durationMs).toBe("number");
  });

  it("does not emit success when a later database write fails", async () => {
    const records = collectLogs();
    const fake = createFakeRepo();
    const storage = instrumentStorage(createMemoryStorage());
    const publisher = createPublisher({ repo: fake.repo, storage, fallbackImage: fallback });
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    records.length = 0;

    fake.edit((state) => (state.invitations.get(card.id)!.brideName = "Sanvi"));
    fake.failNext("recordPublication");
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 502 });

    const publish = records.filter((record) => record.category === "PUBLISH").map((record) => record.msg);
    expect(publish).toContain("failed");
    expect(publish).toContain("restored");
    expect(publish).not.toContain("success");
    expect(publish.filter((msg) => msg === "success")).toEqual([]);
    expect(records.find((record) => record.category === "PUBLISH" && record.msg === "failed")).toMatchObject({ stage: "database_commit" });
  });

  it("does not emit success when snapshot upload fails", async () => {
    const records = collectLogs();
    const fake = createFakeRepo();
    const storage = instrumentStorage(createMemoryStorage());
    const publisher = createPublisher({ repo: fake.repo, storage, fallbackImage: fallback });
    const card = sampleInvitation(fake, storage);
    storage.failNext("public", "put", "published/saanvi-and-kabir.json");

    await expect(publisher.publish(card.id, "a")).rejects.toBeInstanceOf(PublishError);
    expect(records.some((record) => record.category === "PUBLISH" && record.msg === "success")).toBe(false);
    expect(records.some((record) => record.category === "R2" && record.msg === "put_failed")).toBe(true);
    expect(records.find((record) => record.category === "PUBLISH" && record.msg === "failed")).toMatchObject({ stage: "upload_snapshot" });
  });
});

describe("R2 logs", () => {
  it("records storage failures without secrets or file bytes", async () => {
    const records = collectLogs();
    const storage = instrumentStorage(createMemoryStorage("https://assets.example.test"));
    const key = "media/11111111-1111-1111-1111-111111111111.webp";
    storage.failNext("private", "put", key);

    await expect(
      storage.private.put(key, Buffer.from("image-bytes-should-stay-out"), { contentType: "image/webp", cacheControl: "private" }),
    ).rejects.toThrow(/failed/);

    const failure = records.find((record) => record.category === "R2" && record.msg === "put_failed");
    expect(failure).toMatchObject({ bucket: "private", key, operation: "put" });
    const dump = JSON.stringify(records);
    expect(dump).not.toContain("image-bytes-should-stay-out");
    expect(dump).not.toContain("R2_SECRET");
    expect(dump).not.toMatch(/X-Amz|Signature=/);
  });
});

describe("logging side effects", () => {
  it("does not change publish results when logging is enabled", async () => {
    collectLogs();
    const fake = createFakeRepo();
    const storage = createMemoryStorage();
    const publisher = createPublisher({
      repo: fake.repo,
      storage,
      fallbackImage: "https://creationsbysneha.in/demo/fallback.jpg",
    });
    const card = sampleInvitation(fake, storage);
    const result = await publisher.publish(card.id, "studio@test");
    expect(result.objectKey).toBe("published/saanvi-and-kabir.json");
    expect(result.snapshot.version).toBe(1);
    expect(fake.state.invitations.get(card.id)?.status).toBe("published");
  });
});
