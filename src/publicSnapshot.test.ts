import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { snapshotSchema } from "./publicSnapshot.js";

const fixturePath = path.resolve("fixtures/published-invitation.v1.json");
const frontendCopy = path.resolve("../creations-by-sneha-frontend/src/invitation/fixtures/published-invitation.v1.json");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));

describe("published snapshot contract", () => {
  it("accepts the shared version 1 fixture", () => {
    expect(snapshotSchema.parse(fixture)).toEqual(fixture);
  });

  it.runIf(existsSync(frontendCopy))("matches the copy the frontend validates", () => {
    expect(JSON.parse(readFileSync(frontendCopy, "utf8"))).toEqual(fixture);
  });

  it("rejects relative, signed, or private image URLs", () => {
    const relative = structuredClone(fixture);
    relative.content.images.hero = "/demo/hero.jpg";
    expect(snapshotSchema.safeParse(relative).success).toBe(false);

    const signed = structuredClone(fixture);
    signed.content.images.hero = "https://bucket.example.com/x.webp?X-Amz-Signature=abc";
    expect(snapshotSchema.safeParse(signed).success).toBe(false);
  });

  it("rejects unknown fields and a future schema version", () => {
    expect(snapshotSchema.safeParse({ ...fixture, draftNotes: "secret" }).success).toBe(false);
    expect(snapshotSchema.safeParse({ ...fixture, schemaVersion: 2 }).success).toBe(false);
  });
});
