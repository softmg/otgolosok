import { afterEach, expect, it, vi } from "vitest";
import type { CatalogArea } from "./catalog-bounds";
import { createRegionCatalog, type RegionProgress } from "./region-catalog";

const area = (west = 37): CatalogArea => ({
  required: { west: west + 0.1, south: 55.6, east: west + 0.2, north: 55.7 },
  buffered: { west, south: 55.5, east: west + 0.4, north: 55.8 },
});
const place = (id: number) => ({ id: `osm:node:${id}`, name: `Место ${id}`, location: { lat: 55.65, lon: 37.15 }, story: null, audio: null });
const response = (ids: number[], total = ids.length, hasMore = false) => Response.json({ places: ids.map(place), total, hasMore });
const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const loaders: ReturnType<typeof createRegionCatalog>[] = [];
function fixture() {
  const updates: RegionProgress[] = [];
  const loader = createRegionCatalog(progress => updates.push(progress));
  loaders.push(loader);
  return { loader, updates, latest: () => updates.at(-1)! };
}
afterEach(() => { loaders.splice(0).forEach(loader => loader.dispose()); vi.unstubAllGlobals(); vi.useRealTimers(); });

it("retains partial places during maintenance and clears the flag after recovery", async () => {
  vi.useFakeTimers();
  let maintenance = true;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const offset = Number(new URL(path, "http://localhost").searchParams.get("offset"));
    if (offset === 0) return response([1], 2, true);
    return maintenance ? Response.json({ error: { code: "SERVICE_MAINTENANCE" } }, { status: 503 }) : response([2], 2);
  }));
  const { loader, latest } = fixture();
  loader.update(area());
  await vi.runAllTimersAsync();
  expect(latest()).toMatchObject({ status: "error", maintenance: true, loaded: 1, total: 2, places: [place(1)] });
  maintenance = false;
  loader.retry();
  await settle();
  expect(latest()).toMatchObject({ status: "ready", maintenance: false, places: [place(1), place(2)] });
});

it("waits for actual map bounds, caches completed and empty areas, and loads only new areas", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([1])).mockResolvedValueOnce(response([]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  expect(fetcher).not.toHaveBeenCalled();
  loader.update(area()); await settle();
  expect(latest()).toMatchObject({ status: "ready", places: [place(1)] });
  const params = new URL(fetcher.mock.calls[0][0], "http://localhost").searchParams;
  expect(Object.fromEntries(["west", "south", "east", "north"].map(key => [key, Number(params.get(key))]))).toEqual(area().buffered);
  loader.update(area(37.05)); await settle();
  expect(fetcher).toHaveBeenCalledTimes(1);
  loader.update(area(38)); await settle();
  loader.update(area()); loader.update(area(38)); await settle();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(latest().places).toEqual([place(1)]);
});

it("keeps an in-flight request inside the buffer, aborts it outside, and ignores late pages", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; })).mockResolvedValueOnce(response([2]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); loader.update(area(37.05));
  const signal = fetcher.mock.calls[0][1].signal as AbortSignal;
  expect(signal.aborted).toBe(false);
  loader.update(area(38)); await settle();
  expect(signal.aborted).toBe(true);
  finish(response([1], 2, true)); await settle();
  expect(latest()).toMatchObject({ status: "ready", places: [place(2)] });
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it("retains partial results on failure, retries incomplete coverage, and counts only the active area", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([1]))
    .mockResolvedValueOnce(response([2], 2, true)).mockResolvedValueOnce(Response.json({}, { status: 400 }))
    .mockResolvedValueOnce(response([2, 3]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); await settle();
  loader.update(area(38)); await settle();
  expect(latest()).toMatchObject({ status: "error", loaded: 1, total: 2, places: [place(1), place(2)] });
  loader.retry(); await settle();
  expect(latest()).toMatchObject({ status: "ready", loaded: 2, total: 2, places: [place(1), place(2), place(3)] });
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("cancels an unfinished area on return to cached coverage without showing an error", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([1]))
    .mockImplementationOnce((_path: string, options: RequestInit) => new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason))));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); await settle();
  loader.update(area(38)); loader.update(area()); await settle();
  expect(latest()).toMatchObject({ status: "ready", places: [place(1)] });
  expect(fetcher.mock.calls[1][1].signal.aborted).toBe(true);
});

it("does not mark a cancelled page complete and deduplicates its places on return", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn().mockResolvedValueOnce(response([1], 2, true))
    .mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(response([3])).mockResolvedValueOnce(response([1, 2]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); await settle();
  loader.update(area(38)); await settle();
  loader.update(area()); await settle();
  finish(response([99])); await settle();
  expect(latest().places.map(value => value.id).sort()).toEqual(["osm:node:1", "osm:node:2", "osm:node:3"]);
  expect(fetcher).toHaveBeenCalledTimes(4);
});

it("aborts on disposal and publishes no late response", async () => {
  let finish!: (value: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const { loader, updates } = fixture();
  loader.update(area()); loader.dispose();
  const count = updates.length;
  finish(response([1])); await settle();
  expect(updates).toHaveLength(count);
});


it("requests only missing strips and reuses their combined coverage when zooming", async () => {
  const fetcher = vi.fn<(path: string) => Promise<Response>>(async () => response([1]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); await settle();
  const expanded = {
    required: { west: 36.9, south: 55.4, east: 37.5, north: 55.9 },
    buffered: { west: 36.8, south: 55.3, east: 37.6, north: 56 },
  };
  loader.update(expanded); await settle();
  const requested = fetcher.mock.calls.slice(1).map(([path]) => {
    const params = new URL(path, "http://localhost").searchParams;
    return Object.fromEntries(["west", "south", "east", "north"].map(key => [key, Number(params.get(key))]));
  });
  expect(requested).toHaveLength(4);
  for (const bounds of requested) {
    const cached = area().buffered;
    const overlap = Math.max(0, Math.min(bounds.east, cached.east) - Math.max(bounds.west, cached.west))
      * Math.max(0, Math.min(bounds.north, cached.north) - Math.max(bounds.south, cached.south));
    expect(overlap).toBe(0);
  }
  expect(latest()).toMatchObject({ status: "ready", places: [place(1)] });
  const count = fetcher.mock.calls.length;
  for (let i = 0; i < 3; i++) { loader.update(area()); loader.update(expanded); }
  await settle();
  expect(fetcher).toHaveBeenCalledTimes(count);
  expect(latest().status).toBe("ready");
});


it("keeps completed strips cached when another strip fails and retry loads the remaining ones", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(response([1])).mockResolvedValueOnce(response([2]))
    .mockResolvedValueOnce(Response.json({}, { status: 400 })).mockImplementation(async () => response([]));
  vi.stubGlobal("fetch", fetcher);
  const { loader, latest } = fixture();
  loader.update(area()); await settle();
  const expanded = { required: { west: 36.9, south: 55.4, east: 37.5, north: 55.9 },
    buffered: { west: 36.8, south: 55.3, east: 37.6, north: 56 } };
  loader.update(expanded); await settle();
  expect(latest()).toMatchObject({ status: "error", places: [place(1), place(2)] });
  const completedStrip = fetcher.mock.calls[1][0];
  loader.retry(); await settle();
  expect(latest()).toMatchObject({ status: "ready", places: [place(1), place(2)] });
  expect(fetcher.mock.calls.slice(3).map(([path]) => path)).not.toContain(completedStrip);
  expect(fetcher).toHaveBeenCalledTimes(6);
  loader.update(expanded); await settle();
  expect(fetcher).toHaveBeenCalledTimes(6);
});
