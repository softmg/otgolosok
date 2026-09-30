/** Distances in CSS pixels from each edge of the map to the part of it that no panel covers. */
export type MapInsets = { top: number; right: number; bottom: number; left: number };
export type RectLike = { top: number; right: number; bottom: number; left: number };
export type Size = { x: number; y: number };

export const NO_INSETS: MapInsets = { top: 0, right: 0, bottom: 0, left: 0 };

const edge = (value: number) => Math.max(0, Math.round(value));

/** Insets of the free box relative to the map box; a free box sticking out of the map gives 0 on that side. */
export function insetsFromRects(map: RectLike, free: RectLike): MapInsets {
  return {
    top: edge(free.top - map.top),
    right: edge(map.right - free.right),
    bottom: edge(map.bottom - free.bottom),
    left: edge(free.left - map.left),
  };
}

export function sameInsets(a: MapInsets, b: MapInsets): boolean {
  return a.top === b.top && a.right === b.right && a.bottom === b.bottom && a.left === b.left;
}

/** Grows one axis of the free box around its centre to `min`, keeping it inside `[0, size]`. */
function widen(size: number, start: number, end: number, min: number): [number, number] {
  const free = size - start - end;
  if (free >= min) return [start, end];
  const target = Math.min(min, size);
  // Overlapping panels give a negative box; its centre is still halfway between their edges.
  const center = (start + size - end) / 2;
  const from = Math.min(Math.max(center - target / 2, 0), size - target);
  return [Math.round(from), Math.round(size - target - from)];
}

/**
 * Insets to fit or centre content in. When panels leave less than `min` of the map free, the box
 * is widened around its centre instead of becoming negative, so Leaflet never gets an impossible fit.
 */
export function fitBox(size: Size, insets: MapInsets, min: Size): MapInsets {
  const [left, right] = widen(size.x, insets.left, insets.right, min.x);
  const [top, bottom] = widen(size.y, insets.top, insets.bottom, min.y);
  return { top, right, bottom, left };
}
