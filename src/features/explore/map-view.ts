import type * as Leaflet from "leaflet";
import type { Coordinates } from "../tour/types";
import { fitBox, NO_INSETS, sameInsets, type MapInsets } from "../shell/map-insets";

export type MapFocus = Coordinates & { zoom?: number };
type ViewMap = Pick<Leaflet.Map, "getSize" | "getZoom" | "setView" | "panBy" | "fitBounds" | "on" | "off">;
type Target = { kind: "focus"; focus: MapFocus } | { kind: "fit"; bounds: Leaflet.LatLngBoundsExpression };

/** Room a stop pin needs around its point: it rises about 48 px above it. */
const PIN = { top: 48, side: 24 };
/** Smallest box a fit or a focus is squeezed into when panels leave less of the map free. */
const MIN_BOX = { x: 160, y: 96 };
const FOCUS_ZOOM = 16;
const ROUTE_MAX_ZOOM = 17;

/**
 * Where the map looks. The last requested focus or route is kept in the free part of the map
 * while panels change size — until the user pans or zooms. From then on the view is theirs,
 * until the screen asks for a new focus or a new route.
 */
export function createMapView(map: ViewMap) {
  let insets = NO_INSETS;
  let target: Target | null = null;
  let userMoved = false;
  let own = 0;
  const start = () => { if (!own) userMoved = true; };
  map.on("movestart zoomstart", start);

  function apply() {
    if (!target) return;
    const current = target;
    const size = map.getSize();
    own++;
    try {
      if (current.kind === "focus") {
        const box = fitBox(size, insets, MIN_BOX);
        const { focus } = current;
        map.setView([focus.lat, focus.lon], focus.zoom ?? Math.max(map.getZoom(), FOCUS_ZOOM), { animate: false });
        const x = size.x / 2 - (box.left + size.x - box.right) / 2;
        const y = size.y / 2 - (box.top + size.y - box.bottom) / 2;
        if (x || y) map.panBy([x, y], { animate: false });
      } else {
        const box = fitBox(size, { top: insets.top + PIN.top, right: insets.right + PIN.side, bottom: insets.bottom + PIN.side, left: insets.left + PIN.side }, MIN_BOX);
        map.fitBounds(current.bounds, { paddingTopLeft: [box.left, box.top], paddingBottomRight: [box.right, box.bottom], maxZoom: ROUTE_MAX_ZOOM, animate: false });
      }
    } finally { own--; }
  }

  return {
    focus(focus: MapFocus) { target = { kind: "focus", focus }; userMoved = false; apply(); },
    fit(bounds: Leaflet.LatLngBoundsExpression) { target = { kind: "fit", bounds }; userMoved = false; apply(); },
    /** A removed route must not be re-fitted when panels move later. */
    clearFit() { if (target?.kind === "fit") target = null; },
    setInsets(next: MapInsets) {
      if (sameInsets(next, insets)) return;
      insets = next;
      if (!userMoved) apply();
    },
    /** The map element changed size: keep the requested view in place unless the user moved it. */
    resized() { if (!userMoved) apply(); },
    dispose() { map.off("movestart zoomstart", start); },
  };
}

export type MapView = ReturnType<typeof createMapView>;
