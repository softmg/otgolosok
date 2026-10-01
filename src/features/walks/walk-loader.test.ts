import { describe, expect, it, vi } from "vitest";
import { loadCatalogCards, loadJson, loadLocalWalkView, WalkLoadError } from "./walk-loader";
import type { WalkDocument } from "./model";

describe("загрузка прогулок", () => {
  it("повторяет сетевой сбой, но не повторяет ошибку схемы", async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ walks: [] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadCatalogCards(new AbortController().signal)).resolves.toEqual([]);
    expect(fetcher).toHaveBeenCalledTimes(2);

    fetcher.mockReset().mockResolvedValue(new Response("{}", { status: 200 }));
    await expect(loadCatalogCards(new AbortController().signal)).rejects.toMatchObject({ retryable: false });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("сохраняет статус и Retry-After для временного ответа", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Занято" } }), { status: 429, headers: { "Retry-After": "1" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadJson("/api/story-walks", new AbortController().signal, value => value, 1)).rejects.toEqual(expect.objectContaining({
      status: 429,
      retryable: true,
      retryAfterMs: 1000,
    } satisfies Partial<WalkLoadError>));
  });

  it("не повторяет 429, если лимит снимется позже бюджета повторов, и отправляет PUT с заголовками", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Слишком часто" } }), { status: 429, headers: { "Retry-After": "600" } }));
    vi.stubGlobal("fetch", fetcher);
    await expect(loadJson("/api/x", new AbortController().signal, value => value, 3, { rating: 5 }, { method: "PUT", headers: { "X-Review-Key": "k" } }))
      .rejects.toMatchObject({ status: 429, retryable: false, message: "Слишком часто" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(init).toMatchObject({ method: "PUT", body: JSON.stringify({ rating: 5 }), headers: { "X-Review-Key": "k", "Content-Type": "application/json" } });
  });

  it("показывает опубликованные истории остановок из OSM в гостевой прогулке", async () => {
    const document: WalkDocument = { version: 2, id: "22222222-2222-4222-8222-222222222222", title: "Моя прогулка", description: "", city: "Москва", mode: "loop", minutes: 30,
      start: { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stops: [{ id: "33333333-3333-4333-8333-333333333333", place: { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } }, storyRef: { kind: "osm", id: "osm:way:10" }, transition: "", nextHint: "" }], route: null, fieldChecked: false };
    const audio = { url: `/api/story-audio/${"b".repeat(64)}.mp3`, sha256: "b".repeat(64), durationSec: 40 };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ document, revision: 5, contentVersion: "c".repeat(64), chapters: [{ id: document.stops[0].id, status: "ready", story: { title: "Дом на Арбате", address: "Москва, Арбат, 10", paragraphs: [{ text: "Опубликованный рассказ.", factIds: [] }], sources: [], facts: [] }, audio }] }), { status: 200 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await loadLocalWalkView(document, 5, new AbortController().signal);
    expect(result.chapters[0]).toMatchObject({ status: "ready", audio });
    expect(result.contentVersion).toBe(`local:5:${"c".repeat(64)}`);
    const [url, init] = fetcher.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/story-walks/resolve");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ document, revision: 5 });
  });

  it("оставляет гостевую прогулку открытой, если истории не загрузились", async () => {
    const document: WalkDocument = { version: 2, id: "22222222-2222-4222-8222-222222222222", title: "Моя прогулка", description: "", city: "Москва", mode: "loop", minutes: 30,
      start: { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stops: [{ id: "33333333-3333-4333-8333-333333333333", place: { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } }, storyRef: { kind: "osm", id: "osm:way:10" }, transition: "", nextHint: "" }], route: null, fieldChecked: false };
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: "Некорректные данные" } }), { status: 400 }));
    vi.stubGlobal("fetch", fetcher);
    const result = await loadLocalWalkView(document, 5, new AbortController().signal);
    expect(result.chapters[0]).toMatchObject({ status: "preparing", story: null, audio: null });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

it.each([3, 4, 6])("открывает локальную прогулку с %i остановками и сохраняет геометрию", async count => {
  const start = { address: "Александровский сад", location: { lat: 55.752, lon: 37.613 } };
  const stops = Array.from({ length: count }, (_, index) => ({ id: `33333333-3333-4333-8333-${String(index).padStart(12, "0")}`, place: { address: `Москва, дом ${index + 1}`, location: { lat: 55.754 + index * 0.001, lon: 37.61 } }, storyRef: null, transition: "", nextHint: "" }));
  const document: WalkDocument = { version: 2, id: "22222222-2222-4222-8222-222222222222", title: "Из Александровского сада", description: "", city: "Москва", mode: "loop", minutes: 60, start, stops, route: { geometry: [start.location, ...stops.map(stop => stop.place.location), start.location], distanceM: 2000, walkingMinutes: 30, attribution: "OSM" }, fieldChecked: false };
  const view = await loadLocalWalkView(document, 3, new AbortController().signal);
  expect(view.document.route?.geometry).toEqual(document.route?.geometry);
  expect(view.chapters).toHaveLength(count);
  expect(view.contentVersion.length).toBeLessThanOrEqual(120);
  expect((await loadLocalWalkView(document, 3, new AbortController().signal)).contentVersion).toBe(view.contentVersion);
});
