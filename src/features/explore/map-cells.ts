import type { CatalogBounds } from "./catalog-bounds";
import { RequestError, fetchWithRetry } from "../walk-builder/request";

/** Wire format of one slim map point (`GET /api/content/map-cells/{lat}/{lon}`). */
export type MapPoint = { id: string; lat: number; lon: number; title: string; address: string; durationSec: number | null; facts: number; sources: number };
export type CatalogPoint = {
  id: string; location: { lat: number; lon: number }; title: string; address: string;
  durationSec: number | null; facts: number; sources: number;
};
type ManifestCell = { count: number; etag: string };
export type CellStatus = "ready" | "loading" | "error";
export type MapCellSnapshot = {
  points: CatalogPoint[];
  /** Cells listed by the manifest; null until any manifest (memory, storage or network) is known. */
  manifestKeys: ReadonlySet<string> | null;
  /** Cells with data in memory, possibly older than the manifest while it is revalidated. */
  loadedKeys: ReadonlySet<string>;
  cellStatus: ReadonlyMap<string, CellStatus>;
  manifestStatus: "idle" | "loading" | "ready" | "error";
  maintenance: boolean;
};
export type CellStorage = {
  read(url: string): Promise<{ etag: string; body: string } | null>;
  write(url: string, etag: string, body: string): Promise<void>;
};
type Fetcher = typeof fetchWithRetry;

/** A new approved story reaches an open map after at most one revalidation interval. */
export const REVALIDATE_MS = 5 * 60_000;
const FAILED_REVALIDATE_MS = 30_000;
const MAX_CONCURRENT_CELLS = 4;
// Areas kept fresh on a manifest update: the current map view and nearby radius plus a few recent ones.
const RECENT_AREAS = 8;
export const MANIFEST_URL = "/api/content/map-cells";
export const CELL_CACHE_NAME = "map-cells-v1";
export const cellUrl = (key: string) => `${MANIFEST_URL}/${key.replace(":", "/")}`;

export function isServiceMaintenance(error: unknown) {
  return error instanceof RequestError && error.status === 503 && error.code === "SERVICE_MAINTENANCE";
}

/**
 * Manifest cells whose square [lat, lat+1] × [lon, lon+1] intersects the rectangle; touching edges count.
 * Iterating the manifest (a handful of cells) instead of every 1° key keeps a wrapped world view
 * (−180…180, 64,800 keys) and the minimum zoom cheap.
 */
export function cellsFor(manifestKeys: Iterable<string>, bounds: CatalogBounds): string[] {
  const keys: string[] = [];
  for (const key of manifestKeys) {
    const [lat, lon] = key.split(":").map(Number);
    if (lat <= bounds.north && lat + 1 >= bounds.south && lon <= bounds.east && lon + 1 >= bounds.west) keys.push(key);
  }
  return keys;
}

/** Strips quotes and the weak prefix, so a proxy that weakens the ETag still matches the manifest. */
const bareEtag = (value: string | null | undefined) => value ? value.trim().replace(/^W\//, "").replace(/^"(.*)"$/, "$1") : null;
const isInteger = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

function parseManifest(value: unknown): Map<string, ManifestCell> {
  const manifest = value as { version?: unknown; cellSize?: unknown; cells?: unknown } | null;
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1 || manifest.cellSize !== 1 || !Array.isArray(manifest.cells)) {
    throw new Error("Некорректный список областей карты.");
  }
  const cells = new Map<string, ManifestCell>();
  for (const cell of manifest.cells as Array<Record<string, unknown>>) {
    if (!cell || typeof cell !== "object" || !isInteger(cell.lat, -90, 89) || !isInteger(cell.lon, -180, 179) || !isCount(cell.count)
      || typeof cell.etag !== "string" || !/^[0-9a-f]{32}$/.test(cell.etag)) throw new Error("Некорректный список областей карты.");
    cells.set(`${cell.lat}:${cell.lon}`, { count: cell.count, etag: cell.etag });
  }
  return cells;
}

function parseCell(value: unknown, key: string): CatalogPoint[] {
  const cell = value as { lat?: unknown; lon?: unknown; points?: unknown } | null;
  if (!cell || typeof cell !== "object" || `${cell.lat}:${cell.lon}` !== key || !Array.isArray(cell.points)) throw new Error("Некорректная область карты.");
  return (cell.points as Array<Record<string, unknown>>).map(point => {
    if (!point || typeof point !== "object" || typeof point.id !== "string" || !point.id
      || typeof point.lat !== "number" || !Number.isFinite(point.lat) || typeof point.lon !== "number" || !Number.isFinite(point.lon)
      || typeof point.title !== "string" || typeof point.address !== "string"
      || !(point.durationSec === null || typeof point.durationSec === "number" && Number.isFinite(point.durationSec) && point.durationSec > 0)
      || !isCount(point.facts) || !isCount(point.sources)) throw new Error("Некорректная область карты.");
    return { id: point.id, location: { lat: point.lat, lon: point.lon }, title: point.title, address: point.address,
      durationSec: point.durationSec as number | null, facts: point.facts, sources: point.sources };
  });
}

/**
 * Persistent copy in Cache Storage, written by page code: the page shows the stored copy at once,
 * revalidates it and updates the markers in place. Any storage failure (no API, private mode, quota)
 * is an empty cache, never an error.
 */
export function createCacheStorage(name = CELL_CACHE_NAME): CellStorage {
  let opened: Promise<Cache | null> | null = null;
  const open = () => opened ??= (async () => {
    if (typeof caches === "undefined") return null;
    try {
      for (const key of await caches.keys()) if (key.startsWith("map-cells-") && key !== name) await caches.delete(key);
    } catch {
      // A stale schema version only wastes space; the current cache still works.
    }
    try { return await caches.open(name); } catch { return null; }
  })();
  return {
    async read(url) {
      try {
        const response = await (await open())?.match(url);
        const etag = response?.headers.get("ETag");
        return response && etag ? { etag, body: await response.text() } : null;
      } catch {
        return null;
      }
    },
    async write(url, etag, body) {
      try {
        await (await open())?.put(url, new Response(body, { headers: { "Content-Type": "application/json", ETag: etag } }));
      } catch {
        // Quota or private mode: the memory copy still serves this session.
      }
    },
  };
}

export function createMapCellStore({ storage = createCacheStorage(), fetch = fetchWithRetry, now = Date.now }: {
  storage?: CellStorage; fetch?: Fetcher; now?: () => number;
} = {}) {
  // Shared fetches outlive any one screen: their results land in the cache for the next one.
  const signal = new AbortController().signal;
  // Storage is only an accelerator: any failure of a custom implementation counts as an empty cache too.
  const read = (url: string) => Promise.resolve().then(() => storage.read(url)).catch(() => null);
  const write = (url: string, etag: string, body: string) => Promise.resolve().then(() => storage.write(url, etag, body)).catch(() => {});
  let manifest: { etag: string | null; cells: Map<string, ManifestCell>; nextCheckAt: number } | null = null;
  let manifestStatus: MapCellSnapshot["manifestStatus"] = "idle";
  let maintenance = false;
  let storedManifest: Promise<void> | null = null;
  let revalidating: Promise<void> | null = null;
  // No eviction: at 1° per cell a session touches a handful of cells (Moscow is one), each well under a few MB.
  const memory = new Map<string, { etag: string; points: CatalogPoint[]; fetched: number }>();
  let fetches = 0;
  const status = new Map<string, CellStatus>();
  const inflight = new Map<string, Promise<void>>();
  const areas: CatalogBounds[] = [];
  const listeners = new Set<() => void>();
  let active = 0;
  const waiting: Array<() => void> = [];
  let snapshot: MapCellSnapshot = { points: [], manifestKeys: null, loadedKeys: new Set(), cellStatus: new Map(), manifestStatus, maintenance };
  let pointsDirty = false;

  function emit() {
    const points = pointsDirty ? union() : snapshot.points;
    pointsDirty = false;
    snapshot = { points, manifestKeys: manifest ? new Set(manifest.cells.keys()) : null, loadedKeys: new Set(memory.keys()),
      cellStatus: new Map(status), manifestStatus, maintenance };
    for (const listener of listeners) listener();
  }
  const setCell = (key: string, etag: string, points: CatalogPoint[]) => { memory.set(key, { etag, points, fetched: fetches += 1 }); pointsDirty = true; };
  /**
   * One set of points for the map and the nearby ranking, deduplicated by id: a place moved across a cell line
   * may sit in a fresh cell and a stale one for a moment, and the most recently fetched cell wins.
   */
  function union() {
    const points = new Map<string, CatalogPoint>();
    for (const cell of [...memory.values()].sort((a, b) => a.fetched - b.fetched)) for (const point of cell.points) points.set(point.id, point);
    return [...points.values()];
  }

  function replaceManifest(etag: string | null, cells: Map<string, ManifestCell>, nextCheckAt: number) {
    manifest = { etag, cells, nextCheckAt };
    for (const key of [...memory.keys()]) {
      if (!cells.has(key)) { memory.delete(key); status.delete(key); pointsDirty = true; }
    }
  }

  async function loadStoredManifest() {
    const stored = await read(MANIFEST_URL);
    if (!stored || manifest) return;
    try {
      replaceManifest(stored.etag, parseManifest(JSON.parse(stored.body)), 0);
      manifestStatus = "ready";
      emit();
    } catch {
      // A broken stored copy is ignored; the network copy replaces it.
    }
  }

  async function revalidateManifest() {
    if (!manifest) { manifestStatus = "loading"; emit(); }
    try {
      const previous = manifest;
      const response = await fetch(MANIFEST_URL, signal, previous?.etag ? { headers: { "If-None-Match": previous.etag } } : {});
      if (response.status === 304) {
        if (!previous || manifest !== previous) throw new Error("Некорректный ответ списка областей карты.");
        previous.nextCheckAt = now() + REVALIDATE_MS;
      } else {
        const body = await response.text();
        const etag = response.headers.get("ETag");
        replaceManifest(etag, parseManifest(JSON.parse(body)), now() + REVALIDATE_MS);
        if (etag) await write(MANIFEST_URL, etag, body);
        // Cells changed by this manifest are refreshed for the areas asked for recently.
        void ensureAreas([...areas]);
      }
      manifestStatus = "ready";
      maintenance = false;
    } catch (error) {
      maintenance = isServiceMaintenance(error);
      if (manifest) manifest.nextCheckAt = now() + FAILED_REVALIDATE_MS;
      else manifestStatus = "error";
    } finally {
      emit();
    }
  }

  /** Resolves once some manifest is available; a stale one is revalidated in the background. */
  async function ensureManifest(force = false) {
    if (!force && manifest && now() < manifest.nextCheckAt) return;
    await (storedManifest ??= loadStoredManifest());
    if (!force && manifest && now() < manifest.nextCheckAt) return;
    const network = revalidating ??= revalidateManifest().finally(() => { revalidating = null; });
    if (!manifest) await network;
  }

  async function limited<T>(task: () => Promise<T>) {
    if (active >= MAX_CONCURRENT_CELLS) await new Promise<void>(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  }

  async function loadCell(key: string) {
    const url = cellUrl(key);
    if (!memory.has(key)) {
      const stored = await read(url);
      if (stored && !memory.has(key)) {
        try { setCell(key, bareEtag(stored.etag) ?? "", parseCell(JSON.parse(stored.body), key)); status.set(key, "ready"); emit(); } catch {
          // A broken stored copy is refetched below.
        }
      }
    }
    const expected = manifest?.cells.get(key)?.etag;
    const current = memory.get(key);
    if (!expected || current?.etag === expected) return;
    if (!current) { status.set(key, "loading"); emit(); }
    try {
      const response = await limited(() => fetch(url, signal, current ? { headers: { "If-None-Match": `"${current.etag}"` } } : {}));
      let etag: string;
      if (response.status === 304) {
        if (!current) throw new Error("Некорректный ответ области карты.");
        etag = current.etag;
      } else {
        const body = await response.text();
        const points = parseCell(JSON.parse(body), key);
        etag = bareEtag(response.headers.get("ETag")) ?? expected;
        setCell(key, etag, points);
        await write(url, `"${etag}"`, body);
      }
      // The cell was published after the manifest was read: keep the newer cell and recheck the manifest.
      if (manifest && etag !== manifest.cells.get(key)?.etag) manifest.nextCheckAt = 0;
      status.set(key, "ready");
      maintenance = false;
    } catch (error) {
      maintenance = isServiceMaintenance(error);
      // A stale copy keeps serving (offline included); only a cell without any copy is an error.
      status.set(key, memory.has(key) ? "ready" : "error");
    } finally {
      emit();
    }
  }

  function ensureCell(key: string): Promise<void> {
    const running = inflight.get(key);
    if (running) return running;
    const task = loadCell(key).finally(() => inflight.delete(key));
    inflight.set(key, task);
    return task;
  }

  async function ensureAreas(bounds: CatalogBounds[]) {
    await ensureManifest();
    const cells = manifest?.cells;
    if (!cells) return;
    // Only manifest cells are requested: everything else is empty.
    const keys = new Set(bounds.flatMap(area => cellsFor(cells.keys(), area)));
    await Promise.all([...keys].map(ensureCell));
  }
  function remember(bounds: CatalogBounds[]) {
    for (const area of bounds) {
      const index = areas.findIndex(item => item.west === area.west && item.south === area.south && item.east === area.east && item.north === area.north);
      if (index >= 0) areas.splice(index, 1);
      areas.push(area);
    }
    areas.splice(0, Math.max(0, areas.length - RECENT_AREAS));
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    snapshot: () => snapshot,
    /** Loads the cells of the areas (memory → storage → network) and keeps them fresh on later manifest updates. */
    ensureArea(...bounds: CatalogBounds[]) {
      remember(bounds);
      return ensureAreas(bounds);
    },
    /** Forces a manifest revalidation, e.g. after a published story turned out to be gone. */
    async revalidate() {
      await ensureManifest(true);
    },
    async retry(...bounds: CatalogBounds[]) {
      remember(bounds);
      await ensureManifest(true);
      await ensureAreas(bounds);
    },
  };
}
export type MapCellStore = ReturnType<typeof createMapCellStore>;

/**
 * Status of an area: loading or error only for its cells without any copy; revalidating cached data is silent.
 * An area crossing a cell line stays loading until every cell is ready, so nothing is computed from half of it.
 */
export function areaStatus(snapshot: MapCellSnapshot, bounds: CatalogBounds): CellStatus {
  if (!snapshot.manifestKeys) return snapshot.manifestStatus === "error" ? "error" : "loading";
  let result: CellStatus = "ready";
  for (const key of cellsFor(snapshot.manifestKeys, bounds)) {
    if (snapshot.loadedKeys.has(key)) continue;
    if (snapshot.cellStatus.get(key) === "error") return "error";
    result = "loading";
  }
  return result;
}

/** Module-level store: survives `AroundScreen` remounts within the session. */
export const mapCellStore = createMapCellStore();
