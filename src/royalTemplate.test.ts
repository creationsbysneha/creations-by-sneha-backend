import { describe, expect, it } from "vitest";
import { presentInvitation } from "./present.js";
import { buildSnapshot } from "./publicSnapshot.js";
import { createMemoryStorage } from "./storage.js";
import { createFakeRepo } from "./testing/fakeRepo.js";
import { sampleInvitation } from "./testing/sampleGraph.js";
import { referencedMediaIds } from "./store.js";
import { createInvitationSchema, updateSchema } from "./validate.js";

const sample = sampleInvitation(createFakeRepo(), createMemoryStorage());
const assets = new Map(
  [...referencedMediaIds(sample)].map((mediaId) => [mediaId, { mediaId, key: `media/${mediaId}.webp`, url: `https://assets.example.test/media/${mediaId}.webp`, width: 1200, height: 1600 }]),
);
const options = { version: 1, publishedAt: new Date("2026-11-01T10:00:00Z"), assets, fallbackImage: "https://creationsbysneha.in/demo/fallback.jpg" };

function graph() {
  return structuredClone(sample);
}

describe("invitation designs", () => {
  it("keeps classic snapshots exactly as before: classic template and no opening words", () => {
    const snapshot = buildSnapshot(graph(), options);
    expect(snapshot.template).toBe("classic-envelope");
    expect(snapshot.content).not.toHaveProperty("intro");
  });

  it("publishes the Royal design with its opening words", () => {
    const royal = {
      ...graph(),
      template: "royal-wedding",
      introOpening: "Together with their families",
      introRequest: "request the pleasure of your company",
      introOccasion: "at the celebration of their wedding",
      introClosing: "We cordially invite you to celebrate with us",
    };
    const snapshot = buildSnapshot(royal, options);
    expect(snapshot.template).toBe("royal-wedding");
    expect(snapshot.content.intro).toEqual({
      opening: "Together with their families",
      request: "request the pleasure of your company",
      occasion: "at the celebration of their wedding",
      closing: "We cordially invite you to celebrate with us",
    });
  });

  it("treats an unknown stored template as classic", () => {
    expect(buildSnapshot({ ...graph(), template: "something-else" }, options).template).toBe("classic-envelope");
  });

  it("gives the studio the design and opening words to edit", () => {
    const record = presentInvitation({ ...graph(), template: "royal-wedding", introClosing: "Do join us" }, { badge: "" });
    expect(record.template).toBe("royal-wedding");
    expect(record.form.template).toBe("royal-wedding");
    expect(record.form.introClosing).toBe("Do join us");
  });

  it("accepts only the known designs", () => {
    expect(createInvitationSchema.parse({ template: "royal-wedding" }).template).toBe("royal-wedding");
    expect(createInvitationSchema.safeParse({ template: "gothic" }).success).toBe(false);
    expect(updateSchema.parse({ template: "classic-envelope", introOpening: "With joy" })).toMatchObject({ template: "classic-envelope", introOpening: "With joy" });
    expect(updateSchema.safeParse({ introOpening: "x".repeat(161) }).success).toBe(false);
  });
});
