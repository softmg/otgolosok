// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AroundScreen } from "./around-screen";
import type { MapItem } from "./explore-map";
import type { Route } from "../tour/types";
import exampleRoute from "../../../public/data/routes/paveletskaya.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("../walk-builder/walk-creation-panel", () => ({ WalkCreationPanel: () => null }));
vi.mock("../navigation/app-navigation", () => ({ AppNavigation: () => null }));
vi.mock("./explore-map", () => ({ ExploreMap: ({ items, onViewport }: { items: MapItem[]; onViewport: (area: import("./catalog-bounds").CatalogArea) => void }) => {
  useEffect(() => { onViewport({ required: { west: 37.59, south: 55.74, east: 37.61, north: 55.76 }, buffered: { west: 37.56, south: 55.71, east: 37.64, north: 55.79 } }); }, [onViewport]);
  return createElement("div", { "data-testid": "map" }, items.map(item => createElement("span", { key: item.id, "data-place": item.id }, item.title)));
} }));

let root: Root;
let container: HTMLDivElement;
const places = Array.from({ length: 205 }, (_, index) => ({
  id: `osm:node:${index + 1}`, name: `Место ${index + 1}`, address: "Москва",
  location: { lat: 55.75, lon: 37.6 }, audio: null, distanceM: null,
  story: { title: `История ${index + 1}`, paragraphs: [{ text: "Проверенный рассказ." }] },
}));
const route = { pois: [], chapters: [] } as unknown as Route;
const markers = () => container.querySelectorAll('[data-place^="osm:"]');
const response = (offset: number) => Response.json({ places: places.slice(offset, offset + 100), total: places.length, hasMore: offset + 100 < places.length });
const stubCatalogFetch = (fetcher: (path: string, options?: RequestInit) => Promise<Response>) => {
  vi.stubGlobal("fetch", (path: string, options?: RequestInit) => path === "/service-status"
    ? Promise.resolve(Response.json({ maintenance: false })) : fetcher(path, options));
};

beforeEach(() => {
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

it("automatically restores the map after maintenance even when the status endpoint is healthy", async () => {
  vi.useFakeTimers();
  let maintenance = true;
  stubCatalogFetch(vi.fn(async (path: string) => {
    const offset = Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0);
    return offset === 100 && maintenance
      ? Response.json({ error: { code: "SERVICE_MAINTENANCE" } }, { status: 503 }) : response(offset);
  }));
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  await act(async () => vi.advanceTimersByTimeAsync(3_000));
  expect(markers()).toHaveLength(100);
  expect(container.textContent).toContain("Сервис обновляется. Карта загрузится автоматически.");
  expect([...container.querySelectorAll("button")].some(button => button.textContent === "Повторить загрузку мест")).toBe(false);
  expect(container.querySelector("progress")).toBeNull();
  maintenance = false;
  await act(async () => vi.advanceTimersByTimeAsync(5_000));
  expect(markers()).toHaveLength(205);
  expect(container.querySelector('[data-region="catalog-status"]')).toBeNull();
});

it("renders every approved place beyond the first hundred", async () => {
  stubCatalogFetch(vi.fn(async (path: string) => response(Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0))));
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  expect(markers()).toHaveLength(205);
  expect(container.querySelector('[data-place="osm:node:205"]')?.textContent).toBe("История 205");
});

it("does not add built-in walk stops or the Melnikov demo to the public map", async () => {
  stubCatalogFetch(vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
  await act(async () => root.render(createElement(AroundScreen, { route: exampleRoute as Route, onStart: () => {}, updateAvailable: false })));
  expect(container.querySelectorAll("[data-place]")).toHaveLength(0);
});

it("preserves the explicitly opened current chapter without adding the other walk stops", async () => {
  stubCatalogFetch(vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
  let started: number | undefined;
  await act(async () => root.render(createElement(AroundScreen, {
    route: exampleRoute as Route, openChapter: 2, onStart: index => { started = index; }, updateAvailable: false,
  })));
  expect(container.querySelectorAll("[data-place]")).toHaveLength(1);
  expect(container.querySelector('[data-place="housing"]')?.textContent).toBe("Жизнь после смены");
  const start = [...container.querySelectorAll("button")].find(button => button.textContent?.includes("Слушать эту часть"));
  await act(async () => start!.click());
  expect(started).toBe(2);
});

it("does not recommend built-in places after geolocation", async () => {
  stubCatalogFetch(vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.7249, longitude: 37.6507, accuracy: 10 } } as GeolocationPosition) } });
  await act(async () => root.render(createElement(AroundScreen, { route: exampleRoute as Route, onStart: () => {}, updateAvailable: false })));
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(container.querySelectorAll('[data-sheet="nearby"] li')).toHaveLength(0);
  expect(container.textContent).toContain("В этом радиусе пока нет готовой проверенной истории.");
});

it("shows loading before the first response and progress until the final page", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  stubCatalogFetch(fetcher);
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  expect(container.querySelector('[data-region="catalog-status"] [role="status"]')?.textContent).toContain("Загружаем места");
  await act(async () => finish(response(0)));
  expect(container.querySelector('[data-region="catalog-status"] [role="status"]')?.textContent).toContain("100 из 205");
  expect(container.querySelector("progress")?.value).toBe(100);
  await act(async () => finish(response(100)));
  expect(container.querySelector('[data-region="catalog-status"] [role="status"]')?.textContent).toContain("200 из 205");
  await act(async () => finish(response(200)));
  expect(container.querySelector('[data-region="catalog-status"]')).toBeNull();
  expect(markers()).toHaveLength(205);
});

it("keeps loaded markers after a failed page and completes the catalog on retry", async () => {
  let failing = true;
  stubCatalogFetch(vi.fn(async (path: string) => {
    const offset = Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0);
    return offset === 100 && failing ? Response.json({}, { status: 400 }) : response(offset);
  }));
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  expect(markers()).toHaveLength(100);
  expect(container.textContent).toContain("Не все места загрузились.");
  failing = false;
  const retry = [...container.querySelectorAll("button")].find(button => button.textContent === "Повторить загрузку мест");
  expect(retry).toBeDefined();
  await act(async () => retry!.click());
  expect(markers()).toHaveLength(205);
  expect(container.textContent).not.toContain("Не все места загрузились.");
});

it("keeps loaded map places and separately fetches the complete nearby radius", async () => {
  const fetcher = vi.fn(async (path: string) => response(Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0)));
  stubCatalogFetch(fetcher);
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.75, longitude: 37.6, accuracy: 10 } } as GeolocationPosition) } });
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(markers()).toHaveLength(205);
  expect(container.textContent).toContain("Готовые истории рядом");
  expect(fetcher).toHaveBeenCalledTimes(6);
  const nearbyQuery = new URL(fetcher.mock.calls[3][0], "http://localhost").searchParams;
  expect(Number(nearbyQuery.get("west"))).toBeGreaterThan(37.59);
  expect(Number(nearbyQuery.get("east"))).toBeLessThan(37.61);
});

it("waits for a remote nearby radius before declaring it empty and shows its stories", async () => {
  let finish!: (response: Response) => void;
  stubCatalogFetch(vi.fn((path: string) => {
    const west = Number(new URL(path, "http://localhost").searchParams.get("west"));
    if (west > 37.65) return new Promise<Response>(resolve => { finish = resolve; });
    return Promise.resolve(Response.json({ places: [], total: 0, hasMore: false }));
  }));
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.8, longitude: 37.7, accuracy: 10 } } as GeolocationPosition) } });
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(container.textContent).toContain("Ищем истории рядом…");
  expect(container.textContent).not.toContain("В этом радиусе пока нет");
  await act(async () => finish(Response.json({ places: [{ ...places[0], location: { lat: 55.8, lon: 37.7 }, audio: { url: "/story.mp3", durationSec: 60 } }], total: 1, hasMore: false })));
  expect(container.querySelector('[data-sheet="nearby"] li')?.textContent).toContain("История 1");
  expect(markers()).toHaveLength(1);
  expect(container.textContent).not.toContain("Ищем истории рядом…");
  await act(async () => ([...container.querySelectorAll("button")].find(button => button.textContent === "300 м")!).click());
  expect(container.textContent).toContain("Ищем истории рядом…");
  await act(async () => finish(Response.json({}, { status: 400 })));
  expect(container.textContent).toContain("Не удалось загрузить все истории рядом");
  expect(container.querySelector('[data-sheet="nearby"] li')?.textContent).toContain("История 1");
  expect(container.textContent).not.toContain("В этом радиусе пока нет");
});
