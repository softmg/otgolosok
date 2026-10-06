import { catalogWalkView } from "./walk-catalog.mjs";

export const TOP_LIMIT = 20;
export const TOP_PRIOR_WEIGHT = 5;
export const CATALOG_LISTED_AT = new Date(0).toISOString();

/** Bayesian-smoothed rating multiplied by ln(1 + launches); zero launches score zero. */
export function topScore({ ratingSum, ratingCount, launches }, { priorMean, priorWeight = TOP_PRIOR_WEIGHT }) {
  const rating = (priorWeight * priorMean + ratingSum) / (priorWeight + ratingCount);
  return rating * Math.log1p(launches);
}

/**
 * Orders candidates by score, then launches, rating count, listing time (newer first) and key.
 * @template {{key: string, ratingSum: number, ratingCount: number, launches: number, listedAt: string}} T
 * @param {T[]} candidates
 * @param {{priorMean: number, priorWeight?: number, limit?: number}} options
 * @returns {T[]}
 */
export function rankTopWalks(candidates, { priorMean, priorWeight = TOP_PRIOR_WEIGHT, limit = TOP_LIMIT }) {
  return candidates
    .map(candidate => ({ candidate, score: topScore(candidate, { priorMean, priorWeight }) }))
    .sort((a, b) => b.score - a.score
      || b.candidate.launches - a.candidate.launches
      || b.candidate.ratingCount - a.candidate.ratingCount
      || (a.candidate.listedAt < b.candidate.listedAt ? 1 : a.candidate.listedAt > b.candidate.listedAt ? -1 : 0)
      || (a.candidate.key < b.candidate.key ? -1 : a.candidate.key > b.candidate.key ? 1 : 0))
    .slice(0, limit)
    .map(item => item.candidate);
}

/** Card details of a walk document, or null for a draft without a route. */
export const walkDetails = document => document?.route
  ? { walkingMinutes: document.route.walkingMinutes, distanceM: document.route.distanceM, stopCount: document.stops.length }
  : null;

/** The walk document of a catalog route, or null when its editorial data does not form a valid walk. */
export const catalogDocument = route => { try { return catalogWalkView(route).document; } catch { return null; } };

/** Card details of a catalog walk, or null when its editorial data does not form a valid walk. */
export const catalogDetails = route => walkDetails(catalogDocument(route));

/** Public rating summary: the average rounded to hundredths, null without reviews. */
export const ratingSummary = ({ ratingSum, ratingCount }) =>
  ({ average: ratingCount ? Math.round(ratingSum / ratingCount * 100) / 100 : null, count: ratingCount });

/**
 * Public ranking of catalog walks and editor-approved public account walks. Launch counts,
 * owners and authors never leave this module.
 * @param {{ accountStore: any, store: any, builtinRoutes: any[], limit?: number }} options
 */
export function createTopWalks({ accountStore, store, builtinRoutes, limit = TOP_LIMIT }) {
  return {
    list() {
      const { walks, catalogRatings, priorMean } = accountStore.listTopCandidates();
      const launches = accountStore.launchTotals();
      const catalog = builtinRoutes.filter(route => route.walk?.steps?.length).flatMap(route => {
        const published = store.getPublishedWalk(route.id);
        if (!published) return [];
        const rating = catalogRatings.get(route.id) ?? { ratingSum: 0, ratingCount: 0 };
        return [{ key: `catalog:${route.id}`, kind: "catalog", id: route.id, title: String(published.title ?? route.title), route: published,
          ...rating, launches: launches.get(`catalog:${route.id}`) ?? 0, listedAt: CATALOG_LISTED_AT }];
      });
      const account = walks.map(walk => ({ key: `account:${walk.id}`, kind: "shared", id: walk.shareToken, walkId: walk.id, title: walk.title,
        ratingSum: walk.ratingSum, ratingCount: walk.ratingCount, launches: launches.get(`account:${walk.id}`) ?? 0, listedAt: walk.listedAt ?? CATALOG_LISTED_AT }));
      // Rank everything, then decode only what is shown; a damaged or route-less walk gives
      // its place to the next one so the top stays full.
      const ranked = rankTopWalks([...catalog, ...account], { priorMean, limit: Infinity });
      const result = [];
      for (let start = 0; start < ranked.length && result.length < limit; start += limit) {
        const batch = ranked.slice(start, start + limit);
        const documents = accountStore.getTopDocuments(batch.filter(item => item.kind === "shared").map(item => item.walkId));
        for (const item of batch) {
          if (result.length >= limit) break;
          const meta = item.kind === "catalog" ? catalogDetails(item.route) : walkDetails(documents.get(item.walkId));
          if (!meta) continue;
          result.push({ kind: item.kind, id: item.id, title: item.title, ...meta, rating: ratingSummary(item) });
        }
      }
      return result;
    },
  };
}
