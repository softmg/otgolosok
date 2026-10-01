import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";

test("shared walk admin endpoint enforces editor access and validates query parameters", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('owner','Анна','anna@example.test')");
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  let role = null;
  const auth = /** @type {any} */ ({ api: { getSession: async () => role ? { user: { id: "owner", role }, session: { id: "session", createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore, auth, provider: null, origin: "http://localhost", audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (app.server.address()).port}`;
  const walk = accountStore.createWalk("owner", { title: "Арбат", idempotencyKey: "api-walk-0001", snapshot: { version: 1, title: "Арбат", start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null } });
  const shared = accountStore.setWalkVisibility("owner", walk.id, walk.revision, "shared");
  const path = "/api/story-admin/walks/shared";
  for (const value of [null, "user"]) {
    role = value;
    const response = await fetch(base + path);
    assert.equal(response.status, 401);
    assert.equal((await response.text()).includes("anna@example.test"), false);
  }
  role = "editor";
  const response = await fetch(base + path + "?q=" + encodeURIComponent("АРБАТ"));
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  const page = /** @type {any} */ (await response.json());
  assert.equal(page.total, 1); assert.equal(page.walks[0].shareToken, shared.shareToken);
  assert.equal(page.walks[0].author.name, "Анна");
  for (const query of ["limit=0", "limit=51", "offset=-1", "offset=1.5", "offset=9007199254740992", "q=a&q=b", "author=a&author=b", "mode=bad", "unknown=x", "q=" + "x".repeat(121)]) {
    assert.equal((await fetch(`${base}${path}?${query}`)).status, 400, query);
  }
  role = null;
  const publicResponse = await fetch(`${base}/api/story-walks/shared/${shared.shareToken}`);
  assert.equal(publicResponse.status, 200);
  const publicView = await publicResponse.text();
  assert.equal(publicView.includes("anna@example.test"), false);
});

test("editors approve and hide public walks through the listing endpoint", async t => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('owner','Анна','anna@example.test')");
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  const secret = "listing-api-secret-longer-than-32-chars";
  let role = "editor";
  const auth = /** @type {any} */ ({ api: { getSession: async () => role ? { user: { id: "owner", role }, session: { id: "session", createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore, auth, authSecret: secret, provider: null, origin: "http://localhost", audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (app.server.address()).port}`;
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stop = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };
  const snapshot = { version: 2, id: "11111111-1111-4111-8111-111111111111", title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30, start,
    stops: [{ id: "22222222-2222-4222-8222-222222222222", place: stop, storyRef: null, transition: "", nextHint: "" }],
    route: { geometry: [start.location, stop.location], distanceM: 200, walkingMinutes: 3, attribution: "OSM" }, fieldChecked: false };
  const created = accountStore.createWalk("owner", { title: "Арбат", idempotencyKey: "listing-api-1", snapshot });
  const walk = accountStore.setWalkVisibility("owner", created.id, created.revision, "public");
  const { sessionCsrfToken } = await import("./auth.mjs");
  /** @param {unknown} body @param {Record<string, string>} [headers] */
  const moderate = (body, headers = { "X-CSRF-Token": sessionCsrfToken(secret, "session") }, id = walk.id) =>
    fetch(`${base}/api/story-admin/walks/shared/${id}/listing`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost", ...headers }, body: JSON.stringify(body) });

  const list = /** @type {any} */ (await (await fetch(`${base}/api/story-admin/walks/shared?access=public&listing=pending`)).json());
  assert.equal(list.total, 1); assert.equal(list.pending, 1); assert.equal(list.walks[0].revision, walk.revision);
  for (const query of ["access=all&access=public", "listing=bad", "access=bad"]) assert.equal((await fetch(`${base}/api/story-admin/walks/shared?${query}`)).status, 400, query);

  assert.equal((await moderate({ action: "approve", revision: walk.revision }, {})).status, 403, "CSRF is required");
  assert.equal((await moderate({ action: "approve", revision: walk.revision, extra: 1 })).status, 400);
  assert.equal((await moderate({ action: "approve" })).status, 400);
  const stale = await moderate({ action: "approve", revision: walk.revision + 1 });
  assert.equal(stale.status, 409);
  assert.equal(/** @type {any} */ (await stale.json()).error.message, "Прогулка изменилась — обновите список.");
  assert.equal((await moderate({ action: "hide", revision: 0 }, undefined, "33333333-3333-4333-8333-333333333333")).status, 404);
  const approved = await moderate({ action: "approve", revision: walk.revision });
  assert.equal(approved.status, 200);
  assert.equal(/** @type {any} */ (await approved.json()).walk.listingStatus, "approved");
  assert.equal((await fetch(`${base}/api/story-admin/walks/shared/${walk.id}/listing`)).status, 405);
  role = "user";
  assert.equal((await moderate({ action: "hide", revision: walk.revision })).status, 401);
});
