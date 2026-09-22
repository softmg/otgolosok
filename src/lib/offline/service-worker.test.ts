import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(new URL("../../../public/sw.js", import.meta.url), "utf8");
const origin = "https://otgolosok.test";
const assets = ["/", "/create", "/walk", "/_next/static/app.js", "/_next/static/app.css", "/_next/static/font.woff2", "/audio/story.wav"];

function setup() {
  const handlers: Record<string, (event: unknown) => void> = {};
  const entries = new Map<string, Response>(assets.map((path) => [path, new Response(path)]));
  const cache = {
    addAll: vi.fn().mockResolvedValue(undefined),
    match: vi.fn(async (path: string) => entries.get(path)?.clone()),
  };
  const previousEntries = new Map<string, Response>();
  const previousCache = { match: vi.fn(async (path: string) => previousEntries.get(path)?.clone()) };
  const storyEntries = new Map<string, Response>();
  const storyCache = {match: vi.fn(async (path: string)=>storyEntries.get(path)?.clone())};
  const walkEntries = new Map<string, Response>();
  const walkCache = {match: vi.fn(async (path: string)=>walkEntries.get(path)?.clone())};
  const caches = {
    open: vi.fn(async (key: string) => key === "otgolosok-test" ? cache : key === "story-packs-v1" ? storyCache : key === "walk-packs-v1" ? walkCache : previousCache),
    keys: vi.fn(async () => ["otgolosok-v1", "otgolosok-test", "story-packs-v1", "another-app"]),
    delete: vi.fn().mockResolvedValue(true),
  };
  const fetch = vi.fn().mockRejectedValue(new Error("Offline"));
  const clients = { claim: vi.fn().mockResolvedValue(undefined), matchAll: vi.fn().mockResolvedValue([]) };
  const skipWaiting = vi.fn().mockResolvedValue(undefined);
  runInNewContext(script, {
    self: {
      __PRECACHE: { version: "test", assets },
      location: { origin },
      clients,
      skipWaiting,
      addEventListener: (name: string, listener: (event: unknown) => void) => { handlers[name] = listener; },
    },
    caches, fetch, URL, Response, Headers,
    Request: class extends Request {
      constructor(path: string, init?: RequestInit) { super(new URL(path, origin), init); }
    },
  });

  function request(path: string, init?: RequestInit) {
    let response: Promise<Response> | undefined;
    handlers.fetch({
      request: new Request(new URL(path, origin), init),
      respondWith: (value: Promise<Response>) => { response = value; },
    });
    return response;
  }
  function lifecycle(name: string) {
    let completion!: Promise<void>;
    handlers[name]({ waitUntil: (value: Promise<void>) => { completion = value; } });
    return completion;
  }
  function message(type: string, url = `${origin}/update.html`) {
    let completion: Promise<void> | undefined;
    handlers.message({ data: { type }, source: { url }, waitUntil: (value: Promise<void>) => { completion = value; } });
    return completion;
  }
  return { cache, caches, clients, entries, previousEntries, storyEntries, walkEntries, fetch, lifecycle, request, message, skipWaiting };
}

describe("offline service worker", () => {
  it("plays a newly published walk recording offline with byte ranges independently of saved addresses", async () => {
    const { walkEntries, request, fetch } = setup();
    const path = `/api/story-audio/${"a".repeat(64)}.mp3`;
    walkEntries.set(path, new Response("recording", { headers: { "Content-Type": "audio/mpeg" } }));
    const response = await request(path, { headers: { Range: "bytes=2-5" } });
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("cord");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("serves a bundled walk recording stored by a partial user package", async () => {
    const { walkEntries, request, fetch } = setup();
    const path = "/audio/walk/recording.mp3";
    walkEntries.set(path, new Response("recording", { headers: { "Content-Type": "audio/mpeg" } }));
    const response = await request(path, { headers: { Range: "bytes=1-3" } });
    expect(response?.status).toBe(206);
    expect(await response?.text()).toBe("eco");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("installs scripts, styles and fonts before becoming ready", async () => {
    const { cache, lifecycle, skipWaiting } = setup();
    await lifecycle("install");
    expect(cache.addAll).toHaveBeenCalledOnce();
    const requests = cache.addAll.mock.calls[0][0] as Request[];
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual(assets);
    expect(requests.every((request) => request.cache === "reload")).toBe(true);
    expect(skipWaiting).not.toHaveBeenCalled();
  });

  it("does not finish installation when an asset fails to cache", async () => {
    const { cache, lifecycle } = setup();
    cache.addAll.mockRejectedValueOnce(new Error("Missing chunk"));
    await expect(lifecycle("install")).rejects.toThrow("Missing chunk");
  });

  it("removes only old caches owned by this app", async () => {
    const { caches, clients, lifecycle } = setup();
    await lifecycle("activate");
    expect(caches.delete).toHaveBeenCalledExactlyOnceWith("otgolosok-v1");
    expect(clients.claim).toHaveBeenCalledOnce();
  });

  it("preserves previous assets while another tab is still open", async () => {
    const { caches, clients, lifecycle } = setup();
    clients.matchAll.mockResolvedValue([{ url: `${origin}/` }]);
    await lifecycle("activate");
    expect(caches.delete).not.toHaveBeenCalled();
    expect(clients.claim).toHaveBeenCalledOnce();
  });

  it("activates on the recovery page's request, but not on unrelated messages", async () => {
    const { message, skipWaiting } = setup();
    expect(message("OTHER")).toBeUndefined();
    expect(message("ACTIVATE_UPDATE", "https://other.test/update.html")).toBeUndefined();
    expect(message("ACTIVATE_UPDATE", `${origin}/`)).toBeUndefined();
    expect(skipWaiting).not.toHaveBeenCalled();
    await message("ACTIVATE_UPDATE");
    expect(skipWaiting).toHaveBeenCalledOnce();
  });

  it("serves an older tab's immutable chunk offline after explicit activation", async () => {
    const { previousEntries, request, fetch, caches } = setup();
    previousEntries.set("/_next/static/old-chunk.js", new Response("old build"));
    const response = await request("/_next/static/old-chunk.js");
    expect(await response?.text()).toBe("old build");
    expect(fetch).not.toHaveBeenCalled();
    expect(caches.open).not.toHaveBeenCalledWith("another-app");
  });

  it("keeps the recovery page and its assets outside the offline cache", () => {
    const { request } = setup();
    for (const path of ["/update.html", "/update.js", "/update.css"]) {
      expect(request(path)).toBeUndefined();
    }
  });

  it("serves the full shell and query-string navigation without a network", async () => {
    const { request, fetch } = setup();
    for (const path of ["/?replay=clean", "/walk?catalog=paveletskaya", "/walk.html?catalog=paveletskaya", "/walk/", ...assets.slice(1)]) {
      const response = await request(path);
      expect(response?.status).toBe(200);
      expect(await response?.text()).toBe(path.startsWith("/walk") ? "/walk" : new URL(path, origin).pathname);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not intercept unknown pages, external URLs or mutations", () => {
    const { request } = setup();
    expect(request("/missing")).toBeUndefined();
    expect(request("https://other.test/")).toBeUndefined();
    expect(request("/", { method: "POST" })).toBeUndefined();
    expect(request("/api/auth/get-session")).toBeUndefined();
    expect(request("/api/me/walks")).toBeUndefined();
  });

  it("serves the static index URL offline after a version update", async () => {
    const { request, fetch } = setup();
    const response = await request("/index.html?replay=clean");
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("/");
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["bytes=2-5", 206, "2345", "bytes 2-5/10"],
    ["bytes=7-", 206, "789", "bytes 7-9/10"],
    ["bytes=-3", 206, "789", "bytes 7-9/10"],
    ["bytes=8-99", 206, "89", "bytes 8-9/10"],
    ["bytes=20-", 416, "", "bytes */10"],
  ])("serves offline audio range %s", async (range, status, body, contentRange) => {
    const { entries, request } = setup();
    entries.set("/audio/story.wav", new Response("0123456789", { headers: { "Content-Type": "audio/wav" } }));
    const response = await request("/audio/story.wav", { headers: { Range: range } });
    expect(response?.status).toBe(status);
    expect(response?.headers.get("Content-Range")).toBe(contentRange);
    expect(await response?.text()).toBe(body);
  });

  it("opens the generator and a saved result offline, but checks live job status online",async()=>{
    const {storyEntries,request,fetch}=setup();
    const path="/api/story-jobs/00000000-0000-4000-8000-000000000001";
    storyEntries.set(path,new Response('saved ready story'));
    expect(await (await request("/create.html?job=1"))?.text()).toBe("/create");
    expect(await (await request(path))?.text()).toBe("saved ready story");
    fetch.mockResolvedValueOnce(new Response("live status"));
    expect(await (await request(path))?.text()).toBe("live status");
  });

  it("serves saved generated audio ranges without caching creation or retry requests",async()=>{
    const {storyEntries,request,fetch}=setup();
    const path=`/api/story-audio/${"a".repeat(64)}.mp3`;
    storyEntries.set(path,new Response("0123456789",{headers:{"Content-Type":"audio/mpeg"}}));
    const response=await request(path,{headers:{Range:"bytes=2-5"}});
    expect(response?.status).toBe(206);expect(await response?.text()).toBe("2345");
    expect(fetch).not.toHaveBeenCalled();
    expect(request("/api/story-jobs",{method:"POST"})).toBeUndefined();
  });
});
