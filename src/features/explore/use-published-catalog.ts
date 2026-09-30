import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Coordinates } from "../tour/types";
import { nearbyBounds, type CatalogArea } from "./catalog-bounds";
import { createRegionCatalog, type RegionProgress } from "./region-catalog";

const INITIAL: RegionProgress = { places: [], total: 0, loaded: 0, status: "loading" };

export function usePublishedCatalog(nearbyCenter: Coordinates | null, nearbyRadius: number) {
  const [mapProgress, setMapProgress] = useState(INITIAL);
  const [nearbyProgress, setNearbyProgress] = useState<RegionProgress>({ ...INITIAL, status: "ready" });
  const loaders = useRef<{
    map: ReturnType<typeof createRegionCatalog>;
    nearby: ReturnType<typeof createRegionCatalog>;
  } | null>(null);
  const lastArea = useRef<CatalogArea | null>(null);
  useEffect(() => {
    const current = { map: createRegionCatalog(setMapProgress), nearby: createRegionCatalog(setNearbyProgress) };
    loaders.current = current;
    if (lastArea.current) current.map.update(lastArea.current);
    return () => { current.map.dispose(); current.nearby.dispose(); loaders.current = null; };
  }, []);
  const lat = nearbyCenter?.lat, lon = nearbyCenter?.lon;
  useEffect(() => {
    const bounds = lat === undefined || lon === undefined ? null : nearbyBounds({ lat, lon }, nearbyRadius);
    loaders.current?.nearby.update(bounds ? { required: bounds, buffered: bounds } : null);
  }, [lat, lon, nearbyRadius]);
  const onViewport = useCallback((area: CatalogArea) => {
    lastArea.current = area;
    loaders.current?.map.update(area);
  }, []);
  const retry = useCallback(() => { loaders.current?.map.retry(); loaders.current?.nearby.retry(); }, []);
  const places = useMemo(() => [...new Map([...mapProgress.places, ...nearbyProgress.places].map(place => [place.id, place])).values()], [mapProgress.places, nearbyProgress.places]);
  const status = mapProgress.status === "error" || nearbyProgress.status === "error" ? "error"
    : mapProgress.status === "loading" || nearbyProgress.status === "loading" ? "loading" : "ready";
  const loading = [mapProgress, nearbyProgress].filter(progress => progress.status === "loading");
  return { places, status, total: loading.reduce((sum, progress) => sum + progress.total, 0),
    loaded: loading.reduce((sum, progress) => sum + progress.loaded, 0), nearbyStatus: nearbyProgress.status, retry, onViewport };
}
