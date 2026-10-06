import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { builtinRoutes } from "./builtin-routes.mjs";
import { createNearbyWalks, NEARBY_LIMIT, NEARBY_RADIUS_M } from "./walk-nearby.mjs";

// Meters per degree of latitude for the haversine sphere (R = 6 371 000 m).
const M_PER_LAT = 6371000 * Math.PI / 180;
const ORIGIN = { lat: 55.8, lon: 37.5 };
const CATALOG = "msk-kozhevniki-zindel-short";
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
/** A point `meters` due north of the origin. */
const north = (/** @type {number} */ meters) => ({ lat: ORIGIN.lat + meters / M_PER_LAT, lon: ORIGIN.lon });
/**
 * @param {{lat: number, lon: number}} location
 * @param {{route?: boolean, mode?: "open" | "loop", destination?: string}} [options]
 */
const document = (location, { route = true, mode = "open", destination } = {}) => {
  const start = { address: "Москва, Тестовая, 1", location }, stop = { address: "Москва, Тестовая, 2", location: { lat: location.lat + 0.001, lon: location.lon } };
  return { version: 2, id: uuid(), title: "Прогулка", description: "", city: "Москва", mode, minutes: 30, start,
    ...(destination ? { destination: { address: destination, location: { lat: location.lat + 0.002, lon: location.lon } } } : {}),
    stops: [{ id: uuid(), place: stop, storyRef: null, transition: "", nextHint: "" }],
    route: route ? { geometry: [start.location, stop.location], distanceM: 3200, walkingMinutes: 45, attribution: "OSM" } : null, fieldChecked: false };
};

/** @param {any} t */
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','Борис','boris@example.test')`);
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  t.after(() => { store.close(); db.close(); });
  let key = 0;
  /**
   * @param {string} title @param {{lat: number, lon: number}} location
   * @param {{owner?: string, visibility?: "private" | "shared" | "public", decision?: "approve" | "hide" | null, route?: boolean, mode?: "open" | "loop", destination?: string}} [options]
   */
  const walk = (title, location, { owner = "anna", visibility = "public", decision = "approve", route = true, mode = "open", destination } = {}) => {
    const created = accountStore.createWalk(owner, { title, snapshot: document(location, { route, mode, destination }), idempotencyKey: `nearby-walk-${key++}` });
    if (visibility === "private") return created;
    const result = accountStore.setWalkVisibility(owner, created.id, created.revision, visibility);
    if (visibility === "public" && decision) accountStore.moderateWalkListing(result.id, { action: decision, revision: result.revision });
    return result;
  };
  /** @param {string} kind @param {string} id @param {number} launches */
  const launched = (kind, id, launches) => db.prepare("INSERT INTO walk_launch_days VALUES(?,?,?,?)").run(kind, id, "2026-10-01", launches);
  /** @param {string} id @param {number} rating */
  const reviewed = (id, rating) => db.prepare(`INSERT INTO walk_reviews(id,walk_kind,walk_id,walk_title,walk_revision,guest_key_hash,rating,status,created_at,updated_at)
    VALUES(?, 'account', ?, 'Прогулка', 0, ?, ?, 'published', '2026-10-01', '2026-10-01')`).run(uuid(), id, uuid(), rating);
  const nearby = createNearbyWalks({ accountStore, store, builtinRoutes });
  /** @param {string | null} [userId] @param {{lat: number, lon: number}} [point] */
  const list = (userId = null, point = ORIGIN) => nearby.list({ ...point, userId });
  return { db, accountStore, walk, launched, reviewed, list };
}

test("which account walks qualify", async t => {
  /** @type {Array<[string, (f: ReturnType<typeof fixture>) => void, string | null, string[]]>} */
  const cases = [
    [`a start at ${NEARBY_RADIUS_M - 1} m is included`, f => { f.walk("Рядом", north(NEARBY_RADIUS_M - 1)); }, null, ["Рядом"]],
    [`a start at ${NEARBY_RADIUS_M + 1} m is excluded`, f => { f.walk("Далеко", north(NEARBY_RADIUS_M + 1)); }, null, []],
    ["another person's private walk is excluded", f => { f.walk("Чужая", north(10), { owner: "boris", visibility: "private" }); }, "anna", []],
    ["another person's link-only walk is excluded", f => { f.walk("По ссылке", north(10), { owner: "boris", visibility: "shared" }); }, "anna", []],
    ["a pending public walk is excluded", f => { f.walk("На модерации", north(10), { decision: null }); }, null, []],
    ["a hidden public walk is excluded", f => { f.walk("Скрытая", north(10), { decision: "hide" }); }, null, []],
    ["an own private walk is included for its owner", f => { f.walk("Моя", north(10), { visibility: "private" }); }, "anna", ["Моя"]],
    ["an own private walk is hidden from a guest", f => { f.walk("Моя", north(10), { visibility: "private" }); }, null, []],
    ["an own draft without a route is skipped", f => { f.walk("Черновик", north(10), { visibility: "private", route: false }); }, "anna", []],
  ];
  for (const [name, arrange, userId, expected] of cases) await t.test(name, t => {
    const f = fixture(t);
    arrange(f);
    assert.deepEqual(f.list(userId).map(item => item.title), expected);
  });
});

test("an own public approved walk appears once, as own", t => {
  const f = fixture(t);
  const walk = f.walk("Моя публичная", north(100));
  assert.deepEqual(f.list("anna").map(item => [item.kind, item.id]), [["own", walk.id]]);
  assert.deepEqual(f.list(null).map(item => [item.kind, item.id]), [["shared", walk.shareToken]]);
});

test("ranking follows the top formula, own unlaunched walks go last and the list stops at the limit", t => {
  const f = fixture(t);
  const own = f.walk("Своя", north(10), { visibility: "private" });
  const few = f.walk("Мало запусков", north(20), { owner: "boris" });
  const many = f.walk("Много запусков", north(30), { owner: "boris" });
  const rated = f.walk("Высокий рейтинг", north(40), { owner: "boris" });
  const unseen = f.walk("Без запусков", north(50), { owner: "boris" });
  const once = f.walk("Один запуск", north(60), { owner: "boris" });
  const onceRated = f.walk("Один запуск с оценкой", north(70), { owner: "boris" });
  f.launched("account", few.id, 2);
  f.launched("account", many.id, 40);
  f.launched("account", rated.id, 2);
  for (let i = 0; i < 10; i++) f.reviewed(rated.id, 5);
  f.reviewed(few.id, 1);
  f.launched("account", once.id, 1);
  f.launched("account", onceRated.id, 1);
  f.reviewed(onceRated.id, 5);
  const items = f.list("anna");
  assert.equal(items.length, NEARBY_LIMIT);
  assert.deepEqual(items.map(item => item.title), ["Много запусков", "Высокий рейтинг", "Мало запусков", "Один запуск с оценкой", "Один запуск"]);
  assert.deepEqual(items[1].rating, { average: 5, count: 10 });
  assert.equal(items.some(item => item.id === own.id || item.id === unseen.shareToken), false);
});

test("an own walk without launches ranks below a launched public one", t => {
  const f = fixture(t);
  f.walk("Своя", north(10), { visibility: "private" });
  f.launched("account", f.walk("Чужая", north(400), { owner: "boris" }).id, 1);
  assert.deepEqual(f.list("anna").map(item => [item.kind, item.title]), [["shared", "Чужая"], ["own", "Своя"]]);
});

test("a damaged walk gives its slot to the next one", t => {
  const f = fixture(t);
  const broken = f.walk("Повреждённая", north(10), { owner: "boris" });
  f.launched("account", broken.id, 100);
  const titles = ["Вторая", "Третья", "Четвёртая", "Пятая", "Шестая"];
  for (const [index, title] of titles.entries()) f.launched("account", f.walk(title, north(20 + index), { owner: "boris" }).id, 10 - index);
  f.db.prepare("UPDATE user_walks SET snapshot_json='{broken' WHERE id=?").run(broken.id);
  assert.deepEqual(f.list().map(item => item.title), titles);
});

test("the card names where the walk ends", async t => {
  /** @type {Array<[string, {mode?: "open" | "loop", destination?: string}, string | null]>} */
  const cases = [
    ["an open walk ends at its last stop", {}, "Москва, Тестовая, 2"],
    ["a chosen destination wins over the last stop", { destination: "Москва, Финишная, 5" }, "Москва, Финишная, 5"],
    ["a loop returns to its start", { mode: "loop" }, null],
  ];
  for (const [name, options, finish] of cases) await t.test(name, t => {
    const f = fixture(t);
    f.walk("Прогулка", north(10), options);
    assert.equal(f.list()[0].finish, finish);
  });
});

test("catalog walks qualify by the start of their route", t => {
  const f = fixture(t);
  const catalogStart = { lat: 55.7256731, lon: 37.6484745 };
  const near = f.list(null, { lat: catalogStart.lat + 300 / M_PER_LAT, lon: catalogStart.lon });
  assert.deepEqual(near.map(item => [item.kind, item.id, item.startDistanceM]), [["catalog", CATALOG, 300]]);
  assert.equal(near[0].stopCount > 0 && near[0].walkingMinutes > 0, true);
  assert.equal(typeof near[0].finish === "string" && !near[0].finish.startsWith("Финиш"), true);
  assert.deepEqual(f.list(null, { lat: catalogStart.lat + (NEARBY_RADIUS_M + 50) / M_PER_LAT, lon: catalogStart.lon }), []);
});

test("the response carries only a rounded start distance", async t => {
  /** @type {Array<[number, number]>} */
  const cases = [[0, 0], [24, 0], [26, 50], [374, 350], [376, 400], [499, 500]];
  for (const [meters, expected] of cases) await t.test(`${meters} m → ${expected} m`, t => {
    const f = fixture(t);
    f.walk("Прогулка", north(meters));
    assert.equal(f.list()[0].startDistanceM, expected);
  });
  await t.test("no coordinates, launches or owners", t => {
    const f = fixture(t);
    f.launched("account", f.walk("Прогулка", north(10)).id, 3);
    const [item] = f.list();
    assert.deepEqual(Object.keys(item).sort(), ["distanceM", "finish", "id", "kind", "rating", "startDistanceM", "stopCount", "title", "walkingMinutes"]);
    assert.doesNotMatch(JSON.stringify(item), /anna|55\.8|37\.5/);
  });
});

test("the start columns mirror the snapshot on create and update", t => {
  const f = fixture(t);
  const columns = (/** @type {string} */ id) => f.db.prepare("SELECT start_lat AS lat,start_lon AS lon FROM user_walks WHERE id=?").get(id);
  const created = f.walk("Прогулка", north(10), { visibility: "private" });
  assert.deepEqual({ ...columns(created.id) }, north(10));
  const moved = { ...created.snapshot, start: { ...created.snapshot.start, location: north(300) } };
  f.accountStore.updateWalk("anna", created.id, { title: created.title, snapshot: moved, revision: created.revision });
  assert.deepEqual({ ...columns(created.id) }, north(300));
  const startless = { ...created.snapshot, start: null, stops: [], route: null };
  const updated = f.accountStore.getWalk("anna", created.id);
  f.accountStore.updateWalk("anna", created.id, { title: created.title, snapshot: startless, revision: updated.revision });
  assert.deepEqual({ ...columns(created.id) }, { lat: null, lon: null });
});

test("the start columns are backfilled once, leaving damaged rows empty", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('anna','Анна','anna@example.test');
    CREATE TABLE user_walks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
      title TEXT NOT NULL, snapshot_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  const good = document(north(10)), insert = db.prepare("INSERT INTO user_walks VALUES(?,'anna','Прогулка',?,0,'2026-01-01','2026-01-01')");
  insert.run(good.id, JSON.stringify(good));
  insert.run(uuid(), "{broken");
  createAccountStore(db);
  const rows = () => db.prepare("SELECT start_lat AS lat,start_lon AS lon FROM user_walks ORDER BY id").all().map(row => ({ ...row }));
  assert.deepEqual(rows(), [north(10), { lat: null, lon: null }]);
  // A second start keeps the columns and does not re-run the backfill over manual changes.
  db.prepare("UPDATE user_walks SET start_lat=NULL WHERE id=?").run(good.id);
  createAccountStore(db);
  assert.equal(rows()[0].lat, null);
  db.close();
});
