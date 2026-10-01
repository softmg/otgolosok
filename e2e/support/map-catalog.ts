import type { Page, Route } from "@playwright/test";

/** A catalog point as the tests describe it: the slim index fields plus the text served on demand. */
export type CatalogFixture = {
  id: string; title: string; address?: string; lat: number; lon: number;
  durationSec?: number | null; facts?: number; sources?: number;
  paragraphs?: string[]; audioUrl?: string; storySources?: unknown[];
};
type Options = {
  /** Called before a manifest, cell or detail answer; may delay it or answer itself (return true). */
  intercept?: (path: string, route: Route) => Promise<boolean | void> | boolean | void;
};

const cellKey = (lat: number, lon: number) => `${Math.floor(lat)}:${Math.floor(lon)}`;
function etagOf(body: string) {
  let hash = 0;
  for (const char of body) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return hash.toString(16).padStart(32, "0");
}

/**
 * Mocks the map index (`/api/content/map-cells` and its 1° cells, with ETags and 304s) and the
 * place details. `places` is read on every request, so a test may change it between requests.
 * Returns the paths requested, in order.
 */
export async function mockMapCatalog(page: Page, places: CatalogFixture[], { intercept }: Options = {}) {
  const requests: string[] = [];
  const cells = () => {
    const grouped = new Map<string, CatalogFixture[]>();
    for (const place of places) grouped.set(cellKey(place.lat, place.lon), [...grouped.get(cellKey(place.lat, place.lon)) ?? [], place]);
    return grouped;
  };
  const cellBody = (key: string) => {
    const [lat, lon] = key.split(":").map(Number);
    const points = (cells().get(key) ?? []).map(place => ({ id: place.id, lat: place.lat, lon: place.lon, title: place.title, address: place.address ?? place.title,
      durationSec: place.durationSec ?? null, facts: place.facts ?? 1, sources: place.sources ?? 1 })).sort((a, b) => a.id < b.id ? -1 : 1);
    return JSON.stringify({ lat, lon, points });
  };
  const respond = (route: Route, body: string) => {
    const etag = `"${etagOf(body)}"`;
    if (route.request().headers()["if-none-match"] === etag) return route.fulfill({ status: 304, headers: { ETag: etag, "Cache-Control": "no-cache" } });
    return route.fulfill({ status: 200, body, contentType: "application/json; charset=utf-8", headers: { ETag: etag, "Cache-Control": "no-cache" } });
  };
  await page.route(/\/api\/content\/(map-cells(\/-?\d+\/-?\d+)?|places\/[^/?]+)$/, async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    if (await intercept?.(path, route)) return;
    if (path === "/api/content/map-cells") {
      const manifest = [...cells().keys()].sort().map(key => {
        const [lat, lon] = key.split(":").map(Number);
        return { lat, lon, count: cells().get(key)!.length, etag: etagOf(cellBody(key)) };
      });
      return respond(route, JSON.stringify({ version: 1, cellSize: 1, cells: manifest }));
    }
    const cell = /^\/api\/content\/map-cells\/(-?\d+)\/(-?\d+)$/.exec(path);
    if (cell) return respond(route, cellBody(`${cell[1]}:${cell[2]}`));
    const id = decodeURIComponent(path.slice("/api/content/places/".length));
    const place = places.find(item => item.id === id);
    if (!place) return route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Place text not found." } } });
    return respond(route, JSON.stringify({ place: { id: place.id, name: place.title, address: place.address ?? null, location: { lat: place.lat, lon: place.lon }, text: {
      story: { title: place.title, paragraphs: (place.paragraphs ?? []).map(text => ({ text })), sources: place.storySources ?? [], facts: [] },
      audio: place.audioUrl ? { url: place.audioUrl, durationSec: place.durationSec ?? 60 } : null,
    } } }));
  });
  return requests;
}
