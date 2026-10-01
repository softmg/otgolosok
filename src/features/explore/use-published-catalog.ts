import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Coordinates } from "../tour/types";
import { nearbyBounds, type CatalogArea } from "./catalog-bounds";
import { createRegionCatalog, type RegionProgress } from "./region-catalog";

const INITIAL: RegionProgress = { places: [], total: 0, loaded: 0, status: "loading", maintenance: false };

export function usePublishedCatalog(nearbyCenter: Coordinates | null, nearbyRadius: number) {
  const [mapProgress, setMapProgress] = useState(INITIAL);
  const [nearbyProgress, setNearbyProgress] = useState<RegionProgress>({ ...INITIAL, status: "ready" });
  const [serviceMaintenance, setServiceMaintenance] = useState(false);
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
  useEffect(() => {
    let disposed = false;
    let checking = false;
    let activeCheck: AbortController | null = null;
    const check = async () => {
      if (checking || document.visibilityState !== "visible") return;
      checking = true;
      const controller = new AbortController();
      activeCheck = controller;
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch("/service-status", { cache: "no-store", signal: controller.signal });
        const value = await response.json().catch(() => null) as { maintenance?: unknown } | null;
        if (!response.ok && response.status !== 503) throw new Error("Не удалось проверить состояние сервиса.");
        if (!disposed) setServiceMaintenance(response.status === 503 && value?.maintenance === true);
      } catch {
        // Keep the last known maintenance state during a temporary status-check failure.
      } finally {
        clearTimeout(timeout);
        checking = false;
        if (activeCheck === controller) activeCheck = null;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 5_000);
    document.addEventListener("visibilitychange", check);
    return () => { disposed = true; activeCheck?.abort(); clearInterval(timer); document.removeEventListener("visibilitychange", check); };
  }, []);
  const maintenance = serviceMaintenance || mapProgress.maintenance || nearbyProgress.maintenance;
  useEffect(() => {
    if (!maintenance) return;
    const timer = setInterval(retry, 5_000);
    return () => clearInterval(timer);
  }, [maintenance, retry]);
  const places = useMemo(() => [...new Map([...mapProgress.places, ...nearbyProgress.places].map(place => [place.id, place])).values()], [mapProgress.places, nearbyProgress.places]);
  const status = mapProgress.status === "error" || nearbyProgress.status === "error" ? "error"
    : mapProgress.status === "loading" || nearbyProgress.status === "loading" ? "loading" : "ready";
  const loading = [mapProgress, nearbyProgress].filter(progress => progress.status === "loading");
  return { places, status, total: loading.reduce((sum, progress) => sum + progress.total, 0),
    loaded: loading.reduce((sum, progress) => sum + progress.loaded, 0), nearbyStatus: nearbyProgress.status, maintenance, retry, onViewport };
}
