// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ExploreMap, type MapItem } from "./explore-map";

let root: Root;
let container: HTMLDivElement;

const items = (): MapItem[] => [
  {
    id: "a",
    title: "Остановка 1: Дом",
    location: { lat: 55.75, lon: 37.6 },
    number: 1,
  },
  {
    id: "b",
    title: "Остановка 2: Сад",
    location: { lat: 55.751, lon: 37.601 },
    number: 2,
  },
];

async function render(value: MapItem[], selectedId?: string) {
  await act(async () => {
    root.render(
      createElement(ExploreMap, {
        items: value,
        selectedId,
        focus: null,
        user: null,
        onSelect: () => {},
        onPoint: () => {},
      }),
    );
  });
}

const pins = () => [
  ...container.querySelectorAll<HTMLElement>('[data-marker="pin"]'),
];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(600);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("keeps marker elements and keyboard focus across re-renders and selection", async () => {
  await render(items());
  await vi.waitFor(() => expect(pins()).toHaveLength(2));
  const [first, second] = pins();
  first.focus();

  await render(items());
  expect(pins()).toEqual([first, second]);
  expect(pins()[0]).toBe(first);

  await render(items(), "a");
  expect(pins()[0]).toBe(first);
  expect(first.getAttribute("data-selected")).toBe("true");
  expect(first.getAttribute("aria-pressed")).toBe("true");
  expect(document.activeElement).toBe(first);

  await render([{ ...items()[0], number: 3 }], "a");
  expect(pins()).toEqual([first]);
  expect(second.isConnected).toBe(false);
  expect(first.textContent).toBe("3");
});

it("exposes the map as a labelled region", async () => {
  await render(items());
  const map = container.querySelector('[data-region="map"]');
  expect(map?.getAttribute("role")).toBe("region");
  expect(map?.getAttribute("aria-label")).toMatch(/^Карта историй/);
});

const catalog = (): MapItem[] => [
  { id: "c", title: "Каталог: дом", location: { lat: 55.7249, lon: 37.6507 }, clusterable: true },
  { id: "d", title: "Каталог: сад", location: { lat: 55.7249, lon: 37.6507 }, clusterable: true },
  {
    id: "e",
    title: "Каталог: башня",
    location: { lat: 55.7249, lon: 37.6507 },
    compact: true,
    clusterable: true,
  },
];
const counts = () =>
  [...container.querySelectorAll<HTMLElement>("[data-cluster-count]")].map(
    (node) => Number(node.dataset.clusterCount),
  );

it("clusters catalog pages, updates counts after removal, and keeps route stops separate", async () => {
  await render([...catalog().slice(0, 2), ...items()]);
  await vi.waitFor(() => expect(counts()).toEqual([2]));
  expect(pins()).toHaveLength(2);
  await render([...catalog(), ...items()]);
  expect(counts()).toEqual([3]);
  expect(
    container
      .querySelector('[data-marker="cluster"]')
      ?.getAttribute("aria-label"),
  ).toBe("Мест: 3. Нажмите, чтобы раскрыть группу");
  await render([...catalog().slice(1), ...items()]);
  expect(counts()).toEqual([2]);
  await render(items());
  expect(counts()).toEqual([]);
  expect(pins().map((pin) => pin.title)).toEqual(
    items().map((item) => item.title),
  );
});

it("keeps selected and pending places outside clusters and restores groups on deselection", async () => {
  const pending = {
    id: "pending",
    title: "Готовим историю",
    location: catalog()[0].location,
    pending: true,
  };
  await render([...catalog(), pending], "c");
  await vi.waitFor(() => expect(counts()).toEqual([2]));
  expect(pins().map((pin) => pin.title)).toEqual([
    "Каталог: дом",
    "Готовим историю",
  ]);
  expect(pins()[0].getAttribute("aria-pressed")).toBe("true");
  await render([...catalog(), pending]);
  expect(counts()).toEqual([3]);
  expect(pins().map((pin) => pin.title)).toEqual(["Готовим историю"]);
});

it("keeps the user's own finished stories outside catalog clusters", async () => {
  const own = { id: "job", title: "Моя история", location: catalog()[0].location };
  await render([...catalog(), own]);
  await vi.waitFor(() => expect(counts()).toEqual([3]));
  expect(pins().map((pin) => pin.title)).toEqual(["Моя история"]);
});

it("reindexes a catalog marker after its source coordinates change", async () => {
  const places = catalog().slice(0, 2);
  await render(places);
  await vi.waitFor(() => expect(counts()).toEqual([2]));
  await render([
    places[0],
    { ...places[1], location: { lat: 55.7249, lon: 37.6537 } },
  ]);
  expect(counts()).toEqual([]);
  expect(
    pins()
      .map((pin) => pin.title)
      .sort(),
  ).toEqual(places.map((place) => place.title).sort());
  await render(places);
  expect(counts()).toEqual([2]);
});
