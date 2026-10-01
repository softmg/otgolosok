import { afterEach, describe, expect, it, vi } from "vitest";
import { RequestError } from "../walk-builder/request";
import type { CatalogBounds } from "./catalog-bounds";
import { MANIFEST_URL, REVALIDATE_MS, areaStatus, cellsFor, createCacheStorage, createMapCellStore, type CellStorage, type MapCellSnapshot, type MapPoint } from "./map-cells";

const point = (id: string, lat = 55.75, lon = 37.6): MapPoint => ({ id, lat, lon, title: `История ${id}`, address: "Москва", durationSec: null, facts: 1, sources: 2 });
const etagFor = (body: string) => {
  let hash = 0;
  for (const char of body) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(32, "0");
};

/** A tiny backend with content ETags and conditional responses, like `sendCacheableJson`. */
function fakeServer(cells: Record<string, MapPoint[]>) {
  const state = { cells: { ...cells }, offline: false, maintenance: false, requests: [] as string[], delay: null as Promise<void> | null };
  const cellBody = (key: string) => { const [lat, lon] = key.split(":").map(Number); return JSON.stringify({ lat, lon, points: state.cells[key] ?? [] }); };
  const manifestBody = () => JSON.stringify({ version: 1, cellSize: 1, cells: Object.keys(state.cells).filter(key => state.cells[key].length)
    .map(key => { const [lat, lon] = key.split(":").map(Number); return { lat, lon, count: state.cells[key].length, etag: etagFor(cellBody(key)) }; }) });
  const fetch = vi.fn(async (path: string, _signal: AbortSignal, init: { headers?: HeadersInit } = {}) => {
    state.requests.push(path);
    if (state.delay) await state.delay;
    if (state.offline) throw new TypeError("offline");
    if (state.maintenance) throw new RequestError("Обновление", "SERVICE_MAINTENANCE", 503);
    const match = /^\/api\/content\/map-cells\/(-?\d+)\/(-?\d+)$/.exec(path);
    const body = path === MANIFEST_URL ? manifestBody() : match ? cellBody(`${match[1]}:${match[2]}`) : null;
    if (body === null) throw new RequestError("Нет", "NOT_FOUND", 404);
    const etag = `"${etagFor(body)}"`;
    const conditional = new Headers(init.headers).get("If-None-Match");
    return conditional === etag ? new Response(null, { status: 304, headers: { ETag: etag } }) : new Response(body, { headers: { ETag: etag } });
  });
  return { state, fetch, manifestBody, cellBody };
}

function memoryStorage(): CellStorage & { entries: Map<string, { etag: string; body: string }> } {
  const entries = new Map<string, { etag: string; body: string }>();
  return { entries, read: async url => entries.get(url) ?? null, write: async (url, etag, body) => { entries.set(url, { etag, body }); } };
}
/** A rectangle strictly inside the cell, so it touches no neighbour. */
const area = (key: string): CatalogBounds => { const [lat, lon] = key.split(":").map(Number); return { west: lon + 0.1, south: lat + 0.1, east: lon + 0.9, north: lat + 0.9 }; };
const areas = (keys: string[]) => keys.map(area);
const statusOf = (snapshot: MapCellSnapshot, keys: string[]) => {
  const statuses = keys.map(key => areaStatus(snapshot, area(key)));
  return statuses.includes("error") ? "error" : statuses.includes("loading") ? "loading" : "ready";
};
const ids = (store: ReturnType<typeof createMapCellStore>) => store.snapshot().points.map(item => item.id).sort();

describe("cellsFor", () => {
  const manifest = ["55:36", "55:37", "56:37", "-1:-1", "89:179"];
  it.each([
    ["inside one cell", { west: 37.4, south: 55.6, east: 37.8, north: 55.9 }, ["55:37"]],
    ["straddling 56°N at Zelenograd", { west: 37.2, south: 55.99, east: 37.26, north: 56.01 }, ["55:37", "56:37"]],
    ["touching a line exactly", { west: 37.2, south: 55.5, east: 37.6, north: 56 }, ["55:37", "56:37"]],
    ["touching the 37° meridian from the west", { west: 36.5, south: 55.5, east: 37, north: 55.6 }, ["55:36", "55:37"]],
    ["no manifest cell", { west: 30.1, south: 59.8, east: 30.5, north: 60 }, []],
    ["the wrapped world view", { west: -180, south: -90, east: 180, north: 90 }, manifest],
    ["the antimeridian corner", { west: 179.5, south: 89.5, east: 180, north: 90 }, ["89:179"]],
    ["a negative cell", { west: -0.5, south: -0.5, east: -0.1, north: -0.1 }, ["-1:-1"]],
  ])("%s", (_name, bounds, keys) => expect(cellsFor(manifest, bounds)).toEqual(keys));
});

describe("map cell store", () => {
  it("loads the manifest and only the cells it lists, with no repeat requests while fresh", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1"), point("osm:node:2")] });
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch });
    await store.ensureArea(...areas(["55:37", "56:37"]));
    expect(ids(store)).toEqual(["osm:node:1", "osm:node:2"]);
    expect(store.snapshot().points[0]).toEqual({ id: "osm:node:1", location: { lat: 55.75, lon: 37.6 }, title: "История osm:node:1", address: "Москва", durationSec: null, facts: 1, sources: 2, photo: false });
    expect(server.state.requests).toEqual([MANIFEST_URL, "/api/content/map-cells/55/37"]);
    await store.ensureArea(...areas(["55:37"]));
    expect(server.state.requests).toHaveLength(2);
    expect(statusOf(store.snapshot(), ["55:37", "56:37"])).toBe("ready");
  });

  it("serves the stored copy at once, then revalidates the manifest with a 304", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const storage = memoryStorage();
    await createMapCellStore({ storage, fetch: server.fetch }).ensureArea(...areas(["55:37"]));
    server.state.requests = [];
    let release!: () => void;
    server.state.delay = new Promise(resolve => { release = resolve; });
    const store = createMapCellStore({ storage, fetch: server.fetch });
    await store.ensureArea(...areas(["55:37"]));
    // Shown from storage before the network answers.
    expect(ids(store)).toEqual(["osm:node:1"]);
    expect(statusOf(store.snapshot(), ["55:37"])).toBe("ready");
    release();
    await vi.waitFor(() => expect(server.fetch).toHaveResolvedTimes(server.fetch.mock.calls.length));
    expect(server.state.requests).toEqual([MANIFEST_URL]);
    expect(new Headers(server.fetch.mock.calls.at(-1)![2]?.headers).get("If-None-Match")).toBe(`"${etagFor(server.manifestBody())}"`);
  });

  it("replaces the manifest on a 200 and fetches only the cell whose ETag changed", async () => {
    let time = 0;
    const server = fakeServer({ "55:37": [point("osm:node:1")], "56:37": [point("osm:node:9", 56.1, 37.2)] });
    const storage = memoryStorage();
    const store = createMapCellStore({ storage, fetch: server.fetch, now: () => time });
    await store.ensureArea(...areas(["55:37", "56:37"]));
    server.state.cells["55:37"] = [point("osm:node:1"), point("osm:node:3")];
    server.state.requests = [];
    time = REVALIDATE_MS - 1;
    await store.ensureArea(...areas(["55:37", "56:37"]));
    expect(server.state.requests).toEqual([]);
    time = REVALIDATE_MS + 1;
    await store.ensureArea(...areas(["55:37"]));
    await vi.waitFor(() => expect(ids(store)).toEqual(["osm:node:1", "osm:node:3", "osm:node:9"]));
    expect(server.state.requests).toEqual([MANIFEST_URL, "/api/content/map-cells/55/37"]);
    // The older copy was offered for a conditional request.
    expect(new Headers(server.fetch.mock.calls.at(-1)![2]?.headers).get("If-None-Match")).not.toBeNull();
    expect(JSON.parse(storage.entries.get("/api/content/map-cells/55/37")!.body).points).toHaveLength(2);
  });

  it("drops a cell that the new manifest no longer lists", async () => {
    let time = 0;
    const server = fakeServer({ "55:37": [point("osm:node:1")], "56:37": [point("osm:node:9", 56.1, 37.2)] });
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch, now: () => time });
    await store.ensureArea(...areas(["55:37", "56:37"]));
    server.state.cells["56:37"] = [];
    time = REVALIDATE_MS + 1;
    await store.retry(...areas(["55:37", "56:37"]));
    expect(ids(store)).toEqual(["osm:node:1"]);
  });

  it("deduplicates concurrent requests and keeps at most four cells in flight", async () => {
    const keys = Array.from({ length: 6 }, (_, index) => `55:${30 + index}`);
    const server = fakeServer(Object.fromEntries(keys.map(key => [key, [point(`osm:node:${key}`)]])));
    let inFlight = 0, peak = 0;
    const fetch: typeof server.fetch = vi.fn(async (...args) => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      try { await new Promise(resolve => setTimeout(resolve, 5)); return await server.fetch(...args); } finally { inFlight -= 1; }
    });
    const store = createMapCellStore({ storage: memoryStorage(), fetch });
    await Promise.all([store.ensureArea(...areas(keys)), store.ensureArea(...areas(keys)), store.ensureArea(...areas(keys.slice(0, 2)))]);
    expect(ids(store)).toHaveLength(6);
    expect(server.state.requests.filter(path => path === MANIFEST_URL)).toHaveLength(1);
    expect(server.state.requests).toHaveLength(7);
    expect(peak).toBeLessThanOrEqual(4);
  });

  it("falls back to the network when storage throws", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const broken: CellStorage = { read: async () => { throw new Error("quota"); }, write: async () => { throw new Error("quota"); } };
    const store = createMapCellStore({ storage: broken, fetch: server.fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(ids(store)).toEqual(["osm:node:1"]);
  });

  it("works offline from storage and reports an error only without any copy", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const storage = memoryStorage();
    await createMapCellStore({ storage, fetch: server.fetch }).ensureArea(...areas(["55:37"]));
    server.state.offline = true;
    const cached = createMapCellStore({ storage, fetch: server.fetch });
    await cached.ensureArea(...areas(["55:37"]));
    await vi.waitFor(() => expect(cached.snapshot().manifestStatus).toBe("ready"));
    expect(ids(cached)).toEqual(["osm:node:1"]);
    expect(statusOf(cached.snapshot(), ["55:37"])).toBe("ready");

    const empty = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch });
    await empty.ensureArea(...areas(["55:37"]));
    expect(empty.snapshot().manifestStatus).toBe("error");
    expect(statusOf(empty.snapshot(), ["55:37"])).toBe("error");
    expect(empty.snapshot().maintenance).toBe(false);
  });

  it("reports a failed cell without a copy as an error and recovers on retry", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const fetch: typeof server.fetch = vi.fn(async (...args) => {
      if (args[0] !== MANIFEST_URL && fetch.mock.calls.length === 2) throw new TypeError("offline");
      return server.fetch(...args);
    });
    const store = createMapCellStore({ storage: memoryStorage(), fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(statusOf(store.snapshot(), ["55:37"])).toBe("error");
    await store.retry(...areas(["55:37"]));
    expect(statusOf(store.snapshot(), ["55:37"])).toBe("ready");
    expect(ids(store)).toEqual(["osm:node:1"]);
  });

  it("flags service maintenance", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    server.state.maintenance = true;
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(store.snapshot().maintenance).toBe(true);
    server.state.maintenance = false;
    await store.retry(...areas(["55:37"]));
    expect(store.snapshot().maintenance).toBe(false);
    expect(ids(store)).toEqual(["osm:node:1"]);
  });

  it("accepts a cell newer than the manifest and rechecks the manifest", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const manifest = server.manifestBody();
    server.state.cells["55:37"] = [point("osm:node:1"), point("osm:node:2")];
    const fetch: typeof server.fetch = vi.fn(async (...args) => {
      if (args[0] === MANIFEST_URL && fetch.mock.calls.length === 1) return new Response(manifest, { headers: { ETag: `"${etagFor(manifest)}"` } });
      return server.fetch(...args);
    });
    const store = createMapCellStore({ storage: memoryStorage(), fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(ids(store)).toEqual(["osm:node:1", "osm:node:2"]);
    await store.ensureArea(...areas(["55:37"]));
    await vi.waitFor(() => expect(fetch.mock.calls.filter(call => call[0] === MANIFEST_URL)).toHaveLength(2));
  });

  it.each([
    ["a manifest of another version", () => new Response(JSON.stringify({ version: 2, cellSize: 1, cells: [] }))],
    ["a manifest cell without an ETag", () => new Response(JSON.stringify({ version: 1, cellSize: 1, cells: [{ lat: 55, lon: 37, count: 1 }] }))],
    ["a body that is not JSON", () => new Response("<html>")],
  ])("rejects %s", async (_name, response) => {
    const store = createMapCellStore({ storage: memoryStorage(), fetch: vi.fn(async () => response()) });
    await store.ensureArea(...areas(["55:37"]));
    expect(store.snapshot().manifestStatus).toBe("error");
    expect(store.snapshot().points).toEqual([]);
  });

  it("rejects a malformed cell instead of showing part of it", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const fetch: typeof server.fetch = vi.fn(async (...args) => args[0] === MANIFEST_URL ? server.fetch(...args)
      : new Response(JSON.stringify({ lat: 55, lon: 37, points: [point("osm:node:1"), { id: "osm:node:2", lat: "x" }] })));
    const store = createMapCellStore({ storage: memoryStorage(), fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(store.snapshot().points).toEqual([]);
    expect(statusOf(store.snapshot(), ["55:37"])).toBe("error");
  });

  it("reads the photo flag: absent is false, true is true", async () => {
    const server = fakeServer({ "55:37": [point("osm:node:1"), { ...point("osm:node:2"), photo: true }] });
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(store.snapshot().points.map(item => [item.id, item.photo])).toEqual([["osm:node:1", false], ["osm:node:2", true]]);
  });

  it.each([false, "true", 1, null])("rejects a cell whose photo flag is %s", async photo => {
    const server = fakeServer({ "55:37": [point("osm:node:1")] });
    const fetch: typeof server.fetch = vi.fn(async (...args) => args[0] === MANIFEST_URL ? server.fetch(...args)
      : new Response(JSON.stringify({ lat: 55, lon: 37, points: [{ ...point("osm:node:1"), photo }] })));
    const store = createMapCellStore({ storage: memoryStorage(), fetch });
    await store.ensureArea(...areas(["55:37"]));
    expect(statusOf(store.snapshot(), ["55:37"])).toBe("error");
  });
});

describe("Cache Storage wrapper", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("round-trips a body with its ETag and deletes older schema versions", async () => {
    const stores = new Map<string, Map<string, Response>>([["map-cells-v0", new Map()], ["otgolosok-shell", new Map()]]);
    vi.stubGlobal("caches", {
      keys: async () => [...stores.keys()],
      delete: async (name: string) => stores.delete(name),
      open: async (name: string) => {
        const entries = stores.get(name) ?? new Map<string, Response>();
        stores.set(name, entries);
        return { match: async (url: string) => entries.get(url)?.clone(), put: async (url: string, response: Response) => { entries.set(url, response); } };
      },
    });
    const storage = createCacheStorage();
    expect(await storage.read(MANIFEST_URL)).toBeNull();
    await storage.write(MANIFEST_URL, '"abc"', "{}");
    expect(await storage.read(MANIFEST_URL)).toEqual({ etag: '"abc"', body: "{}" });
    expect([...stores.keys()].sort()).toEqual(["map-cells-v1", "otgolosok-shell"]);
  });

  it("treats a missing or failing Cache Storage as an empty cache", async () => {
    expect(await createCacheStorage().read(MANIFEST_URL)).toBeNull();
    await expect(createCacheStorage().write(MANIFEST_URL, '"a"', "{}")).resolves.toBeUndefined();
    vi.stubGlobal("caches", { keys: async () => { throw new Error("denied"); }, open: async () => { throw new DOMException("denied", "SecurityError"); } });
    expect(await createCacheStorage().read(MANIFEST_URL)).toBeNull();
    await expect(createCacheStorage().write(MANIFEST_URL, '"a"', "{}")).resolves.toBeUndefined();
  });
});

describe("cell lines stay invisible", () => {
  it("deduplicates a place moved across a line, preferring the most recently fetched cell", async () => {
    let time = 0;
    const server = fakeServer({ "55:37": [point("osm:node:1", 55.999, 37.24), point("osm:node:2")], "56:37": [point("osm:node:3", 56.1, 37.2)] });
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch, now: () => time });
    await store.ensureArea(...areas(["55:37", "56:37"]));
    // An import moved the place north of 56°N: only the northern cell has been refetched so far.
    server.state.cells["56:37"] = [...server.state.cells["56:37"], { ...point("osm:node:1", 56.0004, 37.244), title: "Перенесённое место" }];
    time = REVALIDATE_MS + 1;
    const fetch = server.fetch.getMockImplementation()!;
    server.fetch.mockImplementation(async (path, ...rest) => path === "/api/content/map-cells/55/37" ? new Promise<Response>(() => {}) : fetch(path, ...rest));
    await store.retry(area("56:37"));
    await vi.waitFor(() => expect(store.snapshot().points.find(item => item.id === "osm:node:1")?.title).toBe("Перенесённое место"));
    expect(ids(store)).toEqual(["osm:node:1", "osm:node:2", "osm:node:3"]);
  });

  it("waits for both cells of a nearby radius that crosses a line and then sees points on both sides", async () => {
    let release!: () => void;
    const server = fakeServer({ "55:37": [point("osm:node:1", 55.9986, 37.239)], "56:37": [point("osm:node:2", 56.0004, 37.244)] });
    const fetch = server.fetch.getMockImplementation()!;
    const held = new Promise<void>(resolve => { release = resolve; });
    server.fetch.mockImplementation(async (path, ...rest) => { if (path.endsWith("/56/37")) await held; return fetch(path, ...rest); });
    const store = createMapCellStore({ storage: memoryStorage(), fetch: server.fetch });
    const radius: CatalogBounds = { west: 37.23, south: 55.995, east: 37.25, north: 56.003 };
    const loading = store.ensureArea(radius);
    await vi.waitFor(() => expect(ids(store)).toEqual(["osm:node:1"]));
    expect(areaStatus(store.snapshot(), radius)).toBe("loading");
    release();
    await loading;
    expect(areaStatus(store.snapshot(), radius)).toBe("ready");
    expect(ids(store)).toEqual(["osm:node:1", "osm:node:2"]);
  });
});
