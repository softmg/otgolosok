import { afterEach, expect, it, vi } from "vitest";
import type { ExploreMapProps, MapFocus, MapViewState } from "./explore-map";

const mock = vi.hoisted(() => ({
  effects: [] as Array<() => void | (() => void)>,
  mapOptions: [] as unknown[],
  basemaps: [] as unknown[],
  tileLayers: [] as string[],
  panes: [] as Array<{ name: string; zIndex: string; classes: Set<string> }>,
  polylines: [] as Array<{ points: number[][]; options: Record<string, unknown>; attributes: Map<string, string>; group?: unknown }>,
  arrows: [] as Array<{ options: Record<string, unknown>; html: string; group?: unknown }>,
  maps: [] as Array<{
    setView: ReturnType<
      typeof vi.fn<([lat, lng]: number[], zoom: number) => unknown>
    >;
    panBy: ReturnType<typeof vi.fn>;
    fire: (event: string) => void;
    fitBounds: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("react", () => ({
  useRef: (current: unknown) => ({ current: current ?? {} }),
  useImperativeHandle: () => {},
  useState: () => [true, vi.fn()],
  useEffect: (effect: () => void | (() => void)) => mock.effects.push(effect),
}));
vi.mock("./map-clusters", () => ({
  loadMapLibrary: () => import("leaflet"),
  createMapClusters: () => ({
    addTo: vi.fn().mockReturnThis(),
    addLayers: vi.fn(),
    dispose: vi.fn(),
  }),
}));
vi.mock("leaflet", () => {
  const layer = () => {
    const group = {
      addTo: vi.fn().mockReturnThis(),
      on: vi.fn().mockReturnThis(),
      clearLayers: vi.fn(() => {
        mock.polylines = mock.polylines.filter((item) => item.group !== group);
        mock.arrows = mock.arrows.filter((item) => item.group !== group);
      }),
      getContainer: () => null,
    };
    return group;
  };
  const element = (attributes: Map<string, string>) => ({
    setAttribute: (name: string, value: string) => attributes.set(name, value),
  });
  return {
    map: (_element: unknown, options: unknown) => {
      mock.mapOptions.push(options);
      let center = { lat: 0, lng: 0 },
        zoom = 0,
        removed = false;
      const listeners = new Map<string, Set<() => void>>();
      const map = {
        setView: vi.fn(([lat, lng]: number[], value: number) => {
          center = { lat, lng };
          zoom = value;
          return map;
        }),
        getCenter: () => {
          if (removed) throw new Error("Cannot read a removed map");
          return center;
        },
        getZoom: () => zoom,
        on: (events: string, handler: () => void) => {
          for (const event of events.split(" ")) {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(handler);
          }
        },
        off: (events: string, handler: () => void) => {
          for (const event of events.split(" "))
            listeners.get(event)?.delete(handler);
        },
        fire: (event: string) => {
          listeners.get(event)?.forEach((handler) => handler());
        },
        remove: vi.fn(() => {
          removed = true;
        }),
        invalidateSize: vi.fn(),
        panBy: vi.fn(),
        fitBounds: vi.fn(),
        getBoundsZoom: () => 16,
        createPane: (name: string) => {
          const pane = { name, zIndex: "", classes: new Set<string>() };
          mock.panes.push(pane);
          return {
            style: {
              set zIndex(value: string) {
                pane.zIndex = value;
              },
            },
            classList: {
              add: (value: string) => pane.classes.add(value),
              toggle: (value: string, on: boolean) =>
                on ? pane.classes.add(value) : pane.classes.delete(value),
            },
          };
        },
        // One degree is 10 000 px, enough for a few chevrons on a short test leg.
        latLngToLayerPoint: ([lat, lng]: number[]) => ({ x: lng * 10000, y: -lat * 10000 }),
        layerPointToLatLng: ([x, y]: number[]) => [-y / 10000, x / 10000],
        getSize: () => ({ x: 390, y: 844 }),
        getMinZoom: () => 3,
        getMaxZoom: () => 19,
      };
      mock.maps.push(map);
      return map;
    },
    tileLayer: (url: string) => {
      mock.tileLayers.push(url);
      return layer();
    },
    layerGroup: layer,
    control: { zoom: layer, scale: layer },
    latLngBounds: (points: unknown) => points,
    divIcon: (options: { html: string }) => options,
    svg: (options: Record<string, unknown>) => ({ options }),
    polyline: (points: number[][], options: Record<string, unknown>) => {
      const entry: (typeof mock.polylines)[number] = { points, options, attributes: new Map() };
      mock.polylines.push(entry);
      const line = { addTo: (group: unknown) => { entry.group = group; return line; }, getElement: () => element(entry.attributes) };
      return line;
    },
    marker: (_point: unknown, options: Record<string, unknown> & { icon: { html: string } }) => {
      const entry: (typeof mock.arrows)[number] = { options, html: options.icon.html };
      mock.arrows.push(entry);
      const marker = { addTo: (group: unknown) => { entry.group = group; return marker; }, getElement: () => element(new Map()) };
      return marker;
    },
  };
});
vi.mock("@maplibre/maplibre-gl-leaflet", () => {
  class MaplibreGL {
    constructor(options: unknown) {
      mock.basemaps.push(options);
    }
    static extend() {
      return this;
    }
    addTo() {
      return this;
    }
    getMaplibreMap() {
      return { on: vi.fn() };
    }
  }
  return { MaplibreGL };
});

import { ExploreMap, FALLBACK_TILE_URL, MAP_MIN_ZOOM } from "./explore-map";
import { mapStyle } from "./map-style";

afterEach(() => {
  mock.effects = [];
  mock.mapOptions = [];
  mock.maps = [];
  mock.basemaps = [];
  mock.tileLayers = [];
  mock.panes = [];
  mock.polylines = [];
  mock.arrows = [];
  vi.unstubAllGlobals();
});

async function mount(
  viewState?: MapViewState,
  focus: MapFocus | null = null,
  canvas: { context: unknown } = { context: { getExtension: () => null } },
  props: Partial<ExploreMapProps> = {},
) {
  vi.stubGlobal("matchMedia", () => ({ matches: true }));
  vi.stubGlobal("document", {
    createElement: () => ({ getContext: () => canvas.context }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("getComputedStyle", () => ({ getPropertyValue: () => "" }));
  mock.effects = [];
  ExploreMap({
    items: [],
    focus,
    user: null,
    onSelect: vi.fn(),
    onPoint: vi.fn(),
    viewState,
    ...props,
  });
  // Effects in declaration order: handlers, status, map creation, then the view effects.
  const effects = [...mock.effects];
  effects[0]();
  effects[1]();
  const cleanup = effects[2]();
  await vi.dynamicImportSettled();
  effects.slice(3).forEach((effect) => effect());
  return { map: mock.maps.at(-1)!, cleanup };
}

it("restores the actual center and zoom after leaving and returning to the map", async () => {
  const state: MapViewState = { current: null };
  const first = await mount(state);
  expect(first.map.setView).toHaveBeenCalledWith([55.752, 37.6175], 14);
  first.map.setView([55.76, 37.61], 14);
  first.cleanup?.();
  const returned = await mount(state);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith(
    [55.76, 37.61],
    14,
  );
  returned.cleanup?.();
});

it("does not replay old focus, but allows a new selection to recenter", async () => {
  const focus = { lat: 55.75, lon: 37.6 };
  const state: MapViewState = { current: null };
  const first = await mount(state, focus);
  first.map.setView([55.76, 37.61], 14);
  first.cleanup?.();
  const returned = await mount(state, focus);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith(
    [55.76, 37.61],
    14,
  );
  expect(returned.map.panBy).not.toHaveBeenCalled();
  returned.cleanup?.();
  const selected = await mount(state, { ...focus });
  expect(selected.map.setView).toHaveBeenLastCalledWith([55.75, 37.6], 16, {
    animate: false,
  });
  selected.cleanup?.();
});

it("does not share the nearby viewport with maps that do not opt in", async () => {
  const state: MapViewState = {
    current: { center: { lat: 55.76, lon: 37.61 }, zoom: 14, focus: null },
  };
  const other = await mount();
  expect(other.map.setView).toHaveBeenCalledExactlyOnceWith(
    [55.752, 37.6175],
    14,
  );
  other.cleanup?.();
  expect(state.current?.zoom).toBe(14);
});

it("opens a Moscow overview from a foreign viewport and preserves it across navigation", async () => {
  const state: MapViewState = {
    current: { center: { lat: 52.52, lon: 13.405 }, zoom: 19, focus: null },
  };
  const focus: MapFocus = { lat: 55.74, lon: 37.62, zoom: 12 };
  const first = await mount(state, focus);
  expect(first.map.setView).toHaveBeenLastCalledWith([55.74, 37.62], 12, {
    animate: false,
  });
  first.cleanup?.();
  const returned = await mount(state, focus);
  expect(returned.map.setView).toHaveBeenCalledExactlyOnceWith(
    [55.74, 37.62],
    12,
  );
  returned.cleanup?.();
});

it("ignores late resize events from an unmounted map without losing the saved view", async () => {
  const state: MapViewState = { current: null };
  const first = await mount(state);
  first.map.setView([55.76, 37.61], 14);
  first.map.fire("moveend");
  expect(state.current?.center).toEqual({ lat: 55.76, lon: 37.61 });
  first.cleanup?.();
  const returned = await mount(state);
  returned.map.setView([55.77, 37.62], 15);
  returned.map.fire("zoomend");
  expect(() => {
    first.map.fire("moveend");
    first.map.fire("zoomend");
  }).not.toThrow();
  expect(state.current).toEqual({
    center: { lat: 55.77, lon: 37.62 },
    zoom: 15,
    focus: null,
  });
  returned.cleanup?.();
});

it.each([
  [
    "with WebGL",
    "draws the own vector basemap",
    { getExtension: () => null },
    [{ style: mapStyle, attributionControl: false }],
    [],
  ],
  [
    "without WebGL",
    "falls back to OSM raster tiles",
    null,
    [],
    [FALLBACK_TILE_URL],
  ],
  [
    "with an unimplemented canvas",
    "falls back to OSM raster tiles",
    undefined,
    [],
    [FALLBACK_TILE_URL],
  ],
] as const)("%s %s", async (_, __, context, basemaps, tileLayers) => {
  const { cleanup } = await mount(undefined, null, { context });
  expect(mock.basemaps).toEqual(basemaps);
  expect(mock.tileLayers).toEqual(tileLayers);
  cleanup?.();
});

it("does not zoom out past the scale where the basemap still has greenery", async () => {
  const { cleanup } = await mount();
  expect(mock.mapOptions).toEqual([
    expect.objectContaining({ minZoom: MAP_MIN_ZOOM }),
  ]);
  // Measured on VersaTiles: below z10 OSM greenery is down to a few large forests, the rest is grey.
  expect(MAP_MIN_ZOOM).toBeGreaterThanOrEqual(10);
  cleanup?.();
});

// About 55 m per vertex north: ten vertices, a tunnel over 2..4, the leg 5..8.
const line = Array.from({ length: 10 }, (_, index) => ({ lat: 55.75 + index * 0.0005, lon: 37.6 }));
const routeProps = (activeLeg: [number, number] | null = null): Partial<ExploreMapProps> => ({ geometry: line, fitGeometry: false, tunnels: [[2, 4]], activeLeg });

it("draws the route in its own panes below the markers, created once per map", async () => {
  const { cleanup } = await mount(undefined, null, undefined, routeProps());
  expect(mock.panes.map((pane) => [pane.name, pane.zIndex])).toEqual([["route", "410"], ["routeActive", "420"]]);
  expect(mock.polylines.every((line) => line.options.pane === "route")).toBe(true);
  cleanup?.();
});

it("draws each route pane with a renderer that reaches a full view past every edge", async () => {
  const { cleanup } = await mount(undefined, null, undefined, routeProps([5, 8]));
  const renderers = mock.polylines.map((line) => [line.options.pane, (line.options.renderer as { options: Record<string, unknown> } | undefined)?.options]);
  expect(new Set(renderers.map(([pane]) => pane))).toEqual(new Set(["route", "routeActive"]));
  for (const [pane, options] of renderers) expect(options).toEqual({ pane, padding: 1 });
  cleanup?.();
});

it("dashes the green line over a tunnel and keeps its casing solid", async () => {
  const { cleanup } = await mount(undefined, null, undefined, routeProps());
  const green = mock.polylines.filter((line) => line.attributes.has("data-route"));
  expect(green.map((line) => [line.points.length, line.options.dashArray ?? null, line.attributes.has("data-route-covered")])).toEqual([
    [3, null, false], [3, "6 8", true], [6, null, false],
  ]);
  const casing = mock.polylines.filter((line) => !line.attributes.has("data-route"));
  expect(casing).toHaveLength(3);
  expect(casing.every((line) => line.options.dashArray === undefined)).toBe(true);
  cleanup?.();
});

it("fades everything but the leg to walk and marks its direction", async () => {
  const plain = await mount(undefined, null, undefined, routeProps());
  const dim = (pane: (typeof mock.panes)[number]) => [...pane.classes].some((name) => /dim/i.test(name));
  expect(mock.panes.map(dim)).toEqual([false, false]);
  expect(mock.arrows).toEqual([]);
  plain.cleanup?.();

  mock.panes = [];
  mock.polylines = [];
  const walking = await mount(undefined, null, undefined, routeProps([5, 8]));
  expect(mock.panes.map(dim)).toEqual([true, false]);
  const parts = mock.polylines.filter((line) => line.attributes.has("data-route")).map((line) => [line.attributes.get("data-route-part"), line.options.pane, line.points.length]);
  expect(parts).toEqual([["rest", "route", 3], ["rest", "route", 3], ["rest", "route", 2], ["rest", "route", 2], ["active", "routeActive", 4]]);
  // 15 px of a 0.0015° leg at 10 000 px per degree: one chevron at its middle, pointing north (up the screen).
  expect(mock.arrows).toHaveLength(1);
  expect(mock.arrows[0].options).toMatchObject({ pane: "routeActive", interactive: false, keyboard: false });
  expect(mock.arrows[0].html).toContain('rotate(-90.0)');
  walking.cleanup?.();
});

it("fits the map to a leg without letting a redrawn route undo it", async () => {
  const points = line.slice(5, 9);
  const { map, cleanup } = await mount(undefined, null, undefined, { ...routeProps([5, 8]), fitTarget: { points, keepUserView: false } });
  expect(map.fitBounds).toHaveBeenCalledTimes(1);
  expect(map.fitBounds.mock.calls[0][0]).toEqual(points.map((p) => [p.lat, p.lon]));
  cleanup?.();
});
