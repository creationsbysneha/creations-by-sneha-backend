import { randomUUID } from "node:crypto";
import type { CleanupSource } from "../cleanup.js";
import type { PublicationRecord, PublishRepo, PublishTx } from "../publishing.js";
import type { InvitationGraph, LogEntry, MediaInfo } from "../store.js";

type Publication = PublicationRecord & { state: "active" | "withdrawn"; actor: string };

export type FakeState = {
  invitations: Map<string, InvitationGraph>;
  media: Map<string, MediaInfo>;
  publications: Publication[];
  productMedia: Set<string>;
};

type TxMethod = keyof PublishTx | "commit";

export function createFakeRepo() {
  let state: FakeState = { invitations: new Map(), media: new Map(), publications: [], productMedia: new Set() };
  const logs: LogEntry[] = [];
  const failures: TxMethod[] = [];
  const chains = new Map<string, Promise<unknown>>();
  const lockOrder: string[] = [];

  const clone = (value: FakeState): FakeState => structuredClone(value);
  const maybeFail = (method: TxMethod) => {
    const index = failures.indexOf(method);
    if (index >= 0) {
      failures.splice(index, 1);
      throw new Error(`simulated ${method} failure`);
    }
  };

  const used = (draft: FakeState, mediaId: string) => {
    for (const invitation of draft.invitations.values()) {
      if (invitation.mediaLinks.some((link) => link.mediaId === mediaId)) return true;
      if (invitation.events.some((event) => event.mediaId === mediaId)) return true;
    }
    return draft.productMedia.has(mediaId) || draft.publications.some((item) => item.state === "active" && item.mediaIds.includes(mediaId));
  };

  const tx = (draft: FakeState): PublishTx => ({
    async loadGraph(id) {
      maybeFail("loadGraph");
      const graph = draft.invitations.get(id);
      if (!graph) return null;
      const withMedia = (mediaId: string | null) => (mediaId ? draft.media.get(mediaId) || null : null);
      return {
        ...graph,
        events: graph.events.map((event) => ({ ...event, media: withMedia(event.mediaId) })),
        mediaLinks: graph.mediaLinks.map((link) => ({ ...link, media: withMedia(link.mediaId) as MediaInfo })),
      };
    },
    async slugTaken(slug, except) {
      maybeFail("slugTaken");
      return [...draft.invitations.values()].some((item) => item.id !== except && (item.slug === slug || item.publishedSlug === slug));
    },
    async activePublication(invitationId) {
      maybeFail("activePublication");
      const found = draft.publications.filter((item) => item.invitationId === invitationId && item.state === "active").sort((a, b) => b.version - a.version)[0];
      return found ? { ...found } : null;
    },
    async findMedia(mediaId) {
      maybeFail("findMedia");
      return draft.media.get(mediaId) || null;
    },
    async setMediaChecksum(mediaId, checksum) {
      maybeFail("setMediaChecksum");
      const media = draft.media.get(mediaId);
      if (media) media.checksum = checksum;
    },
    async recordPublication(publication) {
      maybeFail("recordPublication");
      draft.publications.forEach((item) => {
        if (item.invitationId === publication.invitationId) item.state = "withdrawn";
      });
      draft.publications.push({ ...publication, id: randomUUID(), state: "active" });
      const invitation = draft.invitations.get(publication.invitationId);
      if (invitation) {
        Object.assign(invitation, {
          status: "published",
          publishedVersion: publication.version,
          publishedSlug: publication.slug,
          publishedKey: publication.objectKey,
          publishedAt: publication.publishedAt,
          updatedAt: publication.publishedAt,
        });
      }
    },
    async recordWithdrawal(invitationId, at) {
      maybeFail("recordWithdrawal");
      draft.publications.forEach((item) => {
        if (item.invitationId === invitationId) item.state = "withdrawn";
      });
      const invitation = draft.invitations.get(invitationId);
      if (invitation) Object.assign(invitation, { status: "draft", publishedSlug: null, publishedKey: null, updatedAt: at });
    },
    async deleteInvitation(invitationId) {
      maybeFail("deleteInvitation");
      draft.publications.forEach((item) => {
        if (item.invitationId === invitationId) item.state = "withdrawn";
      });
      draft.invitations.delete(invitationId);
    },
    async mediaInUse(mediaId) {
      maybeFail("mediaInUse");
      return used(draft, mediaId);
    },
    async deleteMedia(mediaId) {
      maybeFail("deleteMedia");
      if (used(draft, mediaId)) throw new Error("foreign key violation: media still referenced");
      draft.media.delete(mediaId);
    },
    async keyIsLive(key) {
      maybeFail("keyIsLive");
      return draft.publications.some((item) => item.state === "active" && (item.objectKey === key || item.assetKeys.includes(key)));
    },
  });

  const repo: PublishRepo = {
    async locked(key, fn) {
      const previous = chains.get(key) || Promise.resolve();
      const run = previous.catch(() => undefined).then(async () => {
        lockOrder.push(key);
        const draft = clone(state);
        const result = await fn(tx(draft));
        maybeFail("commit");
        state = draft;
        return result;
      });
      chains.set(key, run.catch(() => undefined));
      return run;
    },
    async log(entry) {
      logs.push(entry);
    },
  };

  const source: CleanupSource = {
    async staleMedia(before) {
      return [...state.media.values()].filter((item) => item.createdAt < before);
    },
    async mediaById(ids) {
      return new Map(ids.flatMap((id) => (state.media.has(id) ? [[id, state.media.get(id) as MediaInfo] as const] : [])));
    },
    async invitationIdForSlug(slug) {
      return [...state.invitations.values()].find((item) => item.slug === slug || item.publishedSlug === slug)?.id || null;
    },
  };

  return {
    repo,
    source,
    logs,
    lockOrder,
    get state() {
      return state;
    },
    edit(fn: (draft: FakeState) => void) {
      fn(state);
    },
    failNext(method: TxMethod) {
      failures.push(method);
    },
  };
}
