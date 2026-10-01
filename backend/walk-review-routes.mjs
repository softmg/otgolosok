import { validSessionCsrf } from "./auth.mjs";
import { failure } from "./domain.mjs";
import { guestKeyHash } from "./walk-reviews.mjs";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const sharedPath = new RegExp(`^/api/story-walks/shared/(${UUID})/reviews(/mine)?$`);
const catalogPath = /^\/api\/story-walks\/([a-z0-9][a-z0-9-]{0,127})\/reviews(\/mine)?$/;
const ownPath = new RegExp(`^/api/me/walks/(${UUID})/reviews(/mine)?$`);
const adminItemPath = new RegExp(`^/api/story-admin/reviews/(${UUID})/(moderate|delete)$`);
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Прогулка не найдена." } };

/** Query strings are strict: unknown or repeated keys are a client bug, not something to ignore. */
function strictQuery(url, allowed, numeric = []) {
  const entries = [...url.searchParams];
  if (entries.some(([key, value]) => !allowed.includes(key) || (numeric.includes(key) && !/^\d+$/.test(value)))
    || new Set(entries.map(([key]) => key)).size !== entries.length) throw failure("BAD_REQUEST");
  return Object.fromEntries(entries);
}

/**
 * Review endpoints for catalog, shared and own account walks, plus the editor moderation API.
 * The walk target is always resolved on the server; the client only names the walk.
 * @param {{ store: any, accountStore: any, origin: string, authSecret: string, limiter: ReturnType<typeof import("./walk-reviews.mjs").createReviewRateLimiter>,
 *   json: (res: import("node:http").ServerResponse, status: number, value: unknown) => void,
 *   body: (req: import("node:http").IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown>> }} options
 */
export function createWalkReviewRoutes({ store, accountStore, origin, authSecret, limiter, json, body }) {
  const catalogTarget = slug => {
    const route = store.getPublishedWalk(slug);
    return route?.walk?.steps?.length ? { kind: "catalog", id: slug, title: String(route.title ?? slug), revision: 0 } : null;
  };
  const accountTarget = walk => walk && !walk.snapshotError ? { kind: "account", id: walk.id, title: walk.title, revision: walk.revision } : null;

  /** Shared handler; `trusted` routes already passed the /api/me Origin and CSRF checks. */
  async function handle(req, res, url, session, { resolve, mine, trusted }) {
    if (!accountStore) { json(res, 503, { error: { code: "UNAVAILABLE", message: "Отзывы временно недоступны." } }); return; }
    const allowed = mine ? ["PUT", "DELETE"] : ["GET"];
    if (!allowed.includes(req.method)) {
      res.setHeader("Allow", allowed.join(", "));
      json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }); return;
    }
    const write = req.method !== "GET";
    if (write && !trusted) {
      // The generic same-origin gate covers POST only, so PUT and DELETE are checked here.
      if (!origin || req.headers.origin !== origin || ![undefined, "same-origin", "none"].includes(req.headers["sec-fetch-site"])) {
        json(res, 403, { error: { code: "FORBIDDEN", message: "Same-origin request required." } }); return;
      }
      if (session && !validSessionCsrf(authSecret, session.session.id, req.headers["x-csrf-token"])) {
        json(res, 403, { error: { code: "CSRF", message: "Обновите страницу и повторите действие." } }); return;
      }
    }
    const target = resolve();
    if (!target) { json(res, 404, NOT_FOUND); return; }
    const rawKey = req.headers["x-review-key"];
    const viewer = session ? { userId: session.user.id } : rawKey !== undefined ? { guestKeyHash: guestKeyHash(rawKey) } : null;
    if (!write) {
      const query = strictQuery(url, ["cursor"]);
      json(res, 200, accountStore.getWalkReviews(target, viewer, { after: query.cursor ?? null })); return;
    }
    if (url.search) throw failure("BAD_REQUEST");
    if (!viewer) { json(res, 400, { error: { code: "REVIEW_KEY_REQUIRED", message: "Не удалось определить автора отзыва. Обновите страницу." } }); return; }
    // X-Real-IP is overwritten by nginx, as for the walk planner.
    const limitKey = session ? `user:${session.user.id}` : `ip:${String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "")}`;
    const verdict = limiter.check(limitKey);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSec));
      json(res, 429, { error: { code: "RATE_LIMITED", message: "Слишком много изменений отзывов. Попробуйте позже." } }); return;
    }
    let result;
    if (req.method === "PUT") {
      const input = await body(req, 8192);
      if (!("rating" in input) || Object.keys(input).some(key => !["rating", "text"].includes(key))) throw failure("BAD_REQUEST");
      result = accountStore.saveWalkReview(target, viewer, { rating: input.rating, text: input.text });
    } else {
      result = accountStore.deleteWalkReview(target, viewer);
    }
    limiter.record(limitKey);
    json(res, 200, result);
  }

  const walkUrl = walk => walk.kind === "catalog"
    ? (catalogTarget(walk.id) ? `/walk?catalog=${encodeURIComponent(walk.id)}` : null)
    : (walk.shareToken ? `/walk?share=${walk.shareToken}` : null);
  const adminView = review => ({ ...review, walk: { kind: review.walk.kind, id: review.walk.id, title: review.walk.title, url: walkUrl(review.walk) } });

  return {
    /** Public catalog and shared-walk reviews; returns false when the path is not a review route. */
    async public(req, res, url, session) {
      const shared = sharedPath.exec(url.pathname), catalog = shared ? null : catalogPath.exec(url.pathname);
      if (!shared && !catalog) return false;
      const resolve = shared ? () => accountTarget(accountStore.getSharedWalk(shared[1])) : () => catalogTarget(catalog[1]);
      await handle(req, res, url, session, { resolve, mine: Boolean((shared ?? catalog)[2]), trusted: false });
      return true;
    },
    /** Own account walk reviews, called inside the authenticated /api/me block. */
    async own(req, res, url, session) {
      const match = ownPath.exec(url.pathname);
      if (!match) return false;
      await handle(req, res, url, session, { resolve: () => accountTarget(accountStore.getWalk(session.user.id, match[1])), mine: Boolean(match[2]), trusted: true });
      return true;
    },
    /** Editor moderation API inside the authorized /api/story-admin block. */
    async admin(req, res, url, editorId) {
      const list = url.pathname === "/api/story-admin/reviews", item = adminItemPath.exec(url.pathname);
      if (!list && !item) return false;
      if (!accountStore) { json(res, 503, { error: { code: "UNAVAILABLE", message: "Хранилище отзывов недоступно." } }); return true; }
      if (list && req.method === "GET") {
        const query = strictQuery(url, ["status", "rating", "q", "limit", "offset"], ["rating", "limit", "offset"]);
        const page = accountStore.listWalkReviewsAdmin({
          status: query.status ?? "pending", rating: query.rating === undefined ? null : Number(query.rating), q: query.q ?? "",
          limit: Number(query.limit ?? 25), offset: Number(query.offset ?? 0),
        });
        json(res, 200, { ...page, reviews: page.reviews.map(adminView) }); return true;
      }
      if (item && req.method === "POST") {
        if (url.search) throw failure("BAD_REQUEST");
        const input = await body(req);
        if (item[2] === "moderate") {
          if (Object.keys(input).some(key => key !== "action")) throw failure("BAD_REQUEST");
          const review = accountStore.moderateWalkReview(item[1], input.action, editorId);
          json(res, review ? 200 : 404, review ? { review: adminView(review) } : { error: { code: "NOT_FOUND", message: "Отзыв не найден." } }); return true;
        }
        if (Object.keys(input).length) throw failure("BAD_REQUEST");
        const deleted = accountStore.deleteWalkReviewAdmin(item[1]);
        json(res, deleted ? 200 : 404, deleted ? { success: true } : { error: { code: "NOT_FOUND", message: "Отзыв не найден." } }); return true;
      }
      res.setHeader("Allow", list ? "GET" : "POST");
      json(res, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed." } }); return true;
    },
  };
}
