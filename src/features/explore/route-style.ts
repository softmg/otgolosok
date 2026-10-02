/** Dash of the green line over covered stretches (underpasses, arches); its light casing stays solid. */
export const ROUTE_COVERED_DASH = "6 8";
/** Distance between direction chevrons along the highlighted leg, in screen pixels. */
export const CHEVRON_SPACING_PX = 70;
/** A very long leg gets wider spacing rather than hundreds of markers. */
export const MAX_CHEVRONS = 200;

export type RouteRun = { from: number; to: number; covered: boolean; active: boolean };
type Range = readonly [number, number];

/**
 * Splits a route of `length` vertices into consecutive runs [from, to] that share
 * their end vertices, so that every segment is drawn exactly once: in a tunnel or
 * not, on the highlighted leg or not.
 */
export function routeRuns(length: number, tunnels: readonly Range[] = [], active: Range | null = null): RouteRun[] {
  if (length < 2) return [];
  const last = length - 1;
  const clip = (value: number) => Math.min(Math.max(value, 0), last);
  const cuts = new Set([0, last]);
  for (const [a, b] of [...tunnels, ...(active ? [active] : [])]) { cuts.add(clip(a)); cuts.add(clip(b)); }
  const points = [...cuts].sort((a, b) => a - b);
  const runs: RouteRun[] = [];
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1], to = points[i];
    const covered = tunnels.some(([a, b]) => a <= from && to <= b);
    const inLeg = Boolean(active && active[0] <= from && to <= active[1]);
    const previous = runs.at(-1);
    if (previous && previous.covered === covered && previous.active === inLeg) previous.to = to;
    else runs.push({ from, to, covered, active: inLeg });
  }
  return runs;
}

export type ChevronMark = { x: number; y: number; angleDeg: number };

/**
 * Direction marks along a polyline in screen pixels, `spacingPx` apart and offset by
 * half a step from both ends; a leg shorter than one step gets a single mark at its middle.
 */
export function chevronMarks(points: ReadonlyArray<{ x: number; y: number }>, spacingPx = CHEVRON_SPACING_PX, max = MAX_CHEVRONS): ChevronMark[] {
  const lengths: number[] = [];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    const length = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    lengths.push(length);
    total += length;
  }
  if (total < 1) return [];
  const count = Math.min(max, Math.max(1, Math.floor(total / spacingPx)));
  const step = total / count;
  const marks: ChevronMark[] = [];
  let segment = 0, passed = 0;
  for (let k = 0; k < count; k++) {
    const at = step * (k + 0.5);
    while (segment < lengths.length - 1 && (lengths[segment] === 0 || passed + lengths[segment] < at)) passed += lengths[segment++];
    const a = points[segment], b = points[segment + 1];
    const t = lengths[segment] ? (at - passed) / lengths[segment] : 0;
    marks.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angleDeg: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI });
  }
  return marks;
}
