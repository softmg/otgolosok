// @vitest-environment jsdom
import * as L from "leaflet";
import { expect, it } from "vitest";
import { catalogArea, containsBounds, nearbyBounds } from "./catalog-bounds";
import { distanceMeters } from "../../lib/geo/distance";

function map(zoom: number, width: number, height: number) {
  const center = L.latLng(55.7249, 37.6507);
  return {
    getCenter: () => center, getZoom: () => zoom, getMinZoom: () => 10,
    getSize: () => L.point(width, height),
    project: (point: L.LatLngExpression, z: number) => L.CRS.EPSG3857.latLngToPoint(L.latLng(point), z),
    unproject: (point: L.PointExpression, z: number) => L.CRS.EPSG3857.pointToLatLng(L.point(point), z),
  };
}
it.each([[390, 844], [1440, 1000]])("loads exactly two zoom-out steps on a %i × %i screen", (width, height) => {
  const m = map(16, width, height);
  const area = catalogArea(m);
  const west = m.project([area.buffered.north, area.buffered.west], 16);
  const east = m.project([area.buffered.south, area.buffered.east], 16);
  expect(east.x - west.x).toBeCloseTo(width * 4, 5);
  expect(east.y - west.y).toBeCloseTo(height * 4, 5);
  expect(containsBounds(area.buffered, area.required)).toBe(true);
  expect(containsBounds(area.buffered, catalogArea(map(15, width, height)).required)).toBe(true);
  expect(containsBounds(area.buffered, catalogArea(map(14, width, height)).required)).toBe(false);
});
it("respects minimum zoom and an inclusive coverage boundary", () => {
  const area = catalogArea(map(10, 390, 844));
  expect(area.required).toEqual(area.buffered);
  expect(containsBounds(area.required, area.required)).toBe(true);
  expect(containsBounds(area.required, { ...area.required, east: area.required.east + 0.001 })).toBe(false);
});
it.each([100, 200, 300])("includes the whole nearby radius of %i metres", radius => {
  const center = { lat: 55.75, lon: 37.6 };
  const bounds = nearbyBounds(center, radius);
  expect(distanceMeters(center, { ...center, lat: bounds.north })).toBeCloseTo(radius, 5);
  expect(distanceMeters(center, { ...center, lat: bounds.south })).toBeCloseTo(radius, 5);
  expect(distanceMeters(center, { ...center, lon: bounds.east })).toBeGreaterThanOrEqual(radius - 0.00001);
});
