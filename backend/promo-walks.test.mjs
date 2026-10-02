import test from "node:test";
import assert from "node:assert/strict";
import { createAuth } from "./auth.mjs";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createPromoWalkService, ensurePromoWalksUser, PROMO_WALKS_USER_ID } from "./promo-walks.mjs";

const origin = "https://otgolosok.test";
const start = { address: "метро «Чистые пруды»", location: { lat: 55.765, lon: 37.6386 } };
const stops = [
  { address: "Мясницкая, 17", location: { lat: 55.764, lon: 37.636 }, contentId: "osm:way:42" },
  { address: "Сретенский бульвар", location: { lat: 55.766, lon: 37.637 } },
];
const plan = { stops, geometry: [start.location, { lat: 55.766, lon: 37.64 }], distanceM: 2400, walkingMinutes: 55, attribution: "© OpenStreetMap contributors" };
const request = (overrides = {}) => ({ idempotencyKey: "shorts-run-0001", title: "Прогулка от метро «Чистые пруды» · 60 минут", walk: { start, mode: "loop", minutes: 60 }, ...overrides });

/** @param {any} t @param {(input: any) => Promise<any>} [planWalk] */
async function fixture(t, planWalk = async () => plan) {
  const runtime = await createAuth({ databasePath: ":memory:", baseURL: origin, secret: "promo-walks-test-secret-longer-than-32-characters", production: false });
  const store = createStore(":memory:", { maxActive: 1 });
  t.after(() => { runtime.close(); store.close(); });
  ensurePromoWalksUser(runtime.accountDatabase);
  const accountStore = createAccountStore(runtime.accountDatabase);
  const calls = [];
  const service = createPromoWalkService({ accountStore, store, origin, planWalk: async (input, options) => { calls.push({ input, options }); return planWalk(input); } });
  const count = () => Number(runtime.accountDatabase.prepare("SELECT count(*) AS count FROM user_walks").get().count);
  return { runtime, accountStore, service, calls, count };
}

test("the service user is idempotent and has no sign-in credential", async t => {
  const { runtime } = await fixture(t);
  ensurePromoWalksUser(runtime.accountDatabase);
  assert.deepEqual({ ...runtime.accountDatabase.prepare("SELECT id,role FROM user WHERE id=?").get(PROMO_WALKS_USER_ID) }, { id: PROMO_WALKS_USER_ID, role: "service" });
  assert.equal(Number(runtime.accountDatabase.prepare("SELECT count(*) AS count FROM user").get().count), 1);
  assert.equal(Number(runtime.accountDatabase.prepare("SELECT count(*) AS count FROM account WHERE userId=?").get(PROMO_WALKS_USER_ID).count), 0);
});

test("a dry run plans and resolves the view without storing anything", async t => {
  const { service, calls, count } = await fixture(t);
  const result = await service.create(request({ dryRun: true }));
  assert.equal(result.status, 200);
  assert.equal(result.body.walk, undefined);
  // A published-content stop resolves its story; a plain stop has none to request.
  assert.deepEqual(result.body.view.chapters.map(chapter => chapter.status), ["unavailable", "not_requested"]);
  assert.deepEqual(result.body.view.document.stops.map(stop => stop.storyRef), [{ kind: "osm", id: "osm:way:42" }, null]);
  assert.deepEqual(calls[0], { input: request().walk, options: { client: "service:promo-walks", storiesOnly: true } });
  assert.equal(count(), 0);
});

test("create shares the walk and a replay returns it without planning again", async t => {
  const { service, accountStore, calls } = await fixture(t);
  const created = await service.create(request());
  assert.equal(created.status, 201);
  const { walk } = created.body;
  assert.match(walk.shareToken, /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/);
  assert.equal(walk.shareUrl, `${origin}/walk?share=${walk.shareToken}`);
  assert.equal(accountStore.getSharedWalk(walk.shareToken)?.id, walk.id);
  assert.equal(created.body.view.chapters.length, 2);
  const stored = accountStore.getWalk(PROMO_WALKS_USER_ID, walk.id);
  assert.deepEqual([stored.visibility, stored.listingStatus], ["public", "approved"], "promo walks enter the top without pre-moderation");

  const replayed = await service.create(request());
  assert.equal(replayed.status, 200);
  assert.deepEqual(replayed.body.walk, walk);
  assert.equal(calls.length, 1);
});

test("a key reused for a different walk is a conflict", async t => {
  const { service } = await fixture(t);
  await service.create(request());
  /** @type {Array<[string, any]>} */
  const cases = [
    ["minutes", request({ walk: { start, mode: "loop", minutes: 90 } })],
    ["title", request({ title: "Другая прогулка" })],
    ["start", request({ walk: { start: { ...start, location: { lat: 55.76, lon: 37.64 } }, mode: "loop", minutes: 60 } })],
    ["manual stops", request({ walk: { start, mode: "loop", minutes: 60, stops: stops.slice(0, 1) } })],
  ];
  for (const [name, input] of cases) await assert.rejects(service.create(input), { code: "CONFLICT" }, name);
});

test("a walk stored before sharing is shared on replay", async t => {
  const { service, accountStore } = await fixture(t);
  const { document } = (await service.create(request({ dryRun: true }))).body.view;
  const stored = accountStore.createWalk(PROMO_WALKS_USER_ID, { title: request().title, snapshot: document, idempotencyKey: request().idempotencyKey }, { maxWalks: Infinity });
  assert.equal(stored.visibility, "private");
  const replayed = await service.create(request());
  assert.equal(replayed.status, 200);
  assert.equal(accountStore.getSharedWalk(replayed.body.walk.shareToken)?.id, stored.id);
  assert.equal(accountStore.getWalk(PROMO_WALKS_USER_ID, stored.id).visibility, "public");
});

test("a replay publishes a promo walk created when promo walks were link-only", async t => {
  const { service, accountStore } = await fixture(t);
  const { document } = (await service.create(request({ dryRun: true }))).body.view;
  const stored = accountStore.createWalk(PROMO_WALKS_USER_ID, { title: request().title, snapshot: document, idempotencyKey: request().idempotencyKey }, { maxWalks: Infinity });
  const shared = accountStore.setWalkVisibility(PROMO_WALKS_USER_ID, stored.id, stored.revision, "shared");
  const replayed = await service.create(request());
  assert.equal(replayed.body.walk.shareToken, shared.shareToken);
  const walk = accountStore.getWalk(PROMO_WALKS_USER_ID, stored.id);
  assert.deepEqual([walk.visibility, walk.listingStatus], ["public", "approved"]);
});

test("planner failures keep their status and retry hint", async t => {
  /** @type {Array<[string, number, string | null]>} */
  const cases = [["WALK_NOT_FOUND", 404, null], ["WALK_START_UNREACHABLE", 404, null], ["WALK_DESTINATION_UNREACHABLE", 404, null], ["WALK_BUSY", 429, "2"], ["WALK_RATE_LIMITED", 429, "2"], ["WALK_UNAVAILABLE", 503, null], ["PRIVATE", 503, null], ["BAD_REQUEST", 400, null]];
  for (const [code, status, retryAfter] of cases) {
    const { service, count } = await fixture(t, async () => { throw Object.assign(new Error("secret detail"), { code }); });
    for (const dryRun of [true, false]) {
      const result = await service.create(request({ dryRun }));
      assert.equal(result.status, status, code);
      assert.equal(result.headers["Retry-After"] ?? null, retryAfter, code);
      assert.equal(JSON.stringify(result.body).includes("secret"), false, code);
    }
    assert.equal(count(), 0, code);
  }
});

test("request shape is validated before planning", async t => {
  const { service, calls } = await fixture(t);
  /** @type {Array<[string, any]>} */
  const cases = [
    ["unknown key", { ...request(), extra: 1 }],
    ["short key", request({ idempotencyKey: "short" })],
    ["empty title", request({ title: "   " })],
    ["long title", request({ title: "т".repeat(121) })],
    ["markup in title", request({ title: "<b>Прогулка</b>" })],
    ["multi-line description", request({ description: "строка\nстрока" })],
    ["long description", request({ description: "о".repeat(1001) })],
    ["dryRun type", request({ dryRun: "yes" })],
    ["missing walk", request({ walk: undefined })],
  ];
  for (const [name, input] of cases) await assert.rejects(service.create(input), { code: "BAD_REQUEST" }, name);
  assert.equal(calls.length, 0);
});
