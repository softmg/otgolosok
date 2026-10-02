import type { Coordinates } from "./types";

// A loop walk can pass the same spot twice. A pass this close to the best match
// that comes earlier along the line is where the walker reaches the stop first.
const SAME_SPOT_SLACK_M = 15;

function distanceM(a: Coordinates, b: Coordinates) {
  const scaleX = 111320 * Math.cos(((a.lat + b.lat) / 2) * Math.PI / 180);
  return Math.hypot((b.lon - a.lon) * scaleX, (b.lat - a.lat) * 111320);
}

/**
 * For each stop, the geometry vertex where the leg into that stop ends. Cuts never
 * go back along the line; a stop at the start building cuts at vertex 0.
 */
export function routeLegCuts(geometry: Coordinates[], stops: Coordinates[]): number[] {
  const cuts: number[] = [];
  let from = 0;
  for (const stop of stops) {
    if (!geometry.length) { cuts.push(0); continue; }
    const distances = geometry.slice(from).map(point => distanceM(point, stop));
    const best = Math.min(...distances);
    // The earliest pass near enough, then down to its own closest vertex.
    let found = distances.findIndex(value => value <= best + SAME_SPOT_SLACK_M);
    while (found + 1 < distances.length && distances[found + 1] < distances[found]) found += 1;
    const cut = from + found;
    cuts.push(cut);
    from = cut;
  }
  return cuts;
}

/**
 * Vertex range [a, b] of a leg: leg i ends at stop i, the leg after the last stop
 * ends at the finish. Null when the leg has no length (a stop at the start, a finish at the last stop).
 */
export function legRange(cuts: number[], geometryLength: number, leg: number): [number, number] | null {
  if (leg < 0 || leg > cuts.length || geometryLength < 2) return null;
  const from = leg === 0 ? 0 : cuts[leg - 1];
  const to = leg === cuts.length ? geometryLength - 1 : cuts[leg];
  return to > from ? [from, to] : null;
}

// Farther than this from the leg, the walker's position would zoom the map out of the street.
const NEAR_LEG_M = 1500;

/**
 * What the map shows for a leg: its line, or the point it leads to when the leg has
 * no length, plus the walker's position when they are near it.
 */
export function legFitPoints(geometry: Coordinates[], range: [number, number] | null, target: Coordinates, user: Coordinates | null): { points: Coordinates[]; withUser: boolean } {
  const points = range ? geometry.slice(range[0], range[1] + 1) : [target];
  if (!user) return { points, withUser: false };
  const lats = points.map(point => point.lat), lons = points.map(point => point.lon);
  const nearest = {
    lat: Math.min(Math.max(user.lat, Math.min(...lats)), Math.max(...lats)),
    lon: Math.min(Math.max(user.lon, Math.min(...lons)), Math.max(...lons)),
  };
  return distanceM(nearest, user) <= NEAR_LEG_M
    ? { points: [...points, { lat: user.lat, lon: user.lon }], withUser: true }
    : { points, withUser: false };
}
