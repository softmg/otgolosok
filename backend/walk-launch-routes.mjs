import { validSessionCsrf } from "./auth.mjs";
import { failure } from "./domain.mjs";
import { launchViewerHash } from "./walk-launches.mjs";

const UUID = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const sharedPath = new RegExp(`^/api/story-walks/shared/(${UUID})/launches$`);
const catalogPath = /^\/api\/story-walks\/([a-z0-9][a-z0-9-]{0,127})\/launches$/;
const NOT_FOUND = { error: { code: "NOT_FOUND", message: "Прогулка не найдена." } };

/**
 * Launch reports of catalog and shared/public walks ("Начать прогулку"). Called inside the
 * generic same-origin POST gate. The response never reveals launch totals.
 *
 * Two limits: `limiter` caps reports per account or client IP (429), and `walkLimiter` caps
 * counted launches of one walk per IP, so rotating device keys cannot inflate a walk; a crowd
 * behind one CGNAT address still gets 30 counted launches per walk per day.
 * @param {{ store: any, accountStore: any, authSecret: string,
 *   limiter: ReturnType<typeof import("./walk-reviews.mjs").createReviewRateLimiter>,
 *   walkLimiter: ReturnType<typeof import("./walk-reviews.mjs").createReviewRateLimiter>,
 *   json: (res: import("node:http").ServerResponse, status: number, value: unknown) => void,
 *   body: (req: import("node:http").IncomingMessage, maxBytes?: number) => Promise<Record<string, unknown>> }} options
 */
export function createWalkLaunchRoutes({ store, accountStore, authSecret, limiter, walkLimiter, json, body }) {
  const catalogTarget = slug => store.getPublishedWalk(slug)?.walk?.steps?.length ? { kind: "catalog", id: slug, userId: null } : null;
  const sharedTarget = token => {
    const walk = accountStore?.getLaunchTarget(token);
    return walk ? { kind: "account", id: walk.id, userId: walk.userId } : null;
  };

  /** Returns false when the path is not a launch route. */
  return async function launches(req, res, url, session) {
    const shared = sharedPath.exec(url.pathname), catalog = shared ? null : catalogPath.exec(url.pathname);
    if (!shared && !catalog) return false;
    if (!accountStore) { json(res, 503, { error: { code: "UNAVAILABLE", message: "Учёт запусков временно недоступен." } }); return true; }
    if (url.search) throw failure("BAD_REQUEST");
    if (session && !validSessionCsrf(authSecret, session.session.id, req.headers["x-csrf-token"])) {
      json(res, 403, { error: { code: "CSRF", message: "Обновите страницу и повторите действие." } }); return true;
    }
    const input = await body(req, 1024);
    if (Object.keys(input).length) throw failure("BAD_REQUEST");
    // A malformed device key is a client bug (400); a missing one simply is not counted.
    const viewer = launchViewerHash(session ? { userId: session.user.id } : { guestKey: req.headers["x-review-key"] });
    const target = shared ? sharedTarget(shared[1]) : catalogTarget(catalog[1]);
    if (!target) { json(res, 404, NOT_FOUND); return true; }
    if (!viewer || (session && session.user.id === target.userId)) { json(res, 200, { counted: false }); return true; }
    // X-Real-IP is overwritten by nginx, as for the walk planner.
    const ip = String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "");
    const limitKey = session ? `user:${session.user.id}` : `ip:${ip}`;
    const verdict = limiter.check(limitKey);
    if (!verdict.allowed) {
      res.setHeader("Retry-After", String(verdict.retryAfterSec));
      json(res, 429, { error: { code: "RATE_LIMITED", message: "Слишком много запусков. Попробуйте позже." } }); return true;
    }
    limiter.record(limitKey);
    const walkKey = `ip:${ip}:${target.kind}:${target.id}`;
    if (!walkLimiter.check(walkKey).allowed) { json(res, 200, { counted: false }); return true; }
    const { counted } = accountStore.recordLaunch(target, viewer);
    if (counted) walkLimiter.record(walkKey);
    json(res, 200, { counted });
    return true;
  };
}
