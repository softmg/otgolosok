// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapItem } from "./explore-map";
import type { MapPoint } from "./map-cells";
import type { Route } from "../tour/types";
import exampleRoute from "../../../public/data/routes/paveletskaya.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("../walk-builder/walk-creation-panel", () => ({ WalkCreationPanel: () => null }));
vi.mock("../navigation/app-navigation", () => ({ AppNavigation: () => null }));
const viewport = vi.hoisted(() => ({ area: null as import("./catalog-bounds").CatalogArea | null }));
const MOSCOW_AREA = { required: { west: 37.59, south: 55.74, east: 37.61, north: 55.76 }, buffered: { west: 37.56, south: 55.71, east: 37.64, north: 55.79 } };
vi.mock("./explore-map", () => ({ ExploreMap: ({ items, onViewport, onSelect }: {
  items: MapItem[]; onViewport: (area: import("./catalog-bounds").CatalogArea) => void; onSelect: (id: string) => void;
}) => {
  useEffect(() => { onViewport(viewport.area ?? MOSCOW_AREA); }, [onViewport]);
  return createElement("div", { "data-testid": "map" }, items.map(item => createElement("button", { key: item.id, type: "button", "data-place": item.id, onClick: () => onSelect(item.id) }, item.title)));
} }));

let AroundScreen: typeof import("./around-screen").AroundScreen;
let root: Root;
let container: HTMLDivElement;
const point = (index: number, lat = 55.75, lon = 37.6, durationSec: number | null = null): MapPoint =>
  ({ id: `osm:node:${index}`, lat, lon, title: `История ${index}`, address: `Москва, дом ${index}`, durationSec, facts: 2, sources: 1 });
const cityCell = Array.from({ length: 205 }, (_, index) => point(index + 1));
const route = { pois: [], chapters: [] } as unknown as Route;
const markers = () => container.querySelectorAll('[data-place^="osm:"]');
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text);
const catalogStatus = () => container.querySelector('[data-region="catalog-status"]');
const render = (value = route) => act(async () => root.render(createElement(AroundScreen, { route: value, onStart: () => {}, updateAvailable: false })));

type Handler = (path: string) => Promise<Response | undefined> | Response | undefined;
/** Serves the manifest and cells from `cells`; `override` may answer any request first. */
function stubCatalog(cells: Record<string, MapPoint[]>, override: Handler = () => undefined) {
  const body = (key: string) => { const [lat, lon] = key.split(":").map(Number); return { lat, lon, points: cells[key] ?? [] }; };
  const fetcher = vi.fn(async (path: string) => {
    if (path === "/service-status") return Response.json({ maintenance: false });
    const custom = await override(path);
    if (custom) return custom;
    if (path === "/api/content/map-cells") {
      return Response.json({ version: 1, cellSize: 1, cells: Object.keys(cells).map(key => ({ ...body(key), points: undefined, count: cells[key].length, etag: key.replace(/\D/g, "").padStart(32, "0") })) });
    }
    const cell = /^\/api\/content\/map-cells\/(-?\d+)\/(-?\d+)$/.exec(path);
    if (cell) return Response.json(body(`${cell[1]}:${cell[2]}`));
    return Response.json({ error: { code: "NOT_FOUND" } }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetcher);
  return fetcher;
}
const catalogCalls = (fetcher: ReturnType<typeof vi.fn>) => fetcher.mock.calls.map(call => call[0] as string).filter(path => path.startsWith("/api/content/"));

beforeEach(async () => {
  // A fresh module graph per test: the cell store is a module-level singleton.
  vi.resetModules();
  viewport.area = null;
  ({ AroundScreen } = await import("./around-screen"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class {
    observe() {}
    disconnect() {}
  });
  localStorage.clear();
  localStorage.setItem("otgolosok:explore:geo-prompt-dismissed", "1");
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders every point of the visible cell from one manifest and one cell request", async () => {
  const fetcher = stubCatalog({ "55:37": cityCell });
  await render();
  expect(markers()).toHaveLength(205);
  expect(container.querySelector('[data-place="osm:node:205"]')?.textContent).toBe("История 205");
  expect(catalogCalls(fetcher)).toEqual(["/api/content/map-cells", "/api/content/map-cells/55/37"]);
  expect(catalogStatus()).toBeNull();
});

it("renders a remounted screen from memory without new requests or a loading notice", async () => {
  const fetcher = stubCatalog({ "55:37": cityCell });
  await render();
  await act(async () => root.unmount());
  root = createRoot(container);
  await render();
  expect(markers()).toHaveLength(205);
  expect(catalogStatus()).toBeNull();
  expect(catalogCalls(fetcher)).toHaveLength(2);
});

it("shows an indeterminate loading notice only until the first data arrives", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  stubCatalog({ "55:37": cityCell }, async path => { if (path === "/api/content/map-cells") await gate; return undefined; });
  await render();
  expect(catalogStatus()?.querySelector('[role="status"]')?.textContent).toBe("Загружаем места…");
  expect(catalogStatus()?.querySelector("progress")?.hasAttribute("value")).toBe(false);
  await act(async () => finish());
  expect(markers()).toHaveLength(205);
  expect(catalogStatus()).toBeNull();
});

it("does not add built-in walk stops or the Melnikov demo to the public map", async () => {
  stubCatalog({});
  await render(exampleRoute as Route);
  expect(container.querySelectorAll("[data-place]")).toHaveLength(0);
});

it("preserves the explicitly opened current chapter without adding the other walk stops", async () => {
  stubCatalog({});
  let started: number | undefined;
  await act(async () => root.render(createElement(AroundScreen, {
    route: exampleRoute as Route, openChapter: 2, onStart: index => { started = index; }, updateAvailable: false,
  })));
  expect(container.querySelectorAll("[data-place]")).toHaveLength(1);
  expect(container.querySelector('[data-place="housing"]')?.textContent).toBe("Жизнь после смены");
  const start = [...container.querySelectorAll("button")].find(item => item.textContent?.includes("Слушать эту часть"));
  await act(async () => start!.click());
  expect(started).toBe(2);
});

it("does not recommend built-in places after geolocation", async () => {
  stubCatalog({});
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.7249, longitude: 37.6507, accuracy: 10 } } as GeolocationPosition) } });
  await render(exampleRoute as Route);
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(container.querySelectorAll('[data-sheet="nearby"] li')).toHaveLength(0);
  expect(container.textContent).toContain("В этом радиусе пока нет готовой проверенной истории.");
});

it("opens a catalog point with its header at once, then loads the text and the player", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  stubCatalog({ "55:37": [point(1, 55.75, 37.6, 90)] }, async path => {
    if (path !== "/api/content/places/osm:node:1") return undefined;
    await gate;
    return Response.json({ place: { id: "osm:node:1", text: { story: { title: "История 1", paragraphs: [{ text: "Проверенный рассказ." }] }, audio: { url: "/api/story-audio/a.mp3", durationSec: 90 } } } });
  });
  await render();
  await act(async () => (container.querySelector('[data-place="osm:node:1"]') as HTMLButtonElement).click());
  const sheet = () => container.querySelector('[data-sheet="story"]');
  expect(sheet()?.textContent).toContain("История 1");
  expect(sheet()?.textContent).toContain("Москва, дом 1");
  expect(sheet()?.textContent).toContain("2 мин · аудио");
  expect(sheet()?.textContent).toContain("Загружаем рассказ…");
  expect(sheet()?.querySelector("audio")).toBeNull();
  await act(async () => finish());
  expect(sheet()?.textContent).toContain("Проверенный рассказ.");
  expect(sheet()?.textContent).not.toContain("Загружаем рассказ…");
  expect(sheet()?.querySelector("audio")?.getAttribute("src")).toBe("/api/story-audio/a.mp3");
});

it("reports a failed cell and completes the map on retry", async () => {
  let failing = true;
  stubCatalog({ "55:37": cityCell }, path => path === "/api/content/map-cells/55/37" && failing ? Response.json({ error: { code: "BAD_REQUEST" } }, { status: 400 }) : undefined);
  await render();
  expect(container.textContent).toContain("Не все места загрузились.");
  expect(markers()).toHaveLength(0);
  failing = false;
  expect(button("Повторить загрузку мест")).toBeDefined();
  await act(async () => button("Повторить загрузку мест")!.click());
  expect(markers()).toHaveLength(205);
  expect(container.textContent).not.toContain("Не все места загрузились.");
});

it("automatically restores the map after maintenance even when the status endpoint is healthy", async () => {
  vi.useFakeTimers();
  let maintenance = true;
  stubCatalog({ "55:37": cityCell }, path => path.startsWith("/api/content/map-cells/") && maintenance
    ? Response.json({ error: { code: "SERVICE_MAINTENANCE" } }, { status: 503 }) : undefined);
  await render();
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(markers()).toHaveLength(0);
  expect(container.textContent).toContain("Сервис обновляется. Карта загрузится автоматически.");
  expect(button("Повторить загрузку мест")).toBeUndefined();
  expect(container.querySelector("progress")).toBeNull();
  maintenance = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(markers()).toHaveLength(205);
  expect(catalogStatus()).toBeNull();
});

it("recommends nearby stories from a cell outside the visible map and waits for it before declaring it empty", async () => {
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  // The map shows another cell; the nearby radius needs the Moscow one.
  viewport.area = { required: { west: 39.5, south: 54.5, east: 39.6, north: 54.6 }, buffered: { west: 39.4, south: 54.4, east: 39.7, north: 54.7 } };
  const fetcher = stubCatalog({ "54:39": [point(900, 54.55, 39.55)], "55:37": [point(500, 55.75, 37.6, 60), point(501, 55.75, 37.6005)] },
    async path => { if (path === "/api/content/map-cells/55/37") await gate; return undefined; });
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.75, longitude: 37.6, accuracy: 10 } } as GeolocationPosition) } });
  await render();
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(container.textContent).toContain("Ищем истории рядом…");
  expect(container.textContent).not.toContain("В этом радиусе пока нет");
  await act(async () => finish());
  // Only the voiced point is recommended; both are on the map.
  expect([...container.querySelectorAll('[data-sheet="nearby"] li')].map(item => item.textContent)).toEqual([expect.stringContaining("История 500")]);
  expect(markers()).toHaveLength(3);
  expect(catalogCalls(fetcher)).toEqual(["/api/content/map-cells", "/api/content/map-cells/54/39", "/api/content/map-cells/55/37"]);
});

it("merges both cells of a viewport over 56°N into one set of map points", async () => {
  viewport.area = { required: { west: 37.23, south: 55.995, east: 37.25, north: 56.005 }, buffered: { west: 37.2, south: 55.98, east: 37.28, north: 56.02 } };
  const fetcher = stubCatalog({ "55:37": [point(1, 55.9986, 37.239)], "56:37": [point(2, 56.0004, 37.244)] });
  await render();
  expect([...markers()].map(item => item.getAttribute("data-place")).sort()).toEqual(["osm:node:1", "osm:node:2"]);
  expect(catalogCalls(fetcher).sort()).toEqual(["/api/content/map-cells", "/api/content/map-cells/55/37", "/api/content/map-cells/56/37"]);
  expect(catalogStatus()).toBeNull();
});
