import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore, moderatedTextHash } from "./account-store.mjs";
import { PROMO_WALKS_USER_ID } from "./promo-walks.mjs";

const a = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const b = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };
const c = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.602 } };
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
/** @param {string} [title] */
const routed = (title = "Арбат") => ({
  version: 2, id: uuid(), title, description: "Про дома", city: "Москва", mode: "open", minutes: 30, start: a, destination: c,
  stops: [{ id: uuid(), place: b, storyRef: null, transition: "Идём дальше", nextHint: "Ищите арку" }],
  route: { geometry: [a.location, b.location, c.location], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, fieldChecked: false,
});
/** @param {string} title */
const draft = title => { const doc = /** @type {any} */ (routed(title)); delete doc.destination; return { ...doc, route: null }; };

/** @param {any} t */
function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','Борис','boris@example.test')`);
  const store = createAccountStore(db, () => Date.UTC(2026, 9, 1));
  let key = 0;
  /** @param {any} [snapshot] */
  const create = (snapshot = routed(), owner = "anna") => store.createWalk(owner, { title: snapshot.title, snapshot, idempotencyKey: `visibility-${key++}` });
  /** @param {string} id */
  const row = id => /** @type {any} */ (db.prepare("SELECT visibility, listing_status, listing_text_hash, listing_updated_at FROM user_walks WHERE id=?").get(id));
  return { db, store, create, row };
}
/** @param {any} store @param {any} walk @param {string} visibility @param {any} [options] */
const set = (store, walk, visibility, options) => store.setWalkVisibility("anna", walk.id, walk.revision, visibility, options);

test("every access transition keeps one share token and bumps the revision", t => {
  const levels = ["private", "shared", "public"];
  for (const from of levels) for (const to of levels) {
    const { store, create } = fixture(t);
    let walk = create();
    if (from !== "private") walk = set(store, walk, from);
    const token = walk.shareToken;
    const next = set(store, walk, to);
    assert.equal(next.visibility, to, `${from}→${to}`);
    assert.equal(next.revision, walk.revision + 1, `${from}→${to}`);
    if (to === "private") assert.equal(next.shareToken, null);
    else {
      assert.match(next.shareToken, /^[a-f0-9-]{36}$/);
      if (token) assert.equal(next.shareToken, token, `${from}→${to} reuses the token`);
    }
    assert.equal(next.listingStatus, to === "public" ? "pending" : null, `${from}→${to}`);
    if (token) assert.equal(Boolean(store.getSharedWalk(token)), to !== "private", `${from}→${to} link`);
  }
});

test("a stale revision is idempotent for the current level and a conflict otherwise", t => {
  const { store, create } = fixture(t);
  const walk = create(), shared = set(store, walk, "shared");
  assert.equal(set(store, walk, "shared").revision, shared.revision);
  assert.throws(() => set(store, walk, "public"), { code: "CONFLICT" });
  assert.throws(() => set(store, walk, "private"), { code: "CONFLICT" });
});

test("invalid requests are rejected and another owner's walk is null", t => {
  const { store, create } = fixture(t);
  const walk = create();
  for (const [id, revision, visibility] of [["nope", 0, "public"], [walk.id, -1, "public"], [walk.id, 0.5, "shared"], [walk.id, 0, "everyone"], [walk.id, 0, undefined]])
    assert.throws(() => store.setWalkVisibility("anna", id, revision, visibility), { code: "BAD_REQUEST" });
  assert.equal(store.setWalkVisibility("boris", walk.id, walk.revision, "public"), null);
});

test("a draft cannot be public, but can be shared", t => {
  const { store, create } = fixture(t);
  const walk = create(draft("Черновик"));
  assert.throws(() => set(store, walk, "public"), { code: "WALK_NOT_READY" });
  assert.equal(set(store, walk, "shared").visibility, "shared");
});

test("an editor's hide survives every owner toggle and edit", t => {
  const { store, create } = fixture(t);
  let walk = set(store, create(), "public");
  store.moderateWalkListing(walk.id, { action: "hide", revision: walk.revision });
  walk = set(store, walk, "private");
  assert.equal(walk.listingStatus, null, "a private walk shows no listing state");
  walk = set(store, walk, "public");
  assert.equal(walk.listingStatus, "hidden");
  walk = set(store, set(store, walk, "shared"), "public", { autoApprove: true });
  assert.equal(walk.listingStatus, "hidden");
  walk = store.updateWalk("anna", walk.id, { title: "Новое", snapshot: { ...walk.snapshot, title: "Новое" }, revision: walk.revision });
  assert.equal(walk.listingStatus, "hidden");
  assert.equal(store.getSharedWalk(walk.shareToken).id, walk.id, "the link keeps working");
});

test("an approval survives a round trip only while the moderated texts are unchanged", t => {
  const { store, create, row } = fixture(t);
  let walk = set(store, create(), "public");
  store.moderateWalkListing(walk.id, { action: "approve", revision: walk.revision });
  walk = set(store, set(store, store.getWalk("anna", walk.id), "private"), "public");
  assert.equal(walk.listingStatus, "approved");
  walk = set(store, walk, "shared");
  walk = store.updateWalk("anna", walk.id, { title: "Другое", snapshot: { ...walk.snapshot, title: "Другое" }, revision: walk.revision });
  assert.equal(row(walk.id).listing_status, "approved", "leaving public does not touch the listing");
  walk = set(store, walk, "public");
  assert.equal(walk.listingStatus, "pending");
});

test("autoApprove publishes straight to the top with the current text hash", t => {
  const { store, create, row } = fixture(t);
  const walk = set(store, create(), "public", { autoApprove: true });
  assert.equal(walk.listingStatus, "approved");
  assert.equal(row(walk.id).listing_text_hash, moderatedTextHash(walk.title, walk.snapshot));
});

test("editing an approved public walk re-moderates only when a moderated text changes", t => {
  /** @type {Array<[string, (doc: any) => any, string]>} */
  const cases = [
    ["title", doc => ({ ...doc, title: "Новый заголовок" }), "pending"],
    ["description", doc => ({ ...doc, description: "Другое описание" }), "pending"],
    ["start address", doc => ({ ...doc, start: { ...doc.start, address: "Москва, Арбат, 2" } }), "pending"],
    ["destination address", doc => ({ ...doc, destination: { ...doc.destination, address: "Москва, Арбат, 30" } }), "pending"],
    ["stop address", doc => ({ ...doc, stops: doc.stops.map(stop => ({ ...stop, place: { ...stop.place, address: "Москва, Арбат, 11" } })) }), "pending"],
    ["transition", doc => ({ ...doc, stops: doc.stops.map(stop => ({ ...stop, transition: "Поверните" })) }), "pending"],
    ["next hint", doc => ({ ...doc, stops: doc.stops.map(stop => ({ ...stop, nextHint: "Смотрите вверх" })) }), "pending"],
    ["route only", doc => ({ ...doc, route: { ...doc.route, distanceM: 450, walkingMinutes: 7 } }), "approved"],
    ["coordinates only", doc => ({ ...doc, stops: doc.stops.map(stop => ({ ...stop, place: { ...stop.place, location: { lat: 55.7511, lon: 37.6011 } } })) }), "approved"],
  ];
  for (const [name, change, expected] of cases) {
    const { store, create } = fixture(t);
    let walk = set(store, create(), "public");
    store.moderateWalkListing(walk.id, { action: "approve", revision: walk.revision });
    const snapshot = change(walk.snapshot);
    walk = store.updateWalk("anna", walk.id, { title: snapshot.title, snapshot, revision: walk.revision });
    assert.equal(walk.listingStatus, expected, name);
  }
});

test("pending stays pending on edits", t => {
  const { store, create } = fixture(t);
  let walk = set(store, create(), "public");
  walk = store.updateWalk("anna", walk.id, { title: walk.title, snapshot: { ...walk.snapshot, description: "Иначе" }, revision: walk.revision });
  assert.equal(walk.listingStatus, "pending");
});

test("the moderated text hash is stable and covers every moderated field", () => {
  const doc = routed();
  assert.equal(moderatedTextHash("Арбат", doc), moderatedTextHash("Арбат", structuredClone(doc)));
  // NFC-equal strings hash equally.
  assert.equal(moderatedTextHash("Ёлка", doc), moderatedTextHash("Ёлка", doc));
  const variants = [
    moderatedTextHash("Другое", doc),
    moderatedTextHash("Арбат", { ...doc, title: "x" }),
    moderatedTextHash("Арбат", { ...doc, description: "x" }),
    moderatedTextHash("Арбат", { ...doc, start: { ...a, address: "x" } }),
    moderatedTextHash("Арбат", { ...doc, destination: { ...c, address: "x" } }),
    moderatedTextHash("Арбат", { ...doc, stops: [{ ...doc.stops[0], place: { ...b, address: "x" } }] }),
    moderatedTextHash("Арбат", { ...doc, stops: [{ ...doc.stops[0], transition: "x" }] }),
    moderatedTextHash("Арбат", { ...doc, stops: [{ ...doc.stops[0], nextHint: "x" }] }),
  ];
  assert.equal(new Set([moderatedTextHash("Арбат", doc), ...variants]).size, variants.length + 1);
  // Geometry and story references are not moderated.
  const unmoderated = /** @type {any} */ ({ ...doc, route: null, stops: [{ ...doc.stops[0], storyRef: { kind: "osm", id: "osm:node:1" } }] });
  assert.equal(moderatedTextHash("Арбат", unmoderated), moderatedTextHash("Арбат", doc));
});

test("owner views of a public walk carry the share token and listing state", t => {
  const { store, create } = fixture(t);
  const walk = set(store, create(), "public");
  const item = store.listWalks("anna").walks[0];
  assert.equal(item.visibility, "public");
  assert.equal(item.shareToken, walk.shareToken);
  assert.equal(item.listingStatus, "pending");
  assert.deepEqual(store.getLaunchTarget(walk.shareToken), { id: walk.id, userId: "anna" });
  set(store, walk, "private");
  assert.equal(store.getLaunchTarget(walk.shareToken), null);
});

test("the one-time promo backfill publishes link-only promo walks without touching revisions", t => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('${PROMO_WALKS_USER_ID}','Промо','promo@example.test'), ('anna','Анна','anna@example.test');
    CREATE TABLE user_walks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, title TEXT NOT NULL, snapshot_json TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, visibility TEXT NOT NULL DEFAULT 'private', share_token TEXT);`);
  const insert = db.prepare("INSERT INTO user_walks VALUES(?,?,?,?,?,?,?,?,?)");
  const promo = routed("Промо"), damaged = routed("Битая"), person = routed("Чужая"), privatePromo = routed("Личная");
  insert.run(promo.id, PROMO_WALKS_USER_ID, promo.title, JSON.stringify(promo), 3, "t0", "t0", "shared", uuid());
  insert.run(damaged.id, PROMO_WALKS_USER_ID, damaged.title, "{", 1, "t0", "t0", "shared", uuid());
  insert.run(person.id, "anna", person.title, JSON.stringify(person), 1, "t0", "t0", "shared", uuid());
  insert.run(privatePromo.id, PROMO_WALKS_USER_ID, privatePromo.title, JSON.stringify(privatePromo), 1, "t0", "t0", "private", null);
  createAccountStore(db);
  /** @param {string} id */
  const state = id => ({ .../** @type {any} */ (db.prepare("SELECT visibility, listing_status, revision, updated_at FROM user_walks WHERE id=?").get(id)) });
  assert.deepEqual(state(promo.id), { visibility: "public", listing_status: "approved", revision: 3, updated_at: "t0" });
  assert.deepEqual(state(damaged.id), { visibility: "shared", listing_status: null, revision: 1, updated_at: "t0" });
  assert.deepEqual(state(person.id), { visibility: "shared", listing_status: null, revision: 1, updated_at: "t0" });
  assert.deepEqual(state(privatePromo.id), { visibility: "private", listing_status: null, revision: 1, updated_at: "t0" });
  // A second start does not run the backfill again.
  db.prepare("UPDATE user_walks SET visibility='shared' WHERE id=?").run(promo.id);
  createAccountStore(db);
  assert.equal(state(promo.id).visibility, "shared");
});
