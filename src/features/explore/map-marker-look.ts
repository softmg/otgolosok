import type { MapItem } from "./explore-map";

export type MarkerKind = "place" | "stop" | "pending" | "endpoint" | "background";
export type MarkerLook = {
  kind: MarkerKind;
  /** A stop's number or nothing: marker contents are never upstream HTML. */
  label: string;
  /** Square icon side in px; the icon is anchored at its centre. */
  size: number;
  /** Value of `data-marker`, which tests and e2e select by. */
  dataMarker: "pin" | "dot" | "endpoint";
  /** Stacking: the selected marker on top, secondary points under stories. */
  zIndex: number;
};

/** Clickable box of a story marker: the visible circle is smaller, the hit area stays at --control-min. */
const HIT = 44;
const BACKGROUND_HIT = 32;

/**
 * Every story marker is a terracotta circle; the variant decides fill, size and contents.
 * Precedence: a walk end, then a background point, then a numbered stop, then a pending story.
 */
export function markerLook(item: MapItem, active: boolean): MarkerLook {
  const kind: MarkerKind = item.endpoint
    ? "endpoint"
    : item.compact
      ? "background"
      : item.number
        ? "stop"
        : item.pending
          ? "pending"
          : "place";
  const secondary = kind === "endpoint" || kind === "background";
  return {
    kind,
    label: kind === "stop" ? String(item.number) : "",
    size: kind === "background" ? BACKGROUND_HIT : HIT,
    dataMarker: kind === "endpoint" ? "endpoint" : kind === "background" ? "dot" : "pin",
    zIndex: active ? 1000 : secondary ? -1000 : 0,
  };
}
