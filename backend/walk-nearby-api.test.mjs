import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";

const origin = "https://nearby.test", secret = "walk-nearby-api-secret-longer-than-32-chars";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stop = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
const routed = () => ({ version: 2, id: uuid(), title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30, start,
  stops: [{ id: uuid(), place: stop, storyRef: null, transition: "", nextHint: "" }],
  route: { geometry: [start.location, stop.location], distanceM: 3200, walkingMinutes: 45, attribution: "OSM" }, fieldChecked: false });
const NEAR = "/api/walks/nearby?lat=55.751&lon=37.6";

/** @param {any} t @param {{ withAccounts?: boolean }} [options] */
async function fixture(t, { withAccounts = true } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('anna','Анна','anna@example.test')");
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  /** @type {string | null} */
  let user = null;
  const auth = /** @type {any} */ ({ api: { getSession: async () => user ? { user: { id: user, role: "user", name: user, email: `${user}@example.test` }, session: { id: `session-${user}`, createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore: withAccounts ? accountStore : undefined, auth, authSecret: secret, provider: null, origin, audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
  /** @param {string} path @param {string} [method] */
  const call = async (path, method = "GET") => {
    const response = await fetch(base + path, { method });
    return { status: response.status, headers: response.headers, text: await response.text(), get data() { return JSON.parse(this.text); } };
  };
  return { call, accountStore, as: (/** @type {string | null} */ value) => { user = value; } };
}

test("bad queries are rejected", async t => {
  const { call } = await fixture(t);
  const cases = ["", "?lat=55.75", "?lon=37.6", "?lat=55.75&lon=37.6&radius=900", "?lat=55.75&lat=55.76&lon=37.6", "?lat=abc&lon=37.6",
    "?lat=55.75&lon=", "?lat=1e1&lon=37.6", "?lat=Infinity&lon=37.6", "?lat=59.93&lon=30.31", "?lat=55.47&lon=37.6", "?lat=55.75&lon=37.96"];
  for (const query of cases) await t.test(query || "(none)", async () => assert.equal((await call(`/api/walks/nearby${query}`)).status, 400));
});

test("other methods answer 405 with Allow", async t => {
  const { call } = await fixture(t);
  const response = await call(NEAR, "POST");
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

test("without the account store the suggestion is unavailable", async t => {
  const { call } = await fixture(t, { withAccounts: false });
  const response = await call(NEAR);
  assert.equal(response.status, 503);
  assert.equal(response.data.error.code, "UNAVAILABLE");
});

test("own walks reach only their signed-in owner and the response is never cached", async t => {
  const { call, accountStore, as } = await fixture(t);
  const walk = accountStore.createWalk("anna", { title: "Моя прогулка", snapshot: routed(), idempotencyKey: "nearby-api-walk" });
  const guest = await call(NEAR);
  assert.equal(guest.status, 200);
  assert.deepEqual(guest.data, { walks: [] });
  assert.match(guest.headers.get("cache-control") ?? "", /no-store/);
  as("anna");
  const owner = await call(NEAR);
  assert.deepEqual(owner.data.walks.map((/** @type {any} */ item) => [item.kind, item.id, item.startDistanceM]), [["own", walk.id, 100]]);
  assert.match(owner.headers.get("cache-control") ?? "", /no-store/);
});
