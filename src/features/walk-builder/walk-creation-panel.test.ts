// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { WalkCreationPanel } from "./walk-creation-panel";
import { DRAFT_KEY, emptyDraft } from "./model";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, replace: () => {} }) }));

let root: Root;
let container: HTMLDivElement;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  fetchMock = vi.fn(async () => new Response("{}", { status: 404 }));
  vi.stubGlobal("fetch", fetchMock);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  container.remove();
  vi.unstubAllGlobals();
});

const button = (name: string) => [...container.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name);

it("ignores a geolocation fix that arrives after the panel was closed", async () => {
  let deliver: PositionCallback | undefined;
  const geolocation = { getCurrentPosition: (success: PositionCallback) => { deliver = success; }, watchPosition: () => 1, clearWatch: () => {} };
  vi.stubGlobal("navigator", { ...navigator, geolocation, permissions: undefined });
  await act(async () => {
    root.render(createElement(WalkCreationPanel, { onClose: () => {}, onMap: () => {}, picked: null }));
  });
  await act(async () => { button("Откуда")?.click(); });
  await act(async () => { button("Моё местоположение")?.click(); });
  expect(deliver).toBeTypeOf("function");

  await act(async () => { root.unmount(); });
  await act(async () => { deliver?.({ coords: { latitude: 55.75, longitude: 37.6, accuracy: 10 }, timestamp: 0 } as GeolocationPosition); });

  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/story-place"))).toEqual([]);
});

function stubGeolocation() {
  const channels: { coarse?: PositionCallback; precise?: PositionCallback; coarseError?: PositionErrorCallback; preciseError?: PositionErrorCallback } = {};
  const geolocation = {
    getCurrentPosition: (success: PositionCallback, error: PositionErrorCallback) => { channels.coarse = success; channels.coarseError = error; },
    watchPosition: (success: PositionCallback, error: PositionErrorCallback) => { channels.precise = success; channels.preciseError = error; return 1; },
    clearWatch: () => {},
  };
  vi.stubGlobal("navigator", { ...navigator, geolocation, permissions: undefined });
  return channels;
}

const fix = (latitude: number, accuracy: number) => ({ coords: { latitude, longitude: 37.6, accuracy }, timestamp: 0 }) as GeolocationPosition;

async function openLocation() {
  await act(async () => {
    root.render(createElement(WalkCreationPanel, { onClose: () => {}, onMap: () => {}, picked: null }));
  });
  await act(async () => { button("Откуда")?.click(); });
  await act(async () => { button("Моё местоположение")?.click(); });
}

it("looks up the address of the refined fix, not the first coarse one", async () => {
  const channels = stubGeolocation();
  await openLocation();

  await act(async () => { channels.coarse?.(fix(55.7, 400)); });
  expect(fetchMock.mock.calls.filter(([url]) => String(url).includes("/api/story-place"))).toEqual([]);
  await act(async () => { channels.precise?.(fix(55.75, 12)); });

  const lookups = fetchMock.mock.calls.map(([url]) => String(url)).filter(url => url.includes("/api/story-place"));
  expect(lookups).toHaveLength(1);
  expect(new URL(lookups[0], "http://localhost").searchParams.get("lat")).toBe("55.75");
});

it("explains that device location services may be off when no fix arrives", async () => {
  const channels = stubGeolocation();
  await openLocation();

  await act(async () => { channels.coarseError?.({ code: 2 } as GeolocationPositionError); });
  expect(container.textContent).not.toContain("геолокация включена");
  await act(async () => { channels.preciseError?.({ code: 3 } as GeolocationPositionError); });
  expect(container.textContent).toContain("Проверьте, что геолокация включена в настройках устройства. Выберите точку на карте или введите адрес.");
});

it("с построенным маршрутом показывает форму и «Открыть прогулку», а правка возвращает «Построить прогулку»", async () => {
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const stop = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };
  const route = { stops: [stop], geometry: [start.location, stop.location, start.location], walkingMinutes: 25, distanceM: 1800, attribution: "OSM" };
  localStorage.setItem(DRAFT_KEY, JSON.stringify({ ...emptyDraft(), start, stops: [stop], route }));
  history.replaceState(null, "", "/?walk=create&resume=1");
  try {
    await act(async () => { root.render(createElement(WalkCreationPanel, { onClose: () => {}, onMap: () => {}, picked: null })); });
    expect(container.querySelector("h1")?.textContent).toBe("Прогулка");
    expect(button("Открыть прогулку")).toBeTruthy();
    expect(button("Построить прогулку")).toBeUndefined();
    expect(container.textContent).toContain("Остановки · 1");
    await act(async () => { button("Куда")?.click(); });
    await act(async () => { button("По времени")?.click(); });
    await act(async () => { button("60 мин")?.click(); });
    expect(button("Открыть прогулку")).toBeUndefined();
    expect(button("Построить прогулку")).toBeTruthy();
  } finally { history.replaceState(null, "", "/"); }
});
