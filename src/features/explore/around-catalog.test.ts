// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AroundScreen } from "./around-screen";
import type { MapItem } from "./explore-map";
import type { Route } from "../tour/types";
import exampleRoute from "../../../public/data/routes/paveletskaya.json";

vi.mock("next/navigation", () => ({ useRouter: () => ({}), usePathname: () => "/", useSearchParams: () => new URLSearchParams() }));
vi.mock("../walk-builder/walk-creation-panel", () => ({ WalkCreationPanel: () => null }));
vi.mock("../navigation/app-navigation", () => ({ AppNavigation: () => null }));
vi.mock("./explore-map", () => ({ ExploreMap: ({ items }: { items: MapItem[] }) => createElement("div", { "data-testid": "map" }, items.map(item => createElement("span", { key: item.id, "data-place": item.id }, item.title))) }));

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

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
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
});

it("renders every approved place beyond the first hundred", async () => {
  vi.stubGlobal("fetch", vi.fn(async (path: string) => response(Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0))));
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  expect(markers()).toHaveLength(205);
  expect(container.querySelector('[data-place="osm:node:205"]')?.textContent).toBe("История 205");
});

it("does not add built-in walk stops or the Melnikov demo to the public map", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
  await act(async () => root.render(createElement(AroundScreen, { route: exampleRoute as Route, onStart: () => {}, updateAvailable: false })));
  expect(container.querySelectorAll("[data-place]")).toHaveLength(0);
});

it("preserves the explicitly opened current chapter without adding the other walk stops", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
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
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ places: [], total: 0, hasMore: false })));
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.7249, longitude: 37.6507, accuracy: 10 } } as GeolocationPosition) } });
  await act(async () => root.render(createElement(AroundScreen, { route: exampleRoute as Route, onStart: () => {}, updateAvailable: false })));
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(container.querySelectorAll(".nearby-story-list li")).toHaveLength(0);
  expect(container.textContent).toContain("В этом радиусе пока нет готовой проверенной истории.");
});

it("shows loading before the first response and progress until the final page", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn(() => new Promise<Response>(resolve => { finish = resolve; }));
  vi.stubGlobal("fetch", fetcher);
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  expect(container.querySelector('.around-catalog-status [role="status"]')?.textContent).toContain("Загружаем места");
  await act(async () => finish(response(0)));
  expect(container.querySelector('.around-catalog-status [role="status"]')?.textContent).toContain("100 из 205");
  expect(container.querySelector("progress")?.value).toBe(100);
  await act(async () => finish(response(100)));
  expect(container.querySelector('.around-catalog-status [role="status"]')?.textContent).toContain("200 из 205");
  await act(async () => finish(response(200)));
  expect(container.querySelector(".around-catalog-status")).toBeNull();
  expect(markers()).toHaveLength(205);
});

it("keeps loaded markers after a failed page and completes the catalog on retry", async () => {
  let failing = true;
  vi.stubGlobal("fetch", vi.fn(async (path: string) => {
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

it("keeps the complete city catalog when geolocation changes the nearby center", async () => {
  const fetcher = vi.fn(async (path: string) => response(Number(new URL(path, "http://localhost").searchParams.get("offset") ?? 0)));
  vi.stubGlobal("fetch", fetcher);
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition: (success: PositionCallback) => success({ coords: { latitude: 55.75, longitude: 37.6, accuracy: 10 } } as GeolocationPosition) } });
  await act(async () => root.render(createElement(AroundScreen, { route, onStart: () => {}, updateAvailable: false })));
  await act(async () => (container.querySelector('[aria-label="Моё местоположение"]') as HTMLButtonElement).click());
  expect(markers()).toHaveLength(205);
  expect(container.textContent).toContain("Готовые истории рядом");
  expect(fetcher).toHaveBeenCalledTimes(3);
});
