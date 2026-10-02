import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('one', 'Анна', 'anna@example.test'), ('two', 'Борис', 'boris@example.test');`);
  const store = createAccountStore(db, () => Date.UTC(2026, 8, 30));
  let sequence = 0;
  function create(title, owner = "one", mode = "loop", shared = true) {
    const walk = store.createWalk(owner, { title, idempotencyKey: `shared-test-${sequence++}`,
      snapshot: { version: 1, title, start: null, stops: [], mode, minutes: 30, route: null, jobs: [], submitting: null } });
    return shared ? store.setWalkVisibility(owner, walk.id, walk.revision, "shared") : walk;
  }
  return { db, store, create };
}

test("admin lists shared walks of every owner, with author and public token but without documents", t => {
  const { store, create } = fixture(t);
  const a = create("Арбат"), b = create("Бульвары", "two");
  create("Личная прогулка", "one", "open", false);
  const page = store.listSharedWalksAdmin();
  assert.equal(page.total, 2);
  assert.deepEqual(new Set(page.walks.map(w => w.id)), new Set([a.id, b.id]));
  const row = page.walks.find(w => w.id === a.id);
  assert.deepEqual(row.author, { id: "one", name: "Анна", email: "anna@example.test" });
  assert.equal(row.shareToken, a.shareToken);
  assert.equal(store.getSharedWalk(row.shareToken).id, a.id);
  assert.equal(row.stopCount, 0);
  assert.equal(row.walkingMinutes, null);
  assert.equal("snapshot" in row, false);
  assert.equal("snapshot_json" in row, false);
  store.setWalkVisibility("one", a.id, a.revision, "private");
  assert.equal(store.listSharedWalksAdmin().total, 1);
});

test("filters match Cyrillic case and literal search characters and combine across the full list", t => {
  const { store, create } = fixture(t);
  create("Арбат 100%", "one", "open"); create("Арбат", "two", "loop"); create("Бульвары");
  assert.equal(store.listSharedWalksAdmin({ q: "АРБАТ", author: "АННА", mode: "open" }).total, 1);
  assert.equal(store.listSharedWalksAdmin({ author: "BORIS@" }).walks[0].title, "Арбат");
  assert.equal(store.listSharedWalksAdmin({ q: "%" }).total, 1);
  assert.equal(store.listSharedWalksAdmin({ q: "' OR 1=1 --" }).total, 0);
  assert.equal(store.listSharedWalksAdmin({ q: "   " }).total, 3);
  assert.equal(store.listSharedWalksAdmin({ author: "Анна", mode: "loop" }).total, 1);
});

test("pagination is stable for equal timestamps, and clamps an empty last page", t => {
  const { store, create } = fixture(t);
  for (let index = 0; index < 7; index++) create(`Прогулка ${index}`);
  const pages = [0, 3, 6].map(offset => store.listSharedWalksAdmin({ limit: 3, offset }));
  assert.deepEqual(pages.map(p => p.walks.length), [3, 3, 1]);
  assert.deepEqual(pages.map(p => p.hasMore), [true, true, false]);
  assert.equal(new Set(pages.flatMap(p => p.walks.map(w => w.id))).size, 7);
  assert.deepEqual(store.listSharedWalksAdmin({ limit: 3, offset: 6 }), pages[2]);
  store.deleteWalk("one", pages[2].walks[0].id);
  const clamped = store.listSharedWalksAdmin({ limit: 3, offset: 6 });
  assert.equal(clamped.offset, 3); assert.equal(clamped.total, 6); assert.equal(clamped.walks.length, 3);
});

test("a damaged snapshot remains visible and cannot break filtering", t => {
  const { store, create, db } = fixture(t);
  const walk = create("Повреждённая");
  db.prepare("UPDATE user_walks SET snapshot_json = ? WHERE id = ?").run("{", walk.id);
  const page = store.listSharedWalksAdmin();
  assert.equal(page.total, 1); assert.ok(page.walks[0].snapshotError);
  assert.equal(page.walks[0].mode, null);
  assert.equal(store.listSharedWalksAdmin({ mode: "loop" }).total, 0);
});

test("empty results have a valid first page", t => {
  const { store } = fixture(t);
  assert.deepEqual(store.listSharedWalksAdmin({ offset: 100 }), { walks: [], total: 0, offset: 0, hasMore: false, pending: 0 });
});

test("invalid pagination and filters are rejected", t => {
  const { store } = fixture(t);
  for (const value of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 0.5 }, { offset: Infinity },
    { mode: "unknown" }, { q: null }, { q: "x".repeat(121) }, { author: "x".repeat(121) }]) {
    assert.throws(() => store.listSharedWalksAdmin(value), { code: "BAD_REQUEST" });
  }
});

const point = (lat, lon) => ({ lat, lon });
/** @param {any} store @param {string} title @param {string} [owner] */
function createPublic(store, title, owner = "one") {
  const start = { address: "Москва, Арбат, 1", location: point(55.75, 37.6) }, stop = { address: "Москва, Арбат, 10", location: point(55.751, 37.601) };
  const id = crypto.randomUUID();
  const snapshot = { version: 2, id, title, description: "", city: "Москва", mode: "open", minutes: 30, start,
    stops: [{ id: crypto.randomUUID(), place: stop, storyRef: null, transition: "", nextHint: "" }],
    route: { geometry: [start.location, stop.location], distanceM: 200, walkingMinutes: 3, attribution: "OSM" }, fieldChecked: false };
  const walk = store.createWalk(owner, { title, snapshot, idempotencyKey: `public-${id}` });
  return store.setWalkVisibility(owner, walk.id, walk.revision, "public");
}

test("access and listing filters narrow the list, and pending counts every public walk awaiting review", t => {
  const { store, create } = fixture(t);
  create("Ссылка");
  const pending = createPublic(store, "Ждёт"), approved = createPublic(store, "Одобрена"), hidden = createPublic(store, "Скрыта", "two");
  store.moderateWalkListing(approved.id, { action: "approve", revision: approved.revision });
  store.moderateWalkListing(hidden.id, { action: "hide", revision: hidden.revision });
  const all = store.listSharedWalksAdmin();
  assert.equal(all.total, 4);
  assert.equal(all.pending, 1);
  assert.deepEqual(Object.fromEntries(all.walks.map(w => [w.title, [w.visibility, w.listingStatus]])),
    { "Ссылка": ["shared", null], "Ждёт": ["public", "pending"], "Одобрена": ["public", "approved"], "Скрыта": ["public", "hidden"] });
  assert.equal(all.walks.find(w => w.id === pending.id).revision, pending.revision);
  assert.equal(store.listSharedWalksAdmin({ access: "shared" }).total, 1);
  assert.equal(store.listSharedWalksAdmin({ access: "public" }).total, 3);
  for (const [listing, title] of [["pending", "Ждёт"], ["approved", "Одобрена"], ["hidden", "Скрыта"]]) {
    const page = store.listSharedWalksAdmin({ listing });
    assert.deepEqual(page.walks.map(w => w.title), [title], listing);
    assert.equal(page.pending, 1, "the counter ignores filters");
  }
  assert.equal(store.listSharedWalksAdmin({ access: "shared", listing: "pending" }).total, 0);
  for (const value of [{ access: "everyone" }, { listing: "rejected" }, { access: null }])
    assert.throws(() => store.listSharedWalksAdmin(/** @type {any} */ (value)), { code: "BAD_REQUEST" });
});

test("each listed walk carries its all-time launches, zero without launches", t => {
  const { store, create } = fixture(t);
  const launched = create("Арбат"), quiet = create("Бульвары");
  store.recordLaunch({ kind: "account", id: launched.id }, "viewer-a");
  store.recordLaunch({ kind: "account", id: launched.id }, "viewer-b");
  store.recordLaunch({ kind: "catalog", id: quiet.id }, "viewer-a");
  const launches = Object.fromEntries(store.listSharedWalksAdmin().walks.map(w => [w.id, w.launches]));
  assert.deepEqual(launches, { [launched.id]: 2, [quiet.id]: 0 }, "catalog launches with the same id are not mixed in");
});

test("moderation approves or hides a public walk without bumping its revision", t => {
  const { store, db } = fixture(t);
  const walk = createPublic(store, "Публичная");
  const before = /** @type {any} */ (db.prepare("SELECT updated_at FROM user_walks WHERE id=?").get(walk.id)).updated_at;
  const approved = store.moderateWalkListing(walk.id, { action: "approve", revision: walk.revision });
  assert.equal(approved.listingStatus, "approved");
  assert.equal(approved.revision, walk.revision);
  assert.equal(approved.updatedAt, before);
  assert.equal(store.getWalk("one", walk.id).listingStatus, "approved");
  const hidden = store.moderateWalkListing(walk.id, { action: "hide", revision: walk.revision });
  assert.equal(hidden.listingStatus, "hidden");
  assert.equal(hidden.revision, walk.revision);
  // The owner's next edit is not a conflict.
  assert.equal(store.updateWalk("one", walk.id, { title: walk.title, snapshot: walk.snapshot, revision: walk.revision }).revision, walk.revision + 1);
});

test("moderation refuses stale revisions, non-public walks and bad input", t => {
  const { store, create } = fixture(t);
  const walk = createPublic(store, "Публичная");
  assert.throws(() => store.moderateWalkListing(walk.id, { action: "approve", revision: walk.revision + 1 }), { code: "CONFLICT", message: "Прогулка изменилась — обновите список." });
  const shared = create("Ссылка");
  assert.throws(() => store.moderateWalkListing(shared.id, { action: "approve", revision: shared.revision }), { code: "CONFLICT" });
  assert.equal(store.moderateWalkListing(crypto.randomUUID(), { action: "hide", revision: 0 }), null);
  for (const input of [{ action: "publish", revision: 0 }, { action: "approve", revision: -1 }, { action: "hide" }])
    assert.throws(() => store.moderateWalkListing(walk.id, /** @type {any} */ (input)), { code: "BAD_REQUEST" });
});
