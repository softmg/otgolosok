import { createHash } from "node:crypto";

// The public map index is split into fixed 1°×1° cells: stable URLs, one cache key per cell,
// and a future city is fetched only when the map shows it.
export const CELL_SIZE = 1;
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** @param {number} lat @param {number} lon */
export const cellOf = (lat, lon) => ({ lat: clamp(Math.floor(lat), -90, 89), lon: clamp(Math.floor(lon), -180, 179) });

/** @param {{lat: number, lon: number}} cell */
export const cellKey = cell => `${cell.lat}:${cell.lon}`;

/** @param {unknown} value */
export const isCellLat = value => Number.isSafeInteger(value) && /** @type {number} */ (value) >= -90 && /** @type {number} */ (value) <= 89;
/** @param {unknown} value */
export const isCellLon = value => Number.isSafeInteger(value) && /** @type {number} */ (value) >= -180 && /** @type {number} */ (value) <= 179;

const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
const round = value => Math.round(value * 1e5) / 1e5;

/**
 * Slim map point: enough for the marker, the story sheet header and the nearby ranking, without the text.
 * @param {{id: string, name: string, address: string | null, lat: number, lon: number, title?: unknown, durationSec?: unknown, facts?: unknown, sources?: unknown}} row
 */
export function toMapPoint(row) {
  const duration = typeof row.durationSec === "number" && Number.isFinite(row.durationSec) && row.durationSec > 0 ? row.durationSec : null;
  return {
    id: row.id,
    lat: round(row.lat),
    lon: round(row.lon),
    title: typeof row.title === "string" && row.title.trim() ? row.title : row.name,
    address: row.address ?? row.name,
    durationSec: duration,
    facts: count(row.facts),
    sources: count(row.sources),
  };
}

/**
 * The exact HTTP body of a cell. Points are sorted by id, so the same content always hashes to the same ETag.
 * @param {{lat: number, lon: number}} cell
 * @param {ReturnType<typeof toMapPoint>[]} points
 */
export function serializeCell(cell, points) {
  const sorted = [...points].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return JSON.stringify({ lat: cell.lat, lon: cell.lon, points: sorted });
}

/** Content-addressed tag shared by the HTTP layer and the manifest, so both always agree. @param {string} body */
export const etagOf = body => createHash("sha256").update(body).digest("hex").slice(0, 32);
