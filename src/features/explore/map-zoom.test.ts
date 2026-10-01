// @vitest-environment jsdom

import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as Leaflet from "leaflet";
import { MAP_MIN_ZOOM, MAP_ZOOM_OPTIONS } from "./explore-map";
import { loadMapLibrary } from "./map-clusters";

let map: Leaflet.Map;
let element: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  const L = await loadMapLibrary();
  // Leaflet honours fractional zoomSnap only with CSS 3D transforms, which every supported browser has and jsdom lacks.
  Object.defineProperty(L.Browser, "any3d", { value: true });
  element = document.createElement("div");
  document.body.append(element);
  map = L.map(element, { ...MAP_ZOOM_OPTIONS, zoomAnimation: false, minZoom: MAP_MIN_ZOOM, maxZoom: 19 }).setView([55.75, 37.62], 14);
});
afterEach(() => {
  map.remove();
  element.remove();
  vi.useRealTimers();
});

const wheel = (deltaY: number) => {
  element.dispatchEvent(new WheelEvent("wheel", { deltaY, deltaMode: 0, clientX: 0, clientY: 0, bubbles: true, cancelable: true }));
  vi.advanceTimersByTime(100);
};

it.each([
  ["a touchpad tick moves a fraction of a level", 10, 13.75],
  ["a mouse notch moves one level", 100, 13],
  ["zooming in by a touchpad tick is symmetric", -10, 14.25],
])("%s", (_name, deltaY, zoom) => {
  wheel(deltaY);
  expect(map.getZoom()).toBe(zoom);
});

it("the zoom buttons still step one whole level", () => {
  map.zoomOut();
  expect(map.getZoom()).toBe(13);
});
