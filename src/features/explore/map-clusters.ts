import type * as Leaflet from "leaflet";

export async function loadMapLibrary() {
  // The plugin extends Leaflet's CommonJS object and its browser global.
  // Keep that object, rather than the immutable dynamic-import namespace.
  const { default: L } = await import("leaflet");
  await import("leaflet.markercluster");
  return L;
}

export function createMapClusters(
  L: typeof Leaflet,
  { className, spiderLegColor }: { className: string; spiderLegColor: string },
) {
  return L.markerClusterGroup({
    maxClusterRadius: 52,
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
}
