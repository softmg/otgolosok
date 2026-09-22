// The build injects exported assets, including hashed chunks and fonts.
const { version, assets } = self.__PRECACHE ?? { version: "development", assets: [] };
const CACHE_PREFIX = "otgolosok-";
const CACHE_VERSION = `${CACHE_PREFIX}${version}`;
const APP_SHELL = new Set(assets);
const STORY_CACHE = "story-packs-v1";
const WALK_CACHE = "walk-packs-v1";

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    if (!assets.length) throw new Error("Build the app before registering its Service Worker.");
    const cache = await caches.open(CACHE_VERSION);
    await cache.addAll(assets.map((url) => new Request(url, { cache: "reload" })));
  })());
  // Updates wait until existing walks close, keeping HTML and chunks in sync.
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    // An explicit update can leave another tab on its previous build. Keep its
    // immutable assets until a later activation with no open windows.
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    if (!windows.length) {
      const keys = await caches.keys();
      await Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION)
        .map((key) => caches.delete(key)));
    }
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "ACTIVATE_UPDATE" || !event.source?.url) return;
  const sender = new URL(event.source.url);
  if (sender.origin !== self.location.origin || sender.pathname !== "/update.html") return;
  event.waitUntil(self.skipWaiting());
});

async function cachedResponse(request, path) {
  const cache = await caches.open(CACHE_VERSION);
  let cached = await cache.match(path);
  if (!cached && path.startsWith("/audio/")) {
    cached = await (await caches.open(WALK_CACHE)).match(path);
  }
  if (!cached && /^\/(?:_next\/static|audio)\//.test(path)) {
    const keys = (await caches.keys()).filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_VERSION);
    for (const key of keys.reverse()) {
      cached = await (await caches.open(key)).match(path);
      if (cached) break;
    }
  }
  if (!cached) return fetch(request);

  return audioRange(request, cached, path.startsWith("/audio/"));
}

async function audioRange(request, cached, isAudio) {
  const range = request.headers.get("range");
  if (!range || !isAudio) return cached;

  // Audio players request byte ranges even when the complete file is offline.
  const match = /^bytes=(\d*)-(\d*)$/.exec(range);
  if (!match || (!match[1] && !match[2])) return cached;
  const bytes = await cached.arrayBuffer();
  const start = match[1] ? Number(match[1]) : Math.max(0, bytes.byteLength - Number(match[2]));
  const end = match[1] && match[2]
    ? Math.min(Number(match[2]), bytes.byteLength - 1)
    : bytes.byteLength - 1;

  if (start > end || start >= bytes.byteLength) {
    return new Response(null, {
      status: 416,
      headers: { "Content-Range": `bytes */${bytes.byteLength}` },
    });
  }

  const headers = new Headers(cached.headers);
  headers.set("Content-Range", `bytes ${start}-${end}/${bytes.byteLength}`);
  headers.set("Content-Length", String(end - start + 1));
  headers.set("Accept-Ranges", "bytes");
  return new Response(bytes.slice(start, end + 1), { status: 206, headers });
}

async function savedStoryResponse(request, path, audio) {
  const cache = await caches.open(STORY_CACHE);
  if (audio) {
    const cached = await cache.match(path) ?? await (await caches.open(WALK_CACHE)).match(path);
    return cached ? audioRange(request,cached,true) : fetch(request);
  }
  // Jobs always use live status online; only a complete explicitly saved story
  // can be used when the connection fails. Never cache transient job states.
  try {return await fetch(request);}
  catch(error) {const cached=await cache.match(path);if(cached)return cached;throw error;}
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.headers.has("authorization") || /^\/admin(?:\/|\.|$)/.test(url.pathname) || url.pathname.startsWith("/api/story-admin")) return;
  const path = url.pathname === "/index.html" ? "/" : ["/create.html","/create/"].includes(url.pathname) ? "/create" : ["/walk.html","/walk/"].includes(url.pathname) ? "/walk" : ["/history.html","/history/"].includes(url.pathname) ? "/history" : url.pathname;
  if (path.startsWith("/api/auth/") || path === "/api/me" || path.startsWith("/api/me/")) return;
  if (/^\/api\/story-(?:jobs\/[a-f0-9-]{36}|audio\/[a-f0-9]{64}\.mp3)$/.test(path)) {
    event.respondWith(savedStoryResponse(request,path,path.startsWith("/api/story-audio/")));
    return;
  }
  // Unknown routes and error pages must never overwrite the home page.
  if (!APP_SHELL.has(path) && !/^\/(?:_next\/static|audio)\//.test(path)) return;
  event.respondWith(cachedResponse(request, path));
});
