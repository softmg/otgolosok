import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createWalkLaunchStore, launchViewerHash, moscowDay } from "./walk-launches.mjs";

function fixture(t, start = Date.UTC(2026, 9, 1, 12)) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  let clock = start;
  const store = createWalkLaunchStore(db, { now: () => clock, transaction: fn => fn() });
  const marks = () => Number(/** @type {any} */ (db.prepare("SELECT count(*) AS count FROM walk_launch_marks").get()).count);
  return { store, marks, advance: ms => { clock += ms; }, setClock: value => { clock = value; } };
}
const walk = { kind: /** @type {const} */ ("catalog"), id: "msk-walk" };

test("a viewer counts once per walk per Moscow day", t => {
  const { store, advance } = fixture(t);
  assert.deepEqual(store.recordLaunch(walk, "viewer-a"), { counted: true });
  assert.deepEqual(store.recordLaunch(walk, "viewer-a"), { counted: false });
  assert.deepEqual(store.recordLaunch(walk, "viewer-b"), { counted: true });
  assert.deepEqual(store.recordLaunch({ kind: "account", id: "msk-walk" }, "viewer-a"), { counted: true }, "kinds are separate walks");
  advance(86_400_000);
  assert.deepEqual(store.recordLaunch(walk, "viewer-a"), { counted: true });
  assert.deepEqual(store.launchTotals(), new Map([["catalog:msk-walk", 3], ["account:msk-walk", 1]]));
});

test("the day turns at Moscow midnight, not UTC midnight", t => {
  // 20:59 UTC is 23:59 in Moscow; 21:00 UTC is already the next Moscow day.
  const { store, setClock } = fixture(t, Date.UTC(2026, 9, 1, 20, 59));
  assert.equal(moscowDay(Date.UTC(2026, 9, 1, 20, 59)), "2026-10-01");
  assert.equal(moscowDay(Date.UTC(2026, 9, 1, 21, 0)), "2026-10-02");
  assert.equal(store.recordLaunch(walk, "viewer").counted, true);
  setClock(Date.UTC(2026, 9, 1, 21, 0));
  assert.equal(store.recordLaunch(walk, "viewer").counted, true);
  setClock(Date.UTC(2026, 9, 1, 23, 59));
  assert.equal(store.recordLaunch(walk, "viewer").counted, false);
});

test("marks older than yesterday are pruned at most once an hour, aggregates stay", t => {
  const { store, marks, advance } = fixture(t);
  store.recordLaunch(walk, "a");
  advance(86_400_000); store.recordLaunch(walk, "b");
  assert.equal(marks(), 2, "yesterday's mark is kept");
  advance(86_400_000); store.recordLaunch(walk, "c");
  assert.equal(marks(), 2, "the mark from two days ago is pruned");
  advance(60_000); store.recordLaunch({ kind: "account", id: "x" }, "d");
  assert.equal(marks(), 3);
  assert.equal(store.launchTotals().get("catalog:msk-walk"), 3);
});

test("invalid targets are rejected", t => {
  const { store } = fixture(t);
  for (const target of [null, { kind: "user", id: "x" }, { kind: "catalog", id: 1 }])
    assert.throws(() => store.recordLaunch(/** @type {any} */ (target), "viewer"), { code: "BAD_REQUEST" });
});

test("viewer hashes separate accounts from devices and never echo the raw key", () => {
  const key = "k".repeat(43);
  assert.equal(launchViewerHash({ userId: "anna" }), launchViewerHash({ userId: "anna" }));
  assert.notEqual(launchViewerHash({ userId: key }), launchViewerHash({ guestKey: key }));
  assert.equal(launchViewerHash({ guestKey: key }).includes(key), false);
  assert.equal(launchViewerHash({}), null);
  assert.throws(() => launchViewerHash({ guestKey: "short" }), { code: "BAD_REQUEST" });
});
