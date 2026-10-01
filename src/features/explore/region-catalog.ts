import { containsBounds, uncoveredBounds, type CatalogArea, type CatalogBounds } from "./catalog-bounds";
import { isServiceMaintenance, loadPublishedCatalog, type CatalogPlace } from "./published-catalog";

export type RegionProgress = {
  places: CatalogPlace[];
  total: number;
  loaded: number;
  status: "loading" | "ready" | "error";
  maintenance: boolean;
};

/** Screen-local cache. Only fully received areas count as covered, including empty ones. */
export function createRegionCatalog(onChange: (progress: RegionProgress) => void) {
  const places = new Map<string, CatalogPlace>();
  let covered: CatalogBounds[] = [];
  let desired: CatalogArea | null = null;
  let active: { bounds: CatalogBounds; controller: AbortController } | null = null;
  let disposed = false;
  let progress: RegionProgress = { places: [], total: 0, loaded: 0, status: "loading", maintenance: false };
  const publish = (update: Partial<RegionProgress>) => {
    progress = { ...progress, ...update };
    if (!disposed) onChange(progress);
  };
  const cancel = () => { active?.controller.abort(); active = null; };

  function update(area: CatalogArea | null) {
    if (disposed) return;
    desired = area;
    if (!area || uncoveredBounds(area.required, covered).length === 0) {
      cancel();
      publish({ status: "ready", total: 0, loaded: 0, maintenance: false });
      return;
    }
    if (active && containsBounds(active.bounds, area.required)) return;
    cancel();
    const current = { bounds: area.buffered, controller: new AbortController() };
    active = current;
    publish({ status: "loading", total: 0, loaded: 0, maintenance: false });
    const missing = uncoveredBounds(current.bounds, covered);
    void (async () => {
      let loaded = 0, total = 0;
      for (const bounds of missing) {
        let completed = { loaded: 0, total: 0 };
        await loadPublishedCatalog(current.controller.signal, page => {
          if (active !== current || disposed) return;
          for (const place of page.places) places.set(place.id, place);
          completed = { loaded: page.places.length, total: page.total };
          publish({ places: [...places.values()], total: total + page.total, loaded: loaded + page.places.length, maintenance: false });
        }, bounds);
        if (active !== current || disposed) return;
        covered.push(bounds);
        loaded += completed.loaded;
        total += completed.total;
      }
      if (active !== current || disposed) return;
      covered = covered.filter(bounds => !containsBounds(current.bounds, bounds));
      covered.push(current.bounds);
      active = null;
      publish({ status: "ready", maintenance: false });
    })().catch(error => {
      if (active !== current || disposed) return;
      active = null;
      publish({ status: "error", maintenance: isServiceMaintenance(error) });
    });
  }

  return {
    update,
    retry: () => update(desired),
    dispose: () => { disposed = true; cancel(); },
  };
}
