import { CATALOG_LISTED_AT, catalogDocument, rankTopWalks, ratingSummary, walkDetails } from "./walk-top.mjs";
import { distance } from "./walks.mjs";

export const NEARBY_RADIUS_M = 500;
export const NEARBY_LIMIT = 5;
// The public distance is coarse so a response never pinpoints another person's start.
const DISTANCE_STEP_M = 50;

/**
 * Where an open walk ends, as on the walk page: the chosen destination, else the last stop.
 * null for a loop, which returns to its start.
 */
export const finishOf = document => document.mode === "loop" ? null : (document.destination ?? document.stops.at(-1)?.place)?.address ?? null;

/**
 * Walks that start near a point, ranked by the top formula: catalog walks, approved public
 * account walks and, for a signed-in user, their own walks. Items carry only a rounded start
 * distance — never coordinates, launch counts, owners or authors.
 * @param {{ accountStore: any, store: any, builtinRoutes: any[] }} options
 */
export function createNearbyWalks({ accountStore, store, builtinRoutes }) {
  return {
    /** @param {{lat: number, lon: number, userId?: string | null}} point */
    list({ lat, lon, userId = null }) {
      const origin = { lat, lon };
      const { walks, catalogRatings, priorMean } = accountStore.listNearbyCandidates({ lat, lon, radiusM: NEARBY_RADIUS_M, userId });
      const launches = accountStore.launchTotals();
      const catalog = builtinRoutes.filter(route => route.walk?.steps?.length).flatMap(route => {
        const published = store.getPublishedWalk(route.id);
        const start = published?.walk?.start?.location;
        if (!start) return [];
        const distanceM = distance(origin, start);
        if (!(distanceM <= NEARBY_RADIUS_M)) return [];
        const rating = catalogRatings.get(route.id) ?? { ratingSum: 0, ratingCount: 0 };
        return [{ key: `catalog:${route.id}`, kind: "catalog", id: route.id, title: String(published.title ?? route.title), route: published,
          ...rating, launches: launches.get(`catalog:${route.id}`) ?? 0, listedAt: CATALOG_LISTED_AT, distanceM }];
      });
      // The store returns each walk once; an own walk that is also published stays "own".
      const account = walks.map(walk => ({ key: `account:${walk.id}`, kind: walk.own ? "own" : "shared", id: walk.own ? walk.id : walk.shareToken,
        walkId: walk.id, title: walk.title, ratingSum: walk.ratingSum, ratingCount: walk.ratingCount, launches: launches.get(`account:${walk.id}`) ?? 0,
        listedAt: (walk.own ? walk.listedAt ?? walk.updatedAt : walk.listedAt) ?? CATALOG_LISTED_AT, distanceM: walk.distanceM }));
      // Rank everything, then decode only what is shown; a damaged or route-less walk gives its place to the next one.
      const ranked = rankTopWalks([...catalog, ...account], { priorMean, limit: Infinity });
      const result = [];
      for (let start = 0; start < ranked.length && result.length < NEARBY_LIMIT; start += NEARBY_LIMIT) {
        const batch = ranked.slice(start, start + NEARBY_LIMIT);
        const documents = accountStore.getNearbyDocuments(batch.filter(item => item.kind !== "catalog").map(item => item.walkId), userId);
        for (const item of batch) {
          if (result.length >= NEARBY_LIMIT) break;
          const document = item.kind === "catalog" ? catalogDocument(item.route) : documents.get(item.walkId);
          const meta = walkDetails(document);
          if (!meta) continue;
          result.push({ kind: item.kind, id: item.id, title: item.title, ...meta, finish: finishOf(document), rating: ratingSummary(item),
            startDistanceM: Math.round(item.distanceM / DISTANCE_STEP_M) * DISTANCE_STEP_M });
        }
      }
      return result;
    },
  };
}
