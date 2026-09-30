import { containsBounds, type CatalogArea, type CatalogBounds } from "./catalog-bounds";
import { loadPublishedCatalog, type CatalogPlace } from "./published-catalog";

export type RegionProgress = {
  places: CatalogPlace[];
  total: number;
  loaded: number;
  status: "loading" | "ready" | "error";
};

/** Screen-local cache. Only fully received areas count as covered, including empty ones. */
export function createRegionCatalog(onChange: (progress: RegionProgress) => void) {
  const places = new Map<string, CatalogPlace>();
  let covered: CatalogBounds[] = [];
  let desired: CatalogArea | null = null;
  let active: { bounds: CatalogBounds; controller: AbortController } | null = null;
  let disposed = false;
  let progress: RegionProgress = { places: [], total: 0, loaded: 0, status: "loading" };
  const publish = (update: Partial<RegionProgress>) => {
    progress = { ...progress, ...update };
    if (!disposed) onChange(progress);
  };
  const cancel = () => { active?.controller.abort(); active = null; };

  function update(area: CatalogArea | null) {
    if (disposed) return;
    desired = area;
    if (!area || covered.some(bounds => containsBounds(bounds, area.required))) {
      cancel();
      publish({ status: "ready", total: 0, loaded: 0 });
      return;
    }
    if (active && containsBounds(active.bounds, area.required)) return;
    cancel();
    const current = { bounds: area.buffered, controller: new AbortController() };
    active = current;
    publish({ status: "loading", total: 0, loaded: 0 });
    void loadPublishedCatalog(current.controller.signal, page => {
      if (active !== current || disposed) return;
      for (const place of page.places) places.set(place.id, place);
      publish({ places: [...places.values()], total: page.total, loaded: page.places.length });
    }, current.bounds).then(() => {
      if (active !== current || disposed) return;
      covered = covered.filter(bounds => !containsBounds(current.bounds, bounds));
      covered.push(current.bounds);
      active = null;
      publish({ status: "ready" });
    }).catch(() => {
      if (active !== current || disposed) return;
      active = null;
      publish({ status: "error" });
    });
  }

  return {
    update,
    retry: () => update(desired),
    dispose: () => { disposed = true; cancel(); },
  };
}
