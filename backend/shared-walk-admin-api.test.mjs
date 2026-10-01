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
  const shared = accountStore.setWalkSharing("owner", walk.id, walk.revision, true);
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
