import { randomUUID } from "node:crypto";
import { CACHE, privateMediaKey } from "../keys.js";
import { sha256 } from "../publishing.js";
import type { MemoryStorage } from "../storage.js";
import type { InvitationGraph, MediaInfo } from "../store.js";
import type { createFakeRepo } from "./fakeRepo.js";

type Fake = ReturnType<typeof createFakeRepo>;

const OLD = new Date("2026-01-01T00:00:00Z");

export function addMedia(fake: Fake, storage: MemoryStorage, ownerInvitationId: string | null, options: { label?: string; status?: string; createdAt?: Date } = {}) {
  const id = randomUUID();
  const bytes = Buffer.from(`RIFF....WEBP ${options.label || id}`);
  const media: MediaInfo = {
    id,
    storageKey: privateMediaKey(id),
    mimeType: "image/webp",
    width: 1600,
    height: 1067,
    byteSize: bytes.length,
    status: options.status || "ready",
    ownerInvitationId,
    purpose: "",
    checksum: sha256(bytes),
    createdAt: options.createdAt || OLD,
  };
  fake.edit((state) => state.media.set(id, media));
  storage.objects.private.set(media.storageKey, {
    body: bytes,
    options: { contentType: "image/webp", cacheControl: CACHE.privateMedia },
    lastModified: options.createdAt || OLD,
  });
  return media;
}

export function sampleInvitation(fake: Fake, storage: MemoryStorage, slug = "saanvi-and-kabir"): InvitationGraph {
  const id = randomUUID();
  const hero = addMedia(fake, storage, id, { label: "hero" });
  const envelope = addMedia(fake, storage, id, { label: "envelope" });
  const venue = addMedia(fake, storage, id, { label: "venue" });
  const gallery = [1, 2, 3].map((index) => addMedia(fake, storage, id, { label: `gallery-${index}` }));
  const ceremony = addMedia(fake, storage, id, { label: "ceremony-1" });
  const updatedAt = new Date("2026-10-18T10:00:00Z");

  const graph: InvitationGraph = {
    id,
    slug,
    title: "Saanvi & Kabir | Sample Wedding Invitation",
    template: "classic-envelope",
    status: "draft",
    description: "A sample digital wedding invitation for Saanvi and Kabir.",
    brideName: "Saanvi",
    brideFull: "Saanvi Malhotra",
    brideParents: "Daughter of Smt. Nandini & Shri Vikram Malhotra",
    brideGrandparents: "Granddaughter of Smt. Lata & Shri Devendra Malhotra",
    groomName: "Kabir",
    groomFull: "Kabir Sethi",
    groomParents: "Son of Smt. Pooja & Shri Rohan Sethi",
    groomGrandparents: "Grandson of Smt. Savitri & Shri Harish Sethi",
    families: "The Malhotra & Sethi families",
    blessing: "",
    complimentOne: "Smt. Nandini Malhotra",
    complimentTwo: "Shri Vikram Malhotra",
    rsvpFamily: "Malhotra Family",
    cousinsLabel: "The Sethi cousins",
    cousins: "Kunal Sethi, Neel Sethi, Riya Sethi & Aditya Sethi",
    weddingAt: new Date("2027-02-12T00:00:00+05:30"),
    expiresAt: null,
    venueName: "The Amber Pavilion",
    venueAddress1: "Amber Road",
    venueAddress2: "Jaipur",
    venueNote: "Illustrative venue for this sample invitation",
    mapEmbed: "https://www.google.com/maps?output=embed&q=Amber%20Fort%2C%20Jaipur%2C%20Rajasthan",
    directionsUrl: "https://www.google.com/maps/search/?api=1&query=Amber%20Fort%20Jaipur",
    rsvpMode: "local-demo",
    isDemo: false,
    theme: { accent: "gold", paper: "cream", script: "great-vibes" },
    guessOptions: [
      { id: "S", label: "Saanvi" },
      { id: "K", label: "Kabir" },
      { id: "B", label: "Both" },
    ],
    createdAt: updatedAt,
    updatedAt,
    publishedAt: null,
    publishedVersion: 0,
    publishedSlug: null,
    publishedKey: null,
    events: [
      {
        id: randomUUID(),
        invitationId: id,
        sortOrder: 0,
        title: "Parampara & Pratishtha",
        subtitle: "Lagun & Shiv Vivah",
        dateLabel: "Monday, 8th February 2027",
        venue: "The Malhotra residence",
        description: "",
        imageAlt: "Bride and groom holding hands under a floral mandap",
        details: [{ time: "2:00 PM onwards" }],
        mediaId: ceremony.id,
        media: null,
      },
      {
        id: randomUUID(),
        invitationId: id,
        sortOrder: 1,
        title: "Bheegi Palken",
        subtitle: "From celebration to farewell",
        dateLabel: "Saturday, 13th February 2027",
        venue: "The Malhotra residence",
        description: "",
        imageAlt: "",
        details: [{ label: "Vidaai", time: "Early morning" }],
        mediaId: null,
        media: null,
      },
    ],
    mediaLinks: [
      { id: randomUUID(), invitationId: id, mediaId: hero.id, role: "hero", sortOrder: 0, alt: "", media: hero },
      { id: randomUUID(), invitationId: id, mediaId: envelope.id, role: "envelope", sortOrder: 0, alt: "", media: envelope },
      { id: randomUUID(), invitationId: id, mediaId: venue.id, role: "venue", sortOrder: 0, alt: "", media: venue },
      ...gallery.map((media, index) => ({
        id: randomUUID(),
        invitationId: id,
        mediaId: media.id,
        role: "gallery",
        sortOrder: index,
        alt: `Gallery photograph ${index + 1}`,
        media,
      })),
    ],
  };
  fake.edit((state) => state.invitations.set(id, graph));
  return graph;
}
