import { createExpression, featureFilter, validateStyleMin } from "@maplibre/maplibre-gl-style-spec";
import { expect, it } from "vitest";
import { contentSecurityPolicy } from "../../../scripts/content-security-policy.mjs";
import { MAP_ICONS, mapIconId, type MapIcon } from "./map-icons";
import { ESA_LANDCOVER_MAX_ZOOM, MAP_TILES_ORIGIN, mapStyle } from "./map-style";

it("passes the MapLibre style specification", () => {
  expect(validateStyleMin(mapStyle).map(error => error.message)).toEqual([]);
});

it("stays flat and uses only its own generated icons", () => {
  expect(mapStyle).not.toHaveProperty("sprite");
  expect(mapStyle.layers.map(layer => layer.type)).not.toContain("fill-extrusion");
  const iconIds = JSON.stringify(mapStyle.layers.map(layer => "layout" in layer && layer.layout && "icon-image" in layer.layout ? layer.layout["icon-image"] : null))
    .match(/"poi-[a-z_]+"/g)?.map(id => JSON.parse(id) as string) ?? [];
  expect(iconIds.length).toBeGreaterThan(0);
  for (const id of iconIds) expect(Object.keys(MAP_ICONS).map(icon => mapIconId(icon as MapIcon))).toContain(id);
});

/** The icon MapLibre would draw for a point at this zoom, or null if no icon layer takes it. */
function iconAt(zoom: number, sourceLayer: string, properties: Record<string, string>) {
  for (const layer of mapStyle.layers) {
    if (layer.type !== "symbol" || layer["source-layer"] !== sourceLayer || !layer.layout?.["icon-image"]) continue;
    if ((layer.minzoom ?? 0) > zoom || !featureFilter(layer.filter).filter({ zoom }, { type: 1, properties })) continue;
    const icon = createExpression(layer.layout["icon-image"]);
    if (icon.result !== "success") throw new Error(`invalid icon-image in ${layer.id}`);
    return String(icon.value.evaluate({ zoom }, { type: 1, properties }));
  }
  return null;
}

it.each([
  [13, "public_transport", { kind: "station", name: "Третьяковская" }, "poi-station"],
  [12, "public_transport", { kind: "station" }, null],
  [13, "public_transport", { kind: "bus_stop" }, null],
  [15, "pois", { amenity: "place_of_worship", religion: "christian", denomination: "russian_orthodox" }, "poi-orthodox"],
  [15, "pois", { amenity: "place_of_worship", religion: "christian", denomination: "old_believers" }, "poi-orthodox"],
  [15, "pois", { amenity: "place_of_worship", religion: "christian", denomination: "catholic" }, "poi-church"],
  [15, "pois", { amenity: "place_of_worship", religion: "christian" }, "poi-church"],
  [15, "pois", { amenity: "place_of_worship", religion: "jewish" }, "poi-synagogue"],
  [15, "pois", { amenity: "place_of_worship", religion: "muslim" }, "poi-mosque"],
  [15, "pois", { amenity: "place_of_worship", religion: "buddhist" }, null],
  [15, "pois", { amenity: "theatre" }, "poi-theatre"],
  [15, "pois", { tourism: "viewpoint" }, "poi-viewpoint"],
  [14, "pois", { amenity: "theatre" }, null],
  [16, "pois", { amenity: "toilets" }, "poi-toilets"],
  [16, "pois", { amenity: "drinking_water" }, "poi-water"],
  [15, "pois", { amenity: "toilets" }, null],
  [17, "pois", { historic: "memorial" }, "poi-memorial"],
  [17, "pois", { historic: "monument" }, "poi-monument"],
  [17, "pois", { tourism: "artwork" }, "poi-monument"],
  [16, "pois", { historic: "memorial" }, null],
  [18, "pois", { amenity: "cafe" }, null],
  [18, "pois", { amenity: "restaurant" }, null],
  [18, "pois", { amenity: "bench" }, null],
])("at z%i shows %s %o as %s", (zoom, sourceLayer, properties, icon) => {
  expect(iconAt(zoom, sourceLayer, properties)).toBe(icon);
});

const landLayers = mapStyle.layers.filter(layer => "source-layer" in layer && layer["source-layer"] === "land");
const drawsAt = (zoom: number, kind: string) => landLayers.some(layer =>
  (layer.minzoom ?? 0) <= zoom && "filter" in layer && featureFilter(layer.filter).filter({ zoom }, { type: 3, properties: { kind } }));

it("never draws ESA WorldCover landcover, which owes credit beyond OpenStreetMap", () => {
  for (const [kind, maxZoom] of Object.entries(ESA_LANDCOVER_MAX_ZOOM)) {
    for (let zoom = 0; zoom <= maxZoom; zoom++) expect(drawsAt(zoom, kind), `${kind} at z${zoom}`).toBe(false);
  }
});

it.each([
  [3, "park"],
  [7, "forest"],
  [10, "forest"],
  [10, "cemetery"],
  [11, "scrub"],
  [16, "garden"],
])("draws OSM greenery at z%i: %s", (zoom, kind) => {
  expect(drawsAt(zoom, kind)).toBe(true);
});

it("fetches tiles and glyphs only from the origin the CSP allows", () => {
  const urls = [mapStyle.glyphs, ...Object.values(mapStyle.sources).flatMap(source => source.tiles)];
  for (const url of urls) expect(new URL(url.replace(/[{}]/g, "")).origin).toBe(MAP_TILES_ORIGIN);
  expect(contentSecurityPolicy([])).toContain(`connect-src 'self' ${MAP_TILES_ORIGIN};`);
});

it.each([
  ["river", "Москва", true],
  ["canal", "канал имени Москвы", true],
  ["stream", "Кожевнический вражек", false],
  ["ditch", "Канава", false],
  ["drain", "Сток", false],
])("names a waterway of kind %s only if it is a river or canal", (kind, name, named) => {
  const labels = mapStyle.layers.filter(layer => "source-layer" in layer && layer["source-layer"] === "water_lines_labels");
  expect(labels.length).toBeGreaterThan(0);
  const feature = { type: 2 as const, properties: { kind, name } };
  const shown = labels.some(layer => "filter" in layer && featureFilter(layer.filter).filter({ zoom: 16 }, feature));
  expect(shown).toBe(named);
});
