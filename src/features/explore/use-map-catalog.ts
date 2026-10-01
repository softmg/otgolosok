import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { Coordinates } from "../tour/types";
import { nearbyBounds, type CatalogArea, type CatalogBounds } from "./catalog-bounds";
import { areaStatus, mapCellStore, type MapCellStore } from "./map-cells";

/** Catalog points for the map area and the nearby search, served from the shared cell store. */
export function useMapCatalog(nearbyCenter: Coordinates | null, nearbyRadius: number, store: MapCellStore = mapCellStore) {
  const snapshot = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  const [required, setRequired] = useState<CatalogBounds | null>(null);
  const [serviceMaintenance, setServiceMaintenance] = useState(false);
  const buffered = useRef<CatalogBounds | null>(null);
  const lat = nearbyCenter?.lat, lon = nearbyCenter?.lon;
  const nearby = useMemo(() => lat === undefined || lon === undefined ? null : nearbyBounds({ lat, lon }, nearbyRadius), [lat, lon, nearbyRadius]);
  useEffect(() => { if (nearby) void store.ensureArea(nearby); }, [nearby, store]);
  // The buffer (two zoom steps) prefetches a neighbouring cell before the user pans across its line.
  const onViewport = useCallback((area: CatalogArea) => {
    setRequired(area.required);
    buffered.current = area.buffered;
    void store.ensureArea(area.buffered);
  }, [store]);
  const retry = useCallback(() => {
    void store.retry(...[buffered.current, nearby].filter((area): area is CatalogBounds => area !== null));
  }, [store, nearby]);
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
  const maintenance = serviceMaintenance || snapshot.maintenance;
  useEffect(() => {
    if (!maintenance) return;
    const timer = setInterval(retry, 5_000);
    return () => clearInterval(timer);
  }, [maintenance, retry]);
  const mapStatus = required ? areaStatus(snapshot, required) : "loading";
  const nearbyStatus = nearby ? areaStatus(snapshot, nearby) : "ready";
  const status = mapStatus === "error" || nearbyStatus === "error" ? "error" : mapStatus === "loading" || nearbyStatus === "loading" ? "loading" : "ready";
  return { places: snapshot.points, status, nearbyStatus, maintenance, retry, onViewport };
}
