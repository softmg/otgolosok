import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { nextSlots } from "./promo-slots.mjs";

const snapshot = title => ({ version: 1, title, start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null });

/** Account store on a fixed clock with a few walks. */
function fixture(t, nowIso = "2026-10-05T09:00:00Z") {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('one','Анна','anna@example.test')");
  let clock = Date.parse(nowIso);
  const store = createAccountStore(db, () => clock);
  let sequence = 0;
  const walk = (title, visibility = "shared") => {
    const created = store.createWalk("one", { title, idempotencyKey: `promo-test-${sequence++}`, snapshot: snapshot(title) });
    return visibility === "private" ? created : store.setWalkVisibility("one", created.id, created.revision, visibility);
  };
  return { db, store, walk, tick: ms => { clock += ms; } };
}
const code = fn => { try { fn(); return "ok"; } catch (error) { return error.code; } };

test("slots: Mon–Thu 19:00 and Fri–Sun 21:00 Moscow time, at least 30 minutes ahead", () => {
  /** @type {[string, string[]][]} */
  const cases = [
    // Monday 2026-10-05 15:29 UTC (18:29 MSK): today's 19:00 is exactly 31 minutes ahead.
    ["2026-10-05T15:29:00Z", ["2026-10-05T16:00:00.000Z", "2026-10-06T16:00:00.000Z"]],
    // 18:30 MSK: today's slot is 30 minutes ahead — not strictly after the lead, so tomorrow.
    ["2026-10-05T15:30:00Z", ["2026-10-06T16:00:00.000Z", "2026-10-07T16:00:00.000Z"]],
    // Thursday evening → Friday 21:00 MSK.
    ["2026-10-08T17:00:00Z", ["2026-10-09T18:00:00.000Z", "2026-10-10T18:00:00.000Z"]],
    // Sunday after the slot → Monday 19:00.
    ["2026-10-11T19:00:00Z", ["2026-10-12T16:00:00.000Z", "2026-10-13T16:00:00.000Z"]],
    // 23:30 UTC on Sunday is already Monday 02:30 in Moscow.
    ["2026-10-11T23:30:00Z", ["2026-10-12T16:00:00.000Z", "2026-10-13T16:00:00.000Z"]],
  ];
  for (const [now, expected] of cases) assert.deepEqual(nextSlots(new Date(now), 2), expected, now);
});

test("enqueue keeps order, plans slots and refuses duplicates and unshared walks", t => {
  const { store, walk } = fixture(t);
  const a = walk("Арбат"), b = walk("Бульвары"), hidden = walk("Личная", "private");
  store.enqueuePromo(a.id); store.enqueuePromo(b.id);
  const { items } = store.listPromoQueue();
  assert.deepEqual(items.map(item => [item.title, item.status, item.slotAt]), [
    ["Арбат", "queued", "2026-10-05T16:00:00.000Z"],
    ["Бульвары", "queued", "2026-10-06T16:00:00.000Z"],
  ]);
  assert.equal(items[0].shareToken, a.shareToken);
  assert.equal(code(() => store.enqueuePromo(a.id)), "CONFLICT");
  assert.equal(code(() => store.enqueuePromo(hidden.id)), "CONFLICT");
  assert.equal(store.enqueuePromo("33333333-3333-4333-8333-333333333333"), null);
  assert.equal(code(() => store.enqueuePromo("")), "BAD_REQUEST");
});

test("move up, remove and stale revisions", t => {
  const { store, walk } = fixture(t);
  const [a, b] = [walk("А"), walk("Б")].map(w => store.enqueuePromo(w.id));
  assert.equal(code(() => store.movePromoUp(b.id, b.revision + 1)), "CONFLICT");
  store.movePromoUp(b.id, b.revision);
  assert.deepEqual(store.listPromoQueue().items.map(item => item.title), ["Б", "А"]);
  const first = store.listPromoQueue().items[0];
  // The first item stays first.
  assert.equal(store.movePromoUp(first.id, first.revision).title, "Б");
  const current = store.getPromo(a.id);
  assert.equal(store.removePromo(a.id, current.revision), true);
  assert.deepEqual(store.listPromoQueue().items.map(item => item.title), ["Б"]);
  assert.equal(store.removePromo(a.id, 0), false);
});

test("claim, report and the full life of an item", t => {
  const { store, walk } = fixture(t);
  const items = [walk("А"), walk("Б"), walk("В")].map(w => store.enqueuePromo(w.id));
  const claimed = store.claimPromo(2);
  assert.deepEqual(claimed.map(item => [item.title, item.status]), [["А", "building"], ["Б", "building"]]);
  assert.equal(code(() => store.removePromo(claimed[0].id, claimed[0].revision)), "CONFLICT", "a building item is Shorts' to handle");
  const ready = store.reportPromo(claimed[0].id, { status: "ready", revision: claimed[0].revision, runId: "20261005-0300-abc", slotAt: "2026-10-05T16:00:00.000Z" });
  assert.deepEqual([ready.status, ready.runId, ready.slotAt], ["ready", "20261005-0300-abc", "2026-10-05T16:00:00.000Z"]);
  assert.equal(code(() => store.reportPromo(ready.id, { status: "published", revision: ready.revision, youtubeUrl: "https://youtube.com/shorts/x" })), "BAD_REQUEST");
  const published = store.reportPromo(ready.id, { status: "published", revision: ready.revision, youtubeUrl: "https://www.youtube.com/shorts/abc", telegramUrl: "https://t.me/otgolosok_online/11" });
  assert.equal(published.status, "published");
  assert.equal(code(() => store.reportPromo(published.id, { status: "ready", revision: published.revision })), "CONFLICT");
  const failed = store.reportPromo(claimed[1].id, { status: "failed", revision: claimed[1].revision, error: "WALK_START" });
  assert.equal(failed.error, "WALK_START");
  assert.equal(code(() => store.reportPromo(items[2].id, { status: "ready", revision: items[2].revision })), "CONFLICT", "queued items are claimed first");
  const back = store.requeuePromo(failed.id, failed.revision);
  assert.deepEqual([back.status, back.error], ["queued", null]);
  assert.deepEqual(store.listPromoQueue().items.map(item => item.title), ["В", "Б"]);
  assert.deepEqual(store.listPromoQueue().history.map(item => item.title), ["А"]);
});

test("a ready item keeps its slot, postpone goes to the head, cancel needs no URLs", t => {
  const { store, walk } = fixture(t);
  [walk("А"), walk("Б"), walk("В")].forEach(w => store.enqueuePromo(w.id));
  const [a] = store.claimPromo(1);
  const ready = store.reportPromo(a.id, { status: "ready", revision: a.revision, slotAt: "2026-10-06T16:00:00.000Z" });
  assert.deepEqual(store.listPromoQueue().items.map(item => [item.title, item.slotAt]), [
    ["А", "2026-10-06T16:00:00.000Z"], ["Б", "2026-10-05T16:00:00.000Z"], ["В", "2026-10-07T16:00:00.000Z"],
  ]);
  const postponed = store.reportPromo(ready.id, { status: "queued", revision: ready.revision });
  assert.deepEqual([postponed.status, postponed.slotAt === null || typeof postponed.slotAt === "string"], ["queued", true]);
  assert.equal(store.listPromoQueue().items[0].title, "А");
  const [again] = store.claimPromo(1);
  assert.equal(again.title, "А");
  const ready2 = store.reportPromo(again.id, { status: "ready", revision: again.revision });
  const cancelled = store.reportPromo(ready2.id, { status: "cancelled", revision: ready2.revision, error: "Отменено владельцем" });
  assert.deepEqual([cancelled.status, cancelled.error], ["cancelled", "Отменено владельцем"]);
});

test("claim fails walks that are no longer shared", t => {
  const { store, walk } = fixture(t);
  const a = walk("А"), b = walk("Б");
  store.enqueuePromo(a.id); store.enqueuePromo(b.id);
  store.setWalkVisibility("one", a.id, a.revision, "private");
  assert.deepEqual(store.claimPromo(1).map(item => item.title), ["Б"]);
  assert.equal(store.listPromoQueue().history[0].error, "WALK_NOT_SHARED");
});

test("reports validate fields", t => {
  const { store, walk } = fixture(t);
  store.enqueuePromo(walk("А").id);
  const [item] = store.claimPromo(1);
  for (const patch of [
    { status: "ready", revision: item.revision, extra: 1 },
    { status: "done", revision: item.revision },
    { status: "ready", revision: -1 },
    { status: "ready", revision: item.revision, runId: "../x" },
    { status: "ready", revision: item.revision, slotAt: "завтра" },
    { status: "failed", revision: item.revision },
    { status: "failed", revision: item.revision, error: "x".repeat(501) },
    { status: "published", revision: item.revision, youtubeUrl: "http://insecure", telegramUrl: "https://t.me/a/1" },
  ]) assert.equal(code(() => store.reportPromo(item.id, patch)), "BAD_REQUEST", JSON.stringify(patch).slice(0, 80));
  assert.equal(code(() => store.claimPromo(4)), "BAD_REQUEST");
});

test("admin list: promo state and the «без промо» filter", t => {
  const { store, walk } = fixture(t);
  const a = walk("А"), b = walk("Б"), c = walk("В");
  store.enqueuePromo(a.id); store.enqueuePromo(b.id);
  const [claimed] = store.claimPromo(1);
  const ready = store.reportPromo(claimed.id, { status: "ready", revision: claimed.revision });
  store.reportPromo(ready.id, { status: "published", revision: ready.revision, youtubeUrl: "https://www.youtube.com/shorts/abc", telegramUrl: "https://t.me/c/1" });
  const titles = promo => store.listSharedWalksAdmin({ promo }).walks.map(row => row.title).sort();
  assert.deepEqual(titles("none"), ["В"]);
  assert.deepEqual(titles("active"), ["Б"]);
  assert.deepEqual(titles("published"), ["А"]);
  const rows = new Map(store.listSharedWalksAdmin().walks.map(row => [row.title, row.promo]));
  assert.deepEqual(rows.get("А"), { status: "published", slotAt: null, youtubeUrl: "https://www.youtube.com/shorts/abc" });
  assert.equal(rows.get("Б").status, "queued");
  assert.equal(typeof rows.get("Б").slotAt, "string");
  assert.equal(rows.get("В"), null);
  assert.equal(code(() => store.listSharedWalksAdmin({ promo: "bad" })), "BAD_REQUEST");
  void c;
});

test("API: editors manage the queue, Shorts claims and reports with the service token", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('owner','Анна','anna@example.test')");
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  const secret = "promo-queue-secret-longer-than-32-chars", token = "promo-queue-service-token-longer-than-32";
  let role = "editor";
  const auth = /** @type {any} */ ({ api: { getSession: async () => role ? { user: { id: "owner", role }, session: { id: "session", createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore, auth, authSecret: secret, promoWalksToken: token, provider: null, origin: "http://localhost", audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (app.server.address()).port}`;
  const { sessionCsrfToken } = await import("./auth.mjs");
  const created = accountStore.createWalk("owner", { title: "Арбат", idempotencyKey: "promo-api-1", snapshot: snapshot("Арбат") });
  const walk = accountStore.setWalkVisibility("owner", created.id, created.revision, "shared");
  /** @param {string} path @param {unknown} [body] @param {Record<string, string>} [headers] */
  const admin = (path, body, headers = { "X-CSRF-Token": sessionCsrfToken(secret, "session") }) =>
    fetch(`${base}/api/story-admin/promo-queue${path}`, body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers }, body: JSON.stringify(body) });
  const service = (path, body, auth = `Bearer ${token}`) =>
    fetch(`${base}/api/service/promo-queue${path}`, body === undefined ? { headers: { Authorization: auth } } : { method: "POST", headers: { "Content-Type": "application/json", Authorization: auth }, body: JSON.stringify(body) });

  assert.equal((await admin("", { walkId: walk.id }, {})).status, 403, "CSRF is required");
  assert.equal((await admin("", { walkId: walk.id, extra: 1 })).status, 400);
  const enqueued = await admin("", { walkId: walk.id });
  assert.equal(enqueued.status, 201);
  const item = /** @type {any} */ (await enqueued.json()).item;
  assert.equal((await admin("", { walkId: walk.id })).status, 409);
  assert.equal((await admin("", { walkId: "33333333-3333-4333-8333-333333333333" })).status, 404);
  const list = /** @type {any} */ (await (await admin("")).json());
  assert.equal(list.items[0].id, item.id);

  assert.equal((await service("/claim", { count: 1 }, "Bearer wrong-token-wrong-token-wrong-token")).status, 401);
  assert.equal((await service("/claim", { count: 9 })).status, 400);
  const claim = /** @type {any} */ (await (await service("/claim", { count: 1 })).json());
  assert.deepEqual(claim.items.map(entry => [entry.id, entry.status, entry.shareToken]), [[item.id, "building", walk.shareToken]]);
  const read = /** @type {any} */ (await (await service(`/${item.id}`)).json()).item;
  assert.equal(read.status, "building");
  assert.equal((await service(`/${item.id}/report`, { status: "ready", revision: read.revision + 5 })).status, 409);
  const reported = await service(`/${item.id}/report`, { status: "ready", revision: read.revision, runId: "run-1" });
  assert.equal(reported.status, 200);
  assert.equal((await service(`/${item.id}/report`)).status, 405);
  assert.equal((await service("/33333333-3333-4333-8333-333333333333")).status, 404);

  assert.equal((await admin(`/${item.id}/remove`, { revision: read.revision + 1 })).status, 409, "ready items are not removed from the admin");
  role = "user";
  assert.equal((await admin("")).status, 401);
});
