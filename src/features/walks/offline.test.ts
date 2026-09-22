import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { WalkView } from "./model";
import { loadOfflineWalk, saveWalkOffline } from "./offline";

class MemoryCache {
  entries = new Map<string, Response>();
  key(key: RequestInfo) { return typeof key === "string" ? key : new URL(key.url).pathname; }
  async match(key: RequestInfo) { return this.entries.get(this.key(key))?.clone(); }
  async put(key: RequestInfo, value: Response) { this.entries.set(this.key(key), value.clone()); }
  async delete(key: RequestInfo) { return this.entries.delete(this.key(key)); }
  async keys() { return [...this.entries.keys()].map(key => new Request(`https://offline.test${key}`)); }
}

const audioBody = new TextEncoder().encode("audio bytes");
const audioHash = "ef71589075ccf9332917b0d8d711d1a8d205560f96842f9221de70e6c29454e0";
const view: WalkView = {
  document: { version: 2, id: "11111111-1111-4111-8111-111111111111", title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30,
    start: { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stops: [{ id: "22222222-2222-4222-8222-222222222222", place: { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } }, storyRef: null, transition: "", nextHint: "" }], route: null, fieldChecked: false },
  revision: 1, contentVersion: "version-1", chapters: [{ id: "22222222-2222-4222-8222-222222222222", status: "ready", story: { title: "Дом", address: "Москва, Арбат, 10", paragraphs: [{ text: "История дома.", factIds: [] }], sources: [], facts: [] }, audio: { url: `/api/story-audio/${audioHash}.mp3`, sha256: audioHash, durationSec: 12 } }],
};

async function sha256(bytes: Uint8Array) {
  const digest = await webcrypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

describe("офлайн-комплект прогулки", () => {
  it("публикует указатель только после проверки записи и разделяет владельцев", async () => {
    const cache = new MemoryCache();
    const saved = await saveWalkOffline(view, "user-one", { cache, fetcher: vi.fn(async () => new Response(audioBody, { status: 200, headers: { "Content-Type": "audio/mpeg", "Content-Length": String(audioBody.byteLength) } })), now: () => new Date("2026-09-21T12:00:00Z") });
    expect(saved.availableAudio).toBe(1);
    expect(await sha256(audioBody)).toBe(audioHash);
    expect((await loadOfflineWalk("user-one", view.document.id, cache))?.manifest.scope).toBe("user-one");
    expect(await loadOfflineWalk("user-two", view.document.id, cache)).toBeNull();
  });

  it("keeps the previous package when a replacement download is invalid", async () => {
    const cache = new MemoryCache();
    const validView = { ...view, chapters: view.chapters.map(chapter => ({ ...chapter, audio: chapter.audio && { ...chapter.audio, url: "/audio/walk/recording.mp3" } })) };
    await saveWalkOffline(validView, "user-one", { cache, fetcher: vi.fn(async () => new Response(audioBody, { status: 200, headers: { "Content-Type": "audio/mpeg" } })) });
    const broken = { ...validView, revision: 2, contentVersion: "version-2" };
    await expect(saveWalkOffline(broken, "user-one", { cache, fetcher: vi.fn(async () => new Response("wrong", { status: 200 })) })).rejects.toThrow("контрольной суммой");
    expect((await loadOfflineWalk("user-one", validView.document.id, cache))?.manifest.revision).toBe(1);
  });
});
