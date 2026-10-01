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
    return shared ? store.setWalkSharing(owner, walk.id, walk.revision, true) : walk;
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
  store.setWalkSharing("one", a.id, a.revision, false);
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
  assert.deepEqual(store.listSharedWalksAdmin({ offset: 100 }), { walks: [], total: 0, offset: 0, hasMore: false });
});

test("invalid pagination and filters are rejected", t => {
  const { store } = fixture(t);
  for (const value of [{ limit: 0 }, { limit: 51 }, { offset: -1 }, { offset: 0.5 }, { offset: Infinity },
    { mode: "unknown" }, { q: null }, { q: "x".repeat(121) }, { author: "x".repeat(121) }]) {
    assert.throws(() => store.listSharedWalksAdmin(value), { code: "BAD_REQUEST" });
  }
});
