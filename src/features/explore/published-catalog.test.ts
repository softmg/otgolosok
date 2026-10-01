import { afterEach, expect, it, vi } from "vitest";
import { isServiceMaintenance, loadPublishedCatalog, type CatalogPlace, type CatalogProgress } from "./published-catalog";
import { RequestError } from "../walk-builder/request";

it.each([
  [new RequestError("Обновление", "SERVICE_MAINTENANCE", 503), true],
  [new RequestError("Недоступен", "SERVICE_UNAVAILABLE", 503), false],
  [new RequestError("Отказ", "SERVICE_MAINTENANCE", 400), false],
  [new Error("SERVICE_MAINTENANCE"), false],
  [null, false],
])("recognizes only a maintenance response: %j", (error, expected) => {
  expect(isServiceMaintenance(error)).toBe(expected);
});

const bounds = { west: 37.5, south: 55.7, east: 37.7, north: 55.8 };
const place = (id: number): CatalogPlace => ({ id: `osm:node:${id}`, name: `Место ${id}`, address: null, location: { lat: 55.75, lon: 37.6 }, story: null, audio: null, distanceM: null });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

it.each([0, 100, 101, 1438])("loads all %i places, including an empty catalog and exact page boundary", async total => {
  const all = Array.from({ length: total }, (_, index) => place(index));
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
    const offset = Number(new URL(path, "http://localhost").searchParams.get("offset"));
    return Response.json({ places: all.slice(offset, offset + 100), total, hasMore: offset + 100 < total });
  }));
  const updates: CatalogProgress[] = [];
  await loadPublishedCatalog(new AbortController().signal, value => updates.push(value), bounds);
  expect(updates.at(-1)).toEqual({ places: all, total });
  expect(updates).toHaveLength(Math.max(1, Math.ceil(total / 100)));
});

it.each([429, 503, "network", "timeout"])("recovers a transient %s failure on the same page", async failure => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockImplementationOnce((_path: string, options: RequestInit) => {
    if (failure === "network") return Promise.reject(new TypeError("offline"));
    if (failure === "timeout") return new Promise((_resolve, reject) => options.signal?.addEventListener("abort", () => reject(options.signal?.reason)));
    return Promise.resolve(Response.json({}, { status: failure as number }));
  }).mockResolvedValueOnce(Response.json({ places: [place(1)], total: 1, hasMore: false }));
  vi.stubGlobal("fetch", fetcher);
  const updates: CatalogProgress[] = [];
  const loading = loadPublishedCatalog(new AbortController().signal, value => updates.push(value), bounds);
  await vi.runAllTimersAsync();
  await loading;
  expect(updates.at(-1)?.places).toEqual([place(1)]);
  expect(fetcher.mock.calls.map(call => call[0])).toEqual(Array(2).fill("/api/content/places?limit=100&status=ready&offset=0&west=37.5&south=55.7&east=37.7&north=55.8"));
});

it("stops after three transient failures without declaring an empty catalog loaded", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const updates: CatalogProgress[] = [];
  const loading = expect(loadPublishedCatalog(new AbortController().signal, value => updates.push(value), bounds)).rejects.toThrow();
  await vi.runAllTimersAsync();
  await loading;
  expect(updates).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(3);
});

it("does not retry a deterministic refusal", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 400 }));
  vi.stubGlobal("fetch", fetcher);
  const updates: CatalogProgress[] = [];
  await expect(loadPublishedCatalog(new AbortController().signal, value => updates.push(value), bounds)).rejects.toMatchObject({ status: 400 });
  expect(updates).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it.each([
  { places: [], total: 2, hasMore: true },
  { places: [place(1)], total: 2, hasMore: false },
  { places: [place(1)], total: 1, hasMore: true },
  { places: [], total: 0 },
])("rejects incomplete or inconsistent pages: %j", async page => {
  const fetcher = vi.fn().mockResolvedValue(Response.json(page));
  vi.stubGlobal("fetch", fetcher);
  await expect(loadPublishedCatalog(new AbortController().signal, () => {}, bounds)).rejects.toThrow();
  expect(fetcher).toHaveBeenCalledOnce();
});

it("deduplicates overlapping pages by place id", async () => {
  vi.stubGlobal("fetch", vi.fn()
    .mockResolvedValueOnce(Response.json({ places: [place(1), place(2)], total: 3, hasMore: true }))
    .mockResolvedValueOnce(Response.json({ places: [place(2), place(3)], total: 3, hasMore: false })));
  const updates: CatalogProgress[] = [];
  await loadPublishedCatalog(new AbortController().signal, value => updates.push(value), bounds);
  expect(updates.at(-1)?.places).toEqual([place(1), place(2), place(3)]);
});

it("discards a late response after cancellation and never requests another page", async () => {
  const controller = new AbortController();
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  const updates: CatalogProgress[] = [];
  const loading = expect(loadPublishedCatalog(controller.signal, value => updates.push(value), bounds)).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  finish(Response.json({ places: [place(1)], total: 2, hasMore: true }));
  await loading;
  expect(updates).toEqual([]);
  expect(fetcher).toHaveBeenCalledOnce();
});

it("cancels retry backoff without sending another request", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const loading = expect(loadPublishedCatalog(controller.signal, () => {}, bounds)).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(1);
  controller.abort();
  await vi.runAllTimersAsync();
  await loading;
  expect(fetcher).toHaveBeenCalledOnce();
});
