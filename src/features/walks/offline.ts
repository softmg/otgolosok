import { validateWalkView, type WalkView } from "./model";

export const WALK_PACK_CACHE = "walk-packs-v1";
const PACK_ROOT = "/__offline/walks/";
const MAX_PACK_BYTES = 60 * 1024 * 1024;

type OfflineAudio = { chapterId: string; url: string; sha256: string; bytes: number };
export type OfflineWalkManifest = {
  version: 1;
  walkId: string;
  scope: string;
  revision: number;
  contentVersion: string;
  savedAt: string;
  audio: OfflineAudio[];
};
type OfflinePointer = { version: 1; stage: string; manifest: OfflineWalkManifest };
type CachePort = Pick<Cache, "match" | "put" | "delete" | "keys">;

const encode = (value: string) => encodeURIComponent(value);
const root = (scope: string, walkId: string) => `${PACK_ROOT}${encode(scope)}/${encode(walkId)}`;
const pointerKey = (scope: string, walkId: string) => `${root(scope, walkId)}/pointer.json`;
const response = (value: unknown) => new Response(JSON.stringify(value), { headers: { "Content-Type": "application/json" } });

function randomId() {
  return typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function digest(bytes: ArrayBuffer) {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

async function openCache(cache?: CachePort) {
  if (cache) return cache;
  if (!("caches" in globalThis)) throw new Error("Офлайн-сохранение недоступно в этом браузере.");
  return caches.open(WALK_PACK_CACHE);
}

async function removeStage(cache: CachePort, stage: string) {
  const keys = await cache.keys();
  await Promise.all(keys.filter(key => key.url.includes(stage)).map(key => cache.delete(key)));
}

function readPointer(value: unknown): OfflinePointer | null {
  if (!value || typeof value !== "object" || (value as { version?: unknown }).version !== 1 || typeof (value as { stage?: unknown }).stage !== "string") return null;
  const pointer = value as OfflinePointer;
  if (!pointer.manifest || pointer.manifest.version !== 1 || typeof pointer.manifest.walkId !== "string" || typeof pointer.manifest.scope !== "string" ||
      !Number.isSafeInteger(pointer.manifest.revision) || pointer.manifest.revision < 0 || typeof pointer.manifest.contentVersion !== "string" ||
      typeof pointer.manifest.savedAt !== "string" || !Array.isArray(pointer.manifest.audio)) return null;
  return pointer;
}

export async function saveWalkOffline(view: WalkView, scope: string, options: {
  cache?: CachePort;
  fetcher?: typeof fetch;
  now?: () => Date;
  maxBytes?: number;
} = {}) {
  validateWalkView(view);
  if (!scope.trim()) throw new Error("Не удалось определить владельца офлайн-копии.");
  const cache = await openCache(options.cache);
  const fetcher = options.fetcher ?? fetch;
  const maxBytes = options.maxBytes ?? MAX_PACK_BYTES;
  const base = root(scope, view.document.id);
  const stage = `${base}/staging-${randomId()}`;
  const audio = [] as OfflineAudio[];
  const downloaded = new Set<string>();
  let bytesTotal = 0;
  try {
    for (const chapter of view.chapters) {
      if (!chapter.audio || downloaded.has(chapter.audio.url)) continue;
      downloaded.add(chapter.audio.url);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new DOMException("Download timed out", "TimeoutError")), 20_000);
      let result: Response;
      try { result = await fetcher(chapter.audio.url, { signal: controller.signal, cache: "reload" }); }
      finally { clearTimeout(timer); }
      if (!result.ok || result.status !== 200) throw new Error("Не удалось скачать запись для офлайн-прогулки.");
      const declared = Number(result.headers.get("content-length") ?? 0);
      if (declared > 0 && (declared > maxBytes || bytesTotal + declared > maxBytes)) throw new Error("Офлайн-комплект прогулки слишком большой.");
      const body = await result.arrayBuffer();
      bytesTotal += body.byteLength;
      if (bytesTotal > maxBytes || await digest(body) !== chapter.audio.sha256) throw new Error("Запись загрузилась с неверной контрольной суммой.");
      await cache.put(chapter.audio.url, new Response(body, { headers: { "Content-Type": "audio/mpeg", "Content-Length": String(body.byteLength) } }));
      audio.push({ chapterId: chapter.id, url: chapter.audio.url, sha256: chapter.audio.sha256, bytes: body.byteLength });
    }
    const manifest: OfflineWalkManifest = { version: 1, walkId: view.document.id, scope, revision: view.revision, contentVersion: view.contentVersion,
      savedAt: (options.now ?? (() => new Date()))().toISOString(), audio };
    await cache.put(`${stage}/view.json`, response(view));
    await cache.put(`${stage}/manifest.json`, response(manifest));
    const priorResponse = await cache.match(pointerKey(scope, view.document.id));
    const prior = priorResponse ? readPointer(await priorResponse.json().catch(() => null)) : null;
    const pointer: OfflinePointer = { version: 1, stage, manifest };
    await cache.put(pointerKey(scope, view.document.id), response(pointer));
    if (prior && prior.stage !== stage) await removeStage(cache, prior.stage);
    return { manifest, availableAudio: audio.length };
  } catch (error) {
    await removeStage(cache, stage).catch(() => {});
    throw error instanceof Error ? error : new Error("Не удалось сохранить прогулку без сети.");
  }
}

export async function loadOfflineWalk(scope: string, walkId: string, cache?: CachePort): Promise<{ view: WalkView; manifest: OfflineWalkManifest } | null> {
  const storage = await openCache(cache);
  const pointerResponse = await storage.match(pointerKey(scope, walkId));
  const pointer = pointerResponse ? readPointer(await pointerResponse.json().catch(() => null)) : null;
  if (!pointer || pointer.manifest.scope !== scope || pointer.manifest.walkId !== walkId) return null;
  const viewResponse = await storage.match(`${pointer.stage}/view.json`);
  if (!viewResponse) return null;
  try {
    return { view: validateWalkView(await viewResponse.json()), manifest: pointer.manifest };
  } catch {
    return null;
  }
}

export async function removeOfflineWalk(scope: string, walkId: string, cache?: CachePort) {
  const storage = await openCache(cache);
  const pointerResponse = await storage.match(pointerKey(scope, walkId));
  const pointer = pointerResponse ? readPointer(await pointerResponse.json().catch(() => null)) : null;
  await storage.delete(pointerKey(scope, walkId));
  if (pointer) await removeStage(storage, pointer.stage);
}

export async function clearOfflineScope(scope: string, cache?: CachePort) {
  const storage = await openCache(cache);
  const prefix = `${PACK_ROOT}${encode(scope)}/`;
  const keys = await storage.keys();
  await Promise.all(keys.filter(key => key.url.includes(prefix)).map(key => storage.delete(key)));
}

export async function isWalkOffline(scope: string, walkId: string, cache?: CachePort) {
  return Boolean(await loadOfflineWalk(scope, walkId, cache));
}
