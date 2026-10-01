import type * as Leaflet from "leaflet";
import type { Coordinates } from "../tour/types";

export type CatalogBounds = { west: number; south: number; east: number; north: number };
export type CatalogArea = { required: CatalogBounds; buffered: CatalogBounds };

/** Project pixels at the target zoom: padding latitude directly is not Mercator-correct. */
export function catalogArea(map: Pick<Leaflet.Map, "getCenter" | "getZoom" | "getMinZoom" | "getSize" | "project" | "unproject">): CatalogArea {
  const size = map.getSize();
  const bounds = (steps: number): CatalogBounds => {
    const zoom = Math.max(map.getMinZoom(), map.getZoom() - steps);
    const center = map.project(map.getCenter(), zoom);
    const sw = map.unproject([center.x - size.x / 2, center.y + size.y / 2], zoom);
    const ne = map.unproject([center.x + size.x / 2, center.y - size.y / 2], zoom);
    // The public catalog uses non-wrapping rectangles; a wrapped world view loads the world once.
    const wraps = sw.lng < -180 || ne.lng > 180;
    return { west: wraps ? -180 : sw.lng, south: Math.max(-90, sw.lat), east: wraps ? 180 : ne.lng, north: Math.min(90, ne.lat) };
  };
  return { required: bounds(0.5), buffered: bounds(2) };
}

/** Bounding rectangle of a spherical cap, enclosing the entire nearby search radius. */
export function nearbyBounds(center: Coordinates, radius: number): CatalogBounds {
  const rad = Math.PI / 180;
  const angular = radius / 6371000;
  const dy = angular / rad;
  const dx = Math.asin(Math.sin(angular) / Math.cos(center.lat * rad)) / rad;
  return { west: center.lon - dx, south: center.lat - dy, east: center.lon + dx, north: center.lat + dy };
}
