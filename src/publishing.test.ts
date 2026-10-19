import { describe, expect, it, vi } from "vitest";
import { runCleanup } from "./cleanup.js";
import { CACHE, isPublicMediaKey, privateMediaKey } from "./keys.js";
import { snapshotSchema, type PublishedSnapshot } from "./publicSnapshot.js";
import { createPublisher, PublishError } from "./publishing.js";
import { createMemoryStorage } from "./storage.js";
import { createFakeRepo } from "./testing/fakeRepo.js";
import { addMedia, sampleInvitation } from "./testing/sampleGraph.js";

const PUBLIC = "https://assets.example.test";
const FALLBACK = "https://creationsbysneha.in/demo/fallback.jpg";

function setup(options: { purge?: (urls: string[]) => Promise<void> } = {}) {
  const fake = createFakeRepo();
  const storage = createMemoryStorage(PUBLIC);
  let clock = new Date("2026-10-18T12:00:00Z").getTime();
  const publisher = createPublisher({
    repo: fake.repo,
    storage,
    fallbackImage: FALLBACK,
    purge: options.purge,
    now: () => new Date((clock += 1000)),
  });
  return { fake, storage, publisher };
}

const liveJson = (storage: ReturnType<typeof createMemoryStorage>, key: string) => {
  const entry = storage.objects.public.get(key);
  return entry ? (JSON.parse(entry.body.toString("utf8")) as PublishedSnapshot) : null;
};

describe("publishing", () => {
  it("publishes a valid snapshot with permanent public image URLs", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);

    const result = await publisher.publish(card.id, "studio@test");

    expect(result.objectKey).toBe("published/saanvi-and-kabir.json");
    const json = liveJson(storage, result.objectKey);
    expect(snapshotSchema.parse(json)).toBeTruthy();
    expect(json?.version).toBe(1);
    expect(json?.content.couple.pair).toBe("Saanvi & Kabir");
    expect(json?.content.images.hero.startsWith(`${PUBLIC}/media/`)).toBe(true);
    expect(json?.content.ceremonies[1].image).toBe(FALLBACK);
    expect(JSON.stringify(json)).not.toMatch(/X-Amz|Signature=|\/api\/media\/|localhost:4000/);
    expect(JSON.stringify(json?.content)).not.toMatch(/mediaId/);
    expect(json?.assets).toHaveLength(7);

    const snapshotEntry = storage.objects.public.get(result.objectKey);
    expect(snapshotEntry?.options.cacheControl).toBe(CACHE.snapshot);
    const imageKeys = [...storage.objects.public.keys()].filter(isPublicMediaKey);
    expect(imageKeys).toHaveLength(7);
    imageKeys.forEach((key) => expect(storage.objects.public.get(key)?.options.cacheControl).toBe(CACHE.publicMedia));

    const stored = fake.state.invitations.get(card.id);
    expect(stored?.status).toBe("published");
    expect(stored?.publishedVersion).toBe(1);
    expect(stored?.publishedAt?.getTime()).toBe(stored?.updatedAt.getTime());
  });

  it("refuses to publish an incomplete card and writes nothing", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    fake.edit((state) => Object.assign(state.invitations.get(card.id)!, { venueName: "" }));

    await expect(publisher.publish(card.id, "studio@test")).rejects.toMatchObject({ status: 400 });
    expect([...storage.objects.public.keys()]).toEqual([]);
  });

  it("refuses to publish while a photograph is still pending or missing", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    const heroId = card.mediaLinks[0].mediaId;
    fake.edit((state) => (state.media.get(heroId)!.status = "pending"));
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 400 });

    fake.edit((state) => (state.media.get(heroId)!.status = "ready"));
    storage.objects.private.delete(privateMediaKey(heroId));
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 400 });
    expect([...storage.objects.public.keys()].some((key) => key.endsWith(".json"))).toBe(false);
  });

  it("refuses a photograph whose bytes no longer match the checksum", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    const key = privateMediaKey(card.mediaLinks[0].mediaId);
    storage.objects.private.get(key)!.body = Buffer.from("tampered");
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 409 });
  });

  it("keeps the previous live JSON when the JSON upload fails", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const before = storage.objects.public.get("published/saanvi-and-kabir.json")!.body.toString();

    fake.edit((state) => (state.invitations.get(card.id)!.title = "Changed title"));
    storage.failNext("public", "put", "published/saanvi-and-kabir.json");
    await expect(publisher.publish(card.id, "a")).rejects.toBeInstanceOf(PublishError);

    expect(storage.objects.public.get("published/saanvi-and-kabir.json")!.body.toString()).toBe(before);
    expect(fake.state.invitations.get(card.id)?.publishedVersion).toBe(1);
    expect(fake.logs.some((log) => log.action === "invitation.publish" && !log.ok)).toBe(true);
  });

  it("restores the previous live JSON when the database write fails after upload", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const before = liveJson(storage, "published/saanvi-and-kabir.json");

    fake.edit((state) => (state.invitations.get(card.id)!.brideName = "Sanvi"));
    fake.failNext("recordPublication");
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 502 });

    expect(liveJson(storage, "published/saanvi-and-kabir.json")).toEqual(before);
    expect(fake.state.publications.filter((item) => item.state === "active")).toHaveLength(1);
  });

  it("restores the previous live JSON when the transaction fails to commit", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const before = liveJson(storage, "published/saanvi-and-kabir.json");

    fake.edit((state) => (state.invitations.get(card.id)!.brideName = "Sanvi"));
    fake.failNext("commit");
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 502 });
    expect(liveJson(storage, "published/saanvi-and-kabir.json")).toEqual(before);
    expect(fake.state.invitations.get(card.id)?.publishedVersion).toBe(1);
  });

  it("removes the new JSON when a first publish fails in the database", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    fake.failNext("recordPublication");
    await expect(publisher.publish(card.id, "a")).rejects.toMatchObject({ status: 502 });
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(false);
    expect(fake.state.invitations.get(card.id)?.status).toBe("draft");
  });

  it("republishes with a new version and reuses unchanged image objects", async () => {
    const purge = vi.fn(async () => undefined);
    const { fake, storage, publisher } = setup({ purge });
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const puts = () => storage.calls.filter((call) => call.kind === "public" && call.operation === "put" && isPublicMediaKey(call.key)).length;
    const imagePuts = puts();

    fake.edit((state) => (state.invitations.get(card.id)!.venueNote = "Updated note"));
    const second = await publisher.publish(card.id, "a");

    expect(second.snapshot.version).toBe(2);
    expect(liveJson(storage, second.objectKey)?.content.venue.note).toBe("Updated note");
    expect(puts()).toBe(imagePuts);
    expect(fake.state.publications.map((item) => item.state)).toEqual(["withdrawn", "active"]);
    expect(purge).toHaveBeenLastCalledWith([`${PUBLIC}/published/saanvi-and-kabir.json`]);
  });

  it("never overwrites bytes at an existing image URL when a photograph is replaced", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    const first = await publisher.publish(card.id, "a");
    const oldHero = first.snapshot.content.images.hero;
    const oldBytes = storage.objects.public.get(oldHero.replace(`${PUBLIC}/`, ""))!.body.toString();

    const replacement = addMedia(fake, storage, card.id, { label: "new hero" });
    const oldHeroId = card.mediaLinks[0].mediaId;
    fake.edit((state) => {
      const stored = state.invitations.get(card.id)!;
      stored.mediaLinks[0] = { ...stored.mediaLinks[0], mediaId: replacement.id, media: replacement };
    });
    const second = await publisher.publish(card.id, "a");

    expect(second.snapshot.content.images.hero).not.toBe(oldHero);
    expect(storage.objects.public.get(oldHero.replace(`${PUBLIC}/`, ""))!.body.toString()).toBe(oldBytes);
    expect(second.dropped).toEqual([oldHeroId]);
    expect(fake.state.media.has(oldHeroId)).toBe(false);
    expect(storage.objects.private.has(privateMediaKey(oldHeroId))).toBe(false);
  });

  it("moves the live JSON when the link changes and frees the old link", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    fake.edit((state) => (state.invitations.get(card.id)!.slug = "saanvi-weds-kabir"));

    const result = await publisher.publish(card.id, "a");
    expect(result.objectKey).toBe("published/saanvi-weds-kabir.json");
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(false);
    expect(fake.state.invitations.get(card.id)?.publishedSlug).toBe("saanvi-weds-kabir");
  });

  it("puts the old link back when a link change fails in the database", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const before = liveJson(storage, "published/saanvi-and-kabir.json");
    fake.edit((state) => (state.invitations.get(card.id)!.slug = "saanvi-weds-kabir"));
    fake.failNext("recordPublication");

    await expect(publisher.publish(card.id, "a")).rejects.toBeInstanceOf(PublishError);
    expect(liveJson(storage, "published/saanvi-and-kabir.json")).toEqual(before);
    expect(storage.objects.public.has("published/saanvi-weds-kabir.json")).toBe(false);
  });

  it("will not publish over a link another card still holds", async () => {
    const { fake, storage, publisher } = setup();
    const first = sampleInvitation(fake, storage);
    await publisher.publish(first.id, "a");
    fake.edit((state) => (state.invitations.get(first.id)!.slug = "renamed-draft"));
    const second = sampleInvitation(fake, storage, "saanvi-and-kabir");

    await expect(publisher.publish(second.id, "a")).rejects.toMatchObject({ status: 409 });
  });

  it("serializes concurrent publishes of the same card", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    const results = await Promise.all([publisher.publish(card.id, "a"), publisher.publish(card.id, "b")]);
    expect(results.map((item) => item.snapshot.version).sort()).toEqual([1, 2]);
    expect(fake.state.publications.filter((item) => item.state === "active")).toHaveLength(1);
    expect(liveJson(storage, "published/saanvi-and-kabir.json")?.version).toBe(2);
  });
});

describe("unpublish and delete", () => {
  it("removes the live JSON and keeps image objects", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    await publisher.unpublish(card.id, "a");
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(false);
    expect([...storage.objects.public.keys()].filter(isPublicMediaKey)).toHaveLength(7);
    expect(fake.state.invitations.get(card.id)?.status).toBe("draft");
    expect(fake.state.media.size).toBe(7);
  });

  it("leaves the card live when the JSON delete fails", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    storage.failNext("public", "delete", "published/saanvi-and-kabir.json");
    await expect(publisher.unpublish(card.id, "a")).rejects.toMatchObject({ status: 502 });
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(true);
    expect(fake.state.invitations.get(card.id)?.status).toBe("published");
  });

  it("puts the JSON back when the withdrawal fails in the database", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    fake.failNext("recordWithdrawal");
    await expect(publisher.unpublish(card.id, "a")).rejects.toBeInstanceOf(PublishError);
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(true);
    expect(fake.state.invitations.get(card.id)?.status).toBe("published");
  });

  it("deletes a card, its live JSON, and its private photographs", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    await publisher.deleteInvitation(card.id, "a");
    expect(fake.state.invitations.has(card.id)).toBe(false);
    expect(storage.objects.public.has("published/saanvi-and-kabir.json")).toBe(false);
    expect(fake.state.media.size).toBe(0);
    expect(storage.objects.private.size).toBe(0);
  });
});

describe("photograph lifecycle", () => {
  it("keeps a photograph removed from the draft while the live version still shows it", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    const galleryId = card.mediaLinks[3].mediaId;
    fake.edit((state) => {
      const stored = state.invitations.get(card.id)!;
      stored.mediaLinks = stored.mediaLinks.filter((link) => link.mediaId !== galleryId);
    });

    expect(await publisher.releaseMedia([galleryId])).toEqual([]);
    expect(fake.state.media.has(galleryId)).toBe(true);

    await publisher.publish(card.id, "a");
    expect(fake.state.media.has(galleryId)).toBe(false);
    expect(storage.objects.private.has(privateMediaKey(galleryId))).toBe(false);
  });

  it("never releases a photograph a product still uses", async () => {
    const { fake, storage, publisher } = setup();
    const media = addMedia(fake, storage, null);
    fake.edit((state) => state.productMedia.add(media.id));
    expect(await publisher.releaseMedia([media.id])).toEqual([]);
    expect(storage.objects.private.has(media.storageKey)).toBe(true);
  });

  it("keeps the row when the private object delete fails, so cleanup can retry", async () => {
    const { fake, storage, publisher } = setup();
    const media = addMedia(fake, storage, null);
    storage.failNext("private", "delete", media.storageKey);
    expect(await publisher.releaseMedia([media.id])).toEqual([]);
    expect(fake.state.media.has(media.id)).toBe(false);
    expect(storage.objects.private.has(media.storageKey)).toBe(true);
    expect(fake.logs.some((log) => log.action === "media.release" && !log.ok)).toBe(true);
  });
});

describe("cleanup", () => {
  const now = new Date("2026-10-20T00:00:00Z");

  it("reports but deletes nothing on a dry run", async () => {
    const { fake, storage } = setup();
    addMedia(fake, storage, null);
    const report = await runCleanup({ repo: fake.repo, storage, source: fake.source, apply: false, graceHours: 48, actor: "t", now });
    expect(report.mediaRows.unused).toHaveLength(1);
    expect(report.deleted).toBe(0);
    expect(fake.state.media.size).toBe(1);
    expect(storage.objects.private.size).toBe(1);
  });

  it("never touches live JSON, live images, or recent uploads", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    for (const entry of storage.objects.public.values()) entry.lastModified = new Date("2026-01-01T00:00:00Z");
    const fresh = addMedia(fake, storage, null, { createdAt: new Date("2026-10-19T23:00:00Z") });

    const report = await runCleanup({ repo: fake.repo, storage, source: fake.source, apply: true, graceHours: 48, actor: "t", now });

    expect(report.errors).toEqual([]);
    expect(report.deleted).toBe(0);
    expect(storage.objects.public.size).toBe(8);
    expect(fake.state.media.has(fresh.id)).toBe(true);
  });

  it("removes stale pending rows, orphaned objects, and withdrawn public copies", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    await publisher.unpublish(card.id, "a");
    for (const entry of storage.objects.public.values()) entry.lastModified = new Date("2026-01-01T00:00:00Z");
    const pending = addMedia(fake, storage, card.id, { status: "pending" });
    const orphanKey = privateMediaKey("00000000-0000-4000-8000-000000000001");
    storage.objects.private.set(orphanKey, { body: Buffer.from("x"), options: { contentType: "image/webp", cacheControl: CACHE.privateMedia }, lastModified: new Date("2026-01-01T00:00:00Z") });

    const report = await runCleanup({ repo: fake.repo, storage, source: fake.source, apply: true, graceHours: 48, actor: "t", now });

    expect(report.mediaRows.pending).toEqual([pending.id]);
    expect(report.privateObjects).toEqual([orphanKey]);
    expect(report.publicAssets).toHaveLength(7);
    expect(storage.objects.private.has(orphanKey)).toBe(false);
    expect(storage.objects.private.has(pending.storageKey)).toBe(false);
    expect(fake.state.media.size).toBe(7);
    expect(storage.objects.public.size).toBe(0);
  });

  it("skips a public copy that becomes live between the scan and the delete", async () => {
    const { fake, storage, publisher } = setup();
    const card = sampleInvitation(fake, storage);
    await publisher.publish(card.id, "a");
    await publisher.unpublish(card.id, "a");
    for (const entry of storage.objects.public.values()) entry.lastModified = new Date("2026-01-01T00:00:00Z");

    const original = fake.repo.locked.bind(fake.repo);
    let republished = false;
    fake.repo.locked = async (key, fn) => {
      if (!republished && key === card.id && fake.state.invitations.get(card.id)?.status === "draft") {
        const calls = storage.calls.filter((call) => call.operation === "list").length;
        if (calls >= 3) {
          republished = true;
          await publisher.publish(card.id, "a");
        }
      }
      return original(key, fn);
    };

    const report = await runCleanup({ repo: fake.repo, storage, source: fake.source, apply: true, graceHours: 48, actor: "t", now });
    expect(republished).toBe(true);
    const live = liveJson(storage, "published/saanvi-and-kabir.json")!;
    for (const asset of live.assets) expect(storage.objects.public.has(asset.url.replace(`${PUBLIC}/`, ""))).toBe(true);
    expect(report.errors).toEqual([]);
  });
});
