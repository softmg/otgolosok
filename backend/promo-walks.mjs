import { randomUUID } from "node:crypto";
import { planToWalkDocument } from "./walk-plan-document.mjs";
import { walkPlanErrorResponse } from "./walk-plan-errors.mjs";
import { resolveWalkView } from "./walk-view.mjs";

// Owner of the walks linked from YouTube Shorts. Deleting this user cascades to
// every promo walk and breaks every published share link.
export const PROMO_WALKS_USER_ID = "promo-walks";

const badRequest = message => Object.assign(new Error(message), { code: "BAD_REQUEST" });
const conflict = () => Object.assign(new Error("Idempotency key belongs to another promo walk"), { code: "CONFLICT" });
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const forbidden = /[\p{Cc}\p{Cf}<>]/u;

/**
 * Creates the service user without a credential account, so nobody can sign in as it.
 * @param {import("node:sqlite").DatabaseSync} db Better Auth database connection.
 */
export function ensurePromoWalksUser(db, now = Date.now) {
  const columns = db.prepare("PRAGMA table_info(user)").all().map(row => row.name);
  if (!columns.includes("role")) throw new Error("Better Auth user table has no role column");
  const time = new Date(now()).toISOString();
  db.prepare("INSERT OR IGNORE INTO user(id,name,email,emailVerified,role,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)")
    .run(PROMO_WALKS_USER_ID, "Отголосок · промо-прогулки", "promo-walks@service.invalid", 1, "service", time, time);
}

function parseInput(input) {
  if (!object(input) || Object.keys(input).some(key => !["idempotencyKey", "title", "description", "dryRun", "walk"].includes(key))) throw badRequest("Unknown promo walk field");
  const { idempotencyKey, title, description = "", dryRun = false, walk } = input;
  if (typeof idempotencyKey !== "string" || !/^[\w.-]{8,100}$/.test(idempotencyKey)) throw badRequest("Invalid idempotencyKey");
  if (typeof title !== "string") throw badRequest("Invalid title");
  const cleanTitle = title.trim().replace(/\s+/g, " ");
  if (!cleanTitle || cleanTitle.length > 120 || forbidden.test(cleanTitle)) throw badRequest("Invalid title");
  if (typeof description !== "string" || description.length > 1000 || forbidden.test(description)) throw badRequest("Invalid description");
  if (typeof dryRun !== "boolean" || !object(walk)) throw badRequest("Invalid walk");
  return { idempotencyKey, title: cleanTitle, description, dryRun, walk };
}

const sameLocation = (a, b) => a?.lat === b?.lat && a?.lon === b?.lon;
function matches(stored, request) {
  const document = stored.snapshot;
  if (!document || stored.snapshotError) return false;
  if (stored.title !== request.title || document.mode !== request.walk.mode || document.minutes !== request.walk.minutes || !sameLocation(document.start?.location, request.walk.start?.location)) return false;
  if (request.walk.stops === undefined) return true;
  return Array.isArray(request.walk.stops) && request.walk.stops.length === document.stops.length
    && request.walk.stops.every((stop, index) => sameLocation(stop?.location, document.stops[index].place.location));
}

/**
 * @param {{accountStore: ReturnType<typeof import("./account-store.mjs").createAccountStore>, planWalk: Function, store: any, origin: string}} options
 */
export function createPromoWalkService({ accountStore, planWalk, store, origin }) {
  const plan = async request => {
    // Every automatic stop of a promo walk must tell a published story: the video voices them.
    try { return { plan: await planWalk(request.walk, { client: "service:promo-walks", storiesOnly: true }) }; }
    catch (error) { return { failure: walkPlanErrorResponse(error) }; }
  };
  const document = (request, planned) => planToWalkDocument(planned, {
    id: randomUUID(), title: request.title, description: request.description,
    mode: request.walk.mode, minutes: request.walk.minutes, start: request.walk.start,
  });
  const respond = (status, walk) => ({
    status, headers: {},
    body: {
      walk: { id: walk.id, title: walk.title, revision: walk.revision, shareToken: walk.shareToken, shareUrl: `${origin}/walk?share=${walk.shareToken}`, createdAt: walk.createdAt },
      view: resolveWalkView(walk.snapshot, walk.revision, store),
    },
  });
  // The trusted promo service publishes straight to the top. A replay after a crash between
  // createWalk and setWalkVisibility, or of a walk created when promo walks were link-only,
  // finishes the publication.
  const shared = walk => walk.visibility === "public" ? walk : accountStore.setWalkVisibility(PROMO_WALKS_USER_ID, walk.id, walk.revision, "public", { autoApprove: true });
  const replay = request => {
    const stored = accountStore.findWalkByIdempotencyKey(PROMO_WALKS_USER_ID, request.idempotencyKey);
    if (!stored) return null;
    if (!matches(stored, request)) throw conflict();
    return respond(200, shared(stored));
  };

  return {
    async create(input) {
      const request = parseInput(input);
      if (request.dryRun) {
        const result = await plan(request);
        if (result.failure) return result.failure;
        return { status: 200, headers: {}, body: { view: resolveWalkView(document(request, result.plan), 0, store) } };
      }
      const replayed = replay(request);
      if (replayed) return replayed;
      const result = await plan(request);
      if (result.failure) return result.failure;
      const snapshot = document(request, result.plan);
      let walk;
      try {
        walk = accountStore.createWalk(PROMO_WALKS_USER_ID, { title: request.title, snapshot, idempotencyKey: request.idempotencyKey }, { maxWalks: Infinity });
      } catch (error) {
        // A concurrent request with the same key won the insert.
        if (error?.code === "CONFLICT") { const winner = replay(request); if (winner) return winner; }
        throw error;
      }
      return respond(201, shared(walk));
    },
  };
}
