import type { Coordinates } from "../tour/types";
import { request } from "../walk-builder/request";
import type { StorySourceRef } from "./source-attribution";

export type CatalogPlace = {
  id: string; name: string; address: string | null; location: Coordinates;
  story: { title: string; paragraphs: Array<{ text: string }>; sources?: StorySourceRef[]; facts?: unknown[] } | null;
  audio: { url: string; durationSec: number } | null;
  distanceM: number | null;
};
export type CatalogProgress = { places: CatalogPlace[]; total: number };
type CatalogPage = CatalogProgress & { hasMore: boolean };

/** One city-wide catalog feeds both map markers and local nearby recommendations. */
export async function loadPublishedCatalog(signal: AbortSignal, onPage: (progress: CatalogProgress) => void) {
  const places = new Map<string, CatalogPlace>();
  let offset = 0;
  for (;;) {
    signal.throwIfAborted();
    const params = new URLSearchParams({ limit: "100", status: "ready", offset: String(offset) });
    const page = await request(`/api/content/places?${params}`, signal) as CatalogPage;
    signal.throwIfAborted();
    if (!page || !Array.isArray(page.places) || !Number.isSafeInteger(page.total) || page.total < 0 || typeof page.hasMore !== "boolean") {
      throw new Error("Некорректный ответ каталога.");
    }
    const previousSize = places.size;
    for (const place of page.places) places.set(place.id, place);
    offset += page.places.length;
    onPage({ places: [...places.values()], total: page.total });
    // A broken/changing page must not turn into an infinite request loop or a false success.
    if (page.hasMore && (places.size === previousSize || offset >= page.total) || !page.hasMore && places.size !== page.total) {
      throw new Error("Каталог изменился во время загрузки. Повторите загрузку.");
    }
    if (!page.hasMore) return;
  }
}
