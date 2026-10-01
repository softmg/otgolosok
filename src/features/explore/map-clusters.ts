import type * as Leaflet from "leaflet";

export async function loadMapLibrary() {
  // The plugin extends Leaflet's CommonJS object and its browser global.
  // Keep that object, rather than the immutable dynamic-import namespace.
  const { default: L } = await import("leaflet");
  await import("leaflet.markercluster");
  return L;
}

/**
 * Cluster radius in pixels: wider on overview zooms, where thousands of catalog points would otherwise
 * become hundreds of DOM markers, and the original 52 px from street level, where places must stay apart.
 */
export function clusterRadius(zoom: number) {
  if (zoom <= 11) return 120;
  if (zoom === 12) return 100;
  if (zoom === 13) return 90;
  if (zoom === 14) return 80;
  if (zoom === 15) return 64;
  return 52;
}

// Markers per addLayers call and main-thread time per task: a whole city catalog (~6k points) is clustered
// in short steps instead of one long freeze, which is several hundred milliseconds on a phone.
const BATCH_SIZE = 200;
const FRAME_BUDGET_MS = 8;

export type MapClusters = {
  group: Leaflet.MarkerClusterGroup;
  addTo(map: Leaflet.Map): MapClusters;
  /** Small updates are applied at once; the rest continues in later tasks. */
  addLayers(markers: Leaflet.Marker[]): void;
  /** A marker still waiting in the queue is dropped, so it never reaches the map. */
  removeLayer(marker: Leaflet.Marker): void;
  /** Stops pending additions before the map is removed. */
  dispose(): void;
};

export function createMapClusters(
  L: typeof Leaflet,
  { className, spiderLegColor }: { className: string; spiderLegColor: string },
  { now = () => performance.now() }: { now?: () => number } = {},
): MapClusters {
  // The plugin's own chunkedLoading cannot cancel a marker that is waiting for its chunk:
  // removeLayer ignores it and the chunk adds it later, leaving a ghost or duplicated pin.
  const group = L.markerClusterGroup({
    maxClusterRadius: clusterRadius,
    showCoverageOnHover: false,
    removeOutsideVisibleBounds: true,
    // Match the map's immediate zoom and avoid timers after unmount.
    animate: false,
    spiderfyDistanceMultiplier: 1.5,
    spiderLegPolylineOptions: {
      color: spiderLegColor,
      weight: 1.5,
      opacity: 0.6,
    },
    iconCreateFunction(cluster) {
      const count = cluster.getChildCount();
      const label = `Мест: ${count}. Нажмите, чтобы раскрыть группу`;
      Object.assign(cluster.options, { title: label, alt: label });
      const icon = L.divIcon({
        className,
        html: `<span data-cluster-count="${count}">${count}</span>`,
        iconSize: [48, 48],
        iconAnchor: [24, 24],
      });
      const createIcon = icon.createIcon.bind(icon);
      icon.createIcon = (oldIcon) => {
        const element = createIcon(oldIcon);
        element.setAttribute("aria-label", label);
        element.setAttribute("data-marker", "cluster");
        return element;
      };
      return icon;
    },
  });
  // A Set keeps insertion order and removes a queued marker in O(1).
  const queued = new Set<Leaflet.Marker>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function flush() {
    timer = undefined;
    const started = now();
    while (queued.size > 0) {
      const batch: Leaflet.Marker[] = [];
      for (const marker of queued) {
        batch.push(marker);
        if (batch.length === BATCH_SIZE) break;
      }
      for (const marker of batch) queued.delete(marker);
      group.addLayers(batch);
      if (now() - started >= FRAME_BUDGET_MS) break;
    }
    if (queued.size > 0) timer = setTimeout(flush, 0);
  }

  const clusters: MapClusters = {
    group,
    addTo(map) {
      group.addTo(map);
      return clusters;
    },
    addLayers(markers) {
      for (const marker of markers) queued.add(marker);
      if (timer === undefined && queued.size > 0) flush();
    },
    removeLayer(marker) {
      if (queued.delete(marker)) return;
      group.removeLayer(marker);
    },
    dispose() {
      clearTimeout(timer);
      timer = undefined;
      queued.clear();
    },
  };
  return clusters;
}
