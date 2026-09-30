"use client";

import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type Ref,
} from "react";
import type * as Leaflet from "leaflet";
import type { Coordinates } from "../tour/types";
import { NO_INSETS, type MapInsets } from "../shell/map-insets";
import type { MapStatus } from "../shell/map-status-notice";
import { cx } from "../ui/cx";
import { catalogArea, type CatalogArea } from "./catalog-bounds";
import { createMapClusters, loadMapLibrary } from "./map-clusters";
import { createMapView, type MapFocus, type MapView } from "./map-view";
import "leaflet/dist/leaflet.css";
import "leaflet.markercluster/dist/MarkerCluster.css";
import "maplibre-gl/dist/maplibre-gl.css";
import styles from "./explore-map.module.css";

/** Raster basemap for browsers without WebGL, which the vector basemap requires. */
export const FALLBACK_TILE_URL =
  "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
/**
 * The whole city fits at z10. Further out the basemap tiles carry greenery only as ESA WorldCover landcover,
 * which the style leaves out (it needs its own credit), so the map would turn grey; a city walk never needs that view.
 * Leaflet zooms are one above MapLibre's (512 px tiles): z10 here draws the style at z9.
 */
export const MAP_MIN_ZOOM = 10;

function supportsWebGL() {
  const canvas = document.createElement("canvas");
  const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
  gl?.getExtension("WEBGL_lose_context")?.loseContext();
  // jsdom and some locked-down browsers return undefined rather than null.
  return Boolean(gl);
}

type VectorModule = typeof import("@maplibre/maplibre-gl-leaflet");
type BasemapInternals = {
  _map: Leaflet.Map | null;
  _glMap: import("maplibre-gl").Map & { _actualCanvas: HTMLElement };
  _resizeContainer(): void;
  _zoomEnd(): void;
};

/**
 * maplibre-gl-leaflet 0.1.4 redraws after a resize in an animation frame without checking that
 * the layer is still on a map, so a resize right before unmount throws on the removed map.
 * Same redraw as upstream, skipped once the layer is gone.
 */
function safeBasemapLayer(
  L: typeof Leaflet,
  { MaplibreGL }: VectorModule,
): typeof Leaflet.MaplibreGL {
  return MaplibreGL.extend({
    _transitionEnd(this: BasemapInternals) {
      L.Util.requestAnimFrame(() => {
        const map = this._map;
        if (!map) return;
        const offset = map.latLngToContainerPoint(
          map.getBounds().getNorthWest(),
        );
        this._resizeContainer();
        L.DomUtil.setTransform(this._glMap._actualCanvas, offset, 1);
        this._glMap.once("moveend", () => this._zoomEnd());
        const center = map.getCenter();
        this._glMap.jumpTo({
          center: [center.lng, center.lat],
          zoom: map.getZoom() - 1,
        });
      });
    },
  });
}

export type MapItem = {
  id: string;
  title: string;
  location: Coordinates;
  number?: number;
  pending?: boolean;
  compact?: boolean;
};
export type { MapFocus };
export type MapViewState = {
  current: { center: Coordinates; zoom: number; focus: MapFocus | null } | null;
};
export type MapHandle = { zoomIn(): void; zoomOut(): void };
export type ZoomLimits = { canZoomIn: boolean; canZoomOut: boolean };
export type ExploreMapProps = {
  items: MapItem[];
  selectedId?: string;
  focus: MapFocus | null;
  user: (Coordinates & { accuracyM: number }) | null;
  onSelect: (id: string) => void;
  onPoint: (point: Coordinates) => void;
  geometry?: Coordinates[];
  mapLabel?: string;
  viewState?: MapViewState;
  /** The part of the map no panel covers: focus and route are kept inside it. */
  insets?: MapInsets;
  onViewport?: (area: CatalogArea) => void;
  onZoomLimits?: (limits: ZoomLimits) => void;
  onStatus?: (status: MapStatus) => void;
  /**
   * Transitional: screens not yet on MapShell get the Leaflet zoom control, the loading notes and
   * the attribution drawn by the map itself, positioned by their legacy CSS. Removed with the last such screen.
   */
  legacyChrome?: boolean;
  ref?: Ref<MapHandle>;
};

/** The map canvas only: controls, notices and attribution belong to the screen around it (MapShell). */
export function ExploreMap({
  items,
  selectedId,
  focus,
  user,
  onSelect,
  onPoint,
  geometry,
  mapLabel,
  viewState,
  insets = NO_INSETS,
  onViewport,
  onZoomLimits,
  onStatus,
  legacyChrome = false,
  ref,
}: ExploreMapProps) {
  const container = useRef<HTMLDivElement>(null);
  const runtime = useRef<{
    L: typeof Leaflet;
    map: Leaflet.Map;
    view: MapView;
    colors: { route: string; user: string };
    markers: Leaflet.LayerGroup;
    clusters: Leaflet.MarkerClusterGroup;
    markerById: Map<
      string,
      {
        marker: Leaflet.Marker;
        look: string;
        clustered: boolean;
        location: Coordinates;
      }
    >;
    position: Leaflet.LayerGroup;
    route: Leaflet.LayerGroup;
  } | null>(null);
  const handlers = useRef({ onSelect, onPoint, onZoomLimits, onViewport, selectedId });
  const appliedFocus = useRef<Coordinates | null>(null);
  const [ready, setReady] = useState(false);
  const [tileError, setTileError] = useState(false);
  const [mapError, setMapError] = useState(false);
  useEffect(() => {
    handlers.current = { onSelect, onPoint, onZoomLimits, onViewport, selectedId };
  }, [onSelect, onPoint, onZoomLimits, onViewport, selectedId]);
  useImperativeHandle(
    ref,
    () => ({
      zoomIn: () => runtime.current?.map.zoomIn(),
      zoomOut: () => runtime.current?.map.zoomOut(),
    }),
    [],
  );
  useEffect(() => {
    onStatus?.({
      phase: mapError ? "failed" : ready ? "ready" : "loading",
      tilesOffline: tileError,
    });
  }, [onStatus, ready, mapError, tileError]);

  useEffect(() => {
    let disposed = false;
    let observer: ResizeObserver | undefined;
    let viewportTimer: ReturnType<typeof setTimeout> | undefined;
    let saveView: (() => void) | undefined;
    void loadMapLibrary()
      .then(async (L) => {
        // The vector engine is large and useless without WebGL, so only those browsers download it.
        // If its chunk fails to load, the raster fallback still gives a working map.
        const vector = supportsWebGL()
          ? await Promise.all([
              import("@maplibre/maplibre-gl-leaflet"),
              import("./map-style"),
              import("./map-icons"),
            ]).catch(() => null)
          : null;
        if (disposed || !container.current) return;
        const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
        const saved = viewState?.current;
        appliedFocus.current = saved?.focus ?? null;
        // Leaflet 1.9 leaves its zoom transition timer alive after remove().
        // Zoom immediately so switching tabs mid-zoom cannot touch a removed map.
        const map = L.map(container.current, {
          zoomControl: false,
          attributionControl: false,
          zoomAnimation: false,
          fadeAnimation: !reduced,
          markerZoomAnimation: false,
          minZoom: MAP_MIN_ZOOM,
          maxZoom: 19,
        }).setView(
          saved ? [saved.center.lat, saved.center.lon] : [55.7249, 37.6507],
          saved?.zoom ?? 16,
        );
        if (viewState) {
          saveView = () => {
            const center = map.getCenter();
            viewState.current = {
              center: { lat: center.lat, lon: center.lng },
              zoom: map.getZoom(),
              focus: appliedFocus.current,
            };
          };
          map.on("moveend zoomend", saveView);
        }
        if (vector) {
          const [plugin, { mapStyle }, { drawMapIcon, MAP_ICON_PIXEL_RATIO }] =
            vector;
          // Leaflet keeps markers, route and controls; MapLibre only draws the basemap underneath.
          const Basemap = safeBasemapLayer(L, plugin);
          const basemap = new Basemap({
            style: mapStyle,
            attributionControl: false,
          })
            .addTo(map)
            .getMaplibreMap();
          basemap.on("error", () => setTileError(true));
          // The style has no sprite: its icons are drawn the first time a visible symbol needs one.
          basemap.on("styleimagemissing", ({ id }) => {
            const image = drawMapIcon(id);
            if (image && !basemap.hasImage(id))
              basemap.addImage(id, image, { pixelRatio: MAP_ICON_PIXEL_RATIO });
          });
          basemap.on("data", (event) => {
            if (event.dataType === "source" && "tile" in event && event.tile)
              setTileError(false);
          });
        } else {
          L.tileLayer(FALLBACK_TILE_URL, {
            maxZoom: 19,
            updateWhenIdle: true,
            keepBuffer: 1,
          })
            .on("tileerror", () => setTileError(true))
            .on("tileload", () => setTileError(false))
            .addTo(map);
        }
        if (legacyChrome)
          L.control
            .zoom({
              position: "bottomright",
              zoomInTitle: "Приблизить",
              zoomOutTitle: "Отдалить",
            })
            .addTo(map)
            .getContainer()
            ?.setAttribute("data-region", "controls");
        map.on("click", (event: Leaflet.LeafletMouseEvent) =>
          handlers.current.onPoint({
            lat: event.latlng.lat,
            lon: event.latlng.lng,
          }),
        );
        const limits = () =>
          handlers.current.onZoomLimits?.({
            canZoomIn: map.getZoom() < map.getMaxZoom(),
            canZoomOut: map.getZoom() > map.getMinZoom(),
          });
        map.on("zoomend", limits);
        limits();
        // Route and position colours are tokens; Leaflet draws SVG attributes, so they are read once here.
        const style = getComputedStyle(container.current);
        const token = (name: string) => style.getPropertyValue(name).trim();
        const view = createMapView(map);
        const routeColor = token("--route-line");
        runtime.current = {
          L,
          map,
          view,
          colors: { route: routeColor, user: token("--user-position") },
          markers: L.layerGroup().addTo(map),
          clusters: createMapClusters(L, {
            className: styles.cluster,
            spiderLegColor: routeColor,
          }).addTo(map),
          markerById: new Map(),
          position: L.layerGroup().addTo(map),
          route: L.layerGroup().addTo(map),
        };
        const reportViewport = () => {
          clearTimeout(viewportTimer);
          viewportTimer = setTimeout(() => {
            if (!disposed && handlers.current.onViewport && map.getSize().x > 0 && map.getSize().y > 0)
              handlers.current.onViewport(catalogArea(map));
          }, 160);
        };
        map.on("moveend resize", reportViewport);
        reportViewport();
        observer = new ResizeObserver(() => {
          if (disposed) return;
          map.invalidateSize();
          view.resized();
        });
        observer.observe(container.current);
        setReady(true);
      })
      .catch(() => {
        if (!disposed) setMapError(true);
      });
    return () => {
      disposed = true;
      clearTimeout(viewportTimer);
      observer?.disconnect();
      runtime.current?.view.dispose();
      const map = runtime.current?.map;
      if (map) {
        saveView?.();
        // Leaflet may emit a delayed resize event after remove().
        if (saveView) map.off("moveend zoomend", saveView);
        map.remove();
      }
      runtime.current = null;
    };
    // legacyChrome is fixed per screen for the lifetime of a map.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewState]);

  // Markers are updated by id instead of being rebuilt: playback re-renders the
  // map often, and a rebuilt marker would drop keyboard focus.
  useEffect(() => {
    const rt = runtime.current;
    if (!rt || !ready) return;
    const wanted = new Set(items.map((item) => item.id));
    for (const [id, entry] of rt.markerById)
      if (!wanted.has(id)) {
        (entry.clustered ? rt.clusters : rt.markers).removeLayer(entry.marker);
        rt.markerById.delete(id);
      }
    const additions: Leaflet.Marker[] = [];
    for (const item of items) {
      const active = item.id === selectedId;
      const clustered = !active && item.number === undefined && !item.pending;
      // Marker contents are fixed symbols/numbers, never upstream HTML.
      const label = item.number
        ? String(item.number)
        : item.pending
          ? "…"
          : "♪";
      const look = JSON.stringify([
        item.title,
        label,
        item.compact ?? false,
        item.pending ?? false,
        active,
      ]);
      const position: [number, number] = [item.location.lat, item.location.lon];
      const existing = rt.markerById.get(item.id);
      if (existing) {
        // Spiderfying moves the marker temporarily; compare source coordinates.
        const current = existing.location;
        if (current.lat !== position[0] || current.lon !== position[1]) {
          existing.marker.setLatLng(position);
          existing.location = { ...item.location };
        }
        if (existing.look === look && existing.clustered === clustered)
          continue;
      }
      const icon = item.compact
        ? rt.L.divIcon({
            className: styles.dot,
            html: "<span></span>",
            iconSize: [32, 32],
            iconAnchor: [16, 16],
          })
        : rt.L.divIcon({
            className: cx(
              styles.pin,
              active && styles.selected,
              item.pending && styles.pending,
            ),
            html: `<span><b>${label}</b></span>`,
            iconSize: [44, 52],
            iconAnchor: [22, 48],
          });
      let marker = existing?.marker;
      if (marker) {
        // A div icon reuses its element, so focus and listeners survive the update.
        Object.assign(marker.options, { title: item.title, alt: item.title });
        marker
          .setIcon(icon)
          .setZIndexOffset(active ? 1000 : item.compact ? -1000 : 0);
      } else {
        marker = rt.L.marker(position, {
          icon,
          title: item.title,
          alt: item.title,
          keyboard: true,
          zIndexOffset: active ? 1000 : item.compact ? -1000 : 0,
          bubblingMouseEvents: false,
        });
        marker.on("click", () => handlers.current.onSelect(item.id));
        marker.on("add", () => {
          const element = marker?.getElement();
          const selected = handlers.current.selectedId === item.id;
          element?.setAttribute("aria-pressed", String(selected));
          element?.setAttribute("data-marker", item.compact ? "dot" : "pin");
          element?.setAttribute("data-selected", String(selected));
        });
      }
      if (!existing || existing.clustered !== clustered) {
        const hadFocus = marker.getElement() === document.activeElement;
        if (existing)
          (existing.clustered ? rt.clusters : rt.markers).removeLayer(marker);
        if (clustered) additions.push(marker);
        else rt.markers.addLayer(marker);
        if (hadFocus) marker.getElement()?.focus({ preventScroll: true });
      }
      const element = marker.getElement();
      element?.setAttribute("aria-pressed", String(active));
      element?.setAttribute("data-marker", item.compact ? "dot" : "pin");
      element?.setAttribute("data-selected", String(active));
      rt.markerById.set(item.id, {
        marker,
        look,
        clustered,
        location: { ...item.location },
      });
    }
    rt.clusters.addLayers(additions);
  }, [items, selectedId, ready]);

  useEffect(() => {
    const rt = runtime.current;
    if (!rt || !ready || !focus) return;
    // A remount must not replay the old selection over a manually moved view.
    if (focus === appliedFocus.current) return;
    appliedFocus.current = focus;
    rt.view.focus(focus);
  }, [focus, ready]);

  useEffect(() => {
    const rt = runtime.current;
    if (!rt || !ready) return;
    rt.route.clearLayers();
    if (!geometry || geometry.length < 2) {
      rt.view.clearFit();
      return;
    }
    const line = rt.L.polyline(
      geometry.map((p) => [p.lat, p.lon] as [number, number]),
      { color: rt.colors.route, weight: 5, opacity: 0.9, interactive: false },
    ).addTo(rt.route);
    line.getElement()?.setAttribute("data-route", "");
    rt.view.fit(line.getBounds());
  }, [geometry, ready]);

  useEffect(() => {
    runtime.current?.view.setInsets(insets);
  }, [insets, ready]);

  useEffect(() => {
    const rt = runtime.current;
    if (!rt || !ready) return;
    rt.position.clearLayers();
    if (!user) return;
    // Keep the user's position visually distinct from story pins.  A custom
    // icon is more reliable than a tiny circleMarker on high-DPI/mobile maps.
    rt.L.circle([user.lat, user.lon], {
      radius: Math.min(Math.max(user.accuracyM, 20), 5000),
      color: rt.colors.user,
      weight: 2,
      fillColor: rt.colors.user,
      fillOpacity: 0.16,
      interactive: false,
    }).addTo(rt.position);
    const icon = rt.L.divIcon({
      className: styles.userPosition,
      html: '<span aria-hidden="true"></span>',
      iconSize: [30, 30],
      iconAnchor: [15, 15],
    });
    rt.L.marker([user.lat, user.lon], {
      icon,
      interactive: false,
      zIndexOffset: 1000,
    })
      .addTo(rt.position)
      .getElement()
      ?.setAttribute("data-marker", "user");
  }, [user, ready]);

  const canvas = (
    <div
      ref={container}
      className={cx(styles.map, legacyChrome && "explore-map")}
      data-region="map"
      role="region"
      aria-label={
        mapLabel ??
        "Карта историй. Выберите отметку или нажмите на дом, чтобы подготовить историю."
      }
    />
  );
  if (!legacyChrome) return canvas;
  return (
    <div className="explore-map-layer">
      {canvas}
      {!ready ? (
        <p className="map-loading" data-region="notices" role="status">
          {mapError
            ? "Карта не загрузилась. Откройте список историй."
            : "Загружаем карту…"}
        </p>
      ) : null}
      {tileError ? (
        <p className="map-network-note" data-region="notices" role="status">
          Карта требует интернета. Сохранённые истории доступны в разделе
          «Сохранено».
        </p>
      ) : null}
      <a
        className="map-attribution"
        data-region="attribution"
        href="https://www.openstreetmap.org/copyright"
        target="_blank"
        rel="noreferrer"
      >
        © OpenStreetMap
      </a>
    </div>
  );
}
