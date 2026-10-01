import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { sessionCsrfToken } from "./auth.mjs";
import { createReviewRateLimiter } from "./walk-reviews.mjs";

const origin = "https://top.test", secret = "walk-top-api-secret-longer-than-32-chars", CATALOG = "msk-kozhevniki-zindel-short";
const KEY = "g".repeat(43);
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } }, stop = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };
let ids = 0;
const uuid = () => `00000000-0000-4000-8000-${String(++ids).padStart(12, "0")}`;
/** @param {string} title */
const routed = title => ({ version: 2, id: uuid(), title, description: "", city: "Москва", mode: "open", minutes: 30, start,
  stops: [{ id: uuid(), place: stop, storyRef: null, transition: "", nextHint: "" }],
  route: { geometry: [start.location, stop.location], distanceM: 3200, walkingMinutes: 45, attribution: "OSM" }, fieldChecked: false });

/** @param {any} t @param {{ launchLimit?: number, walkLimit?: number }} [options] */
async function fixture(t, { launchLimit = 60, walkLimit = 30 } = {}) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('anna','Анна Автор','anna@example.test'), ('boris','Борис','boris@example.test')`);
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  let clock = 0;
  /** @type {string | null} */
  let user = null;
  const auth = /** @type {any} */ ({ api: { getSession: async () => user ? { user: { id: user, role: "user", name: user, email: `${user}@example.test` }, session: { id: `session-${user}`, createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore, auth, authSecret: secret, provider: null, origin, audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false,
    launchLimiter: createReviewRateLimiter({ limit: launchLimit, now: () => clock }),
    launchWalkLimiter: createReviewRateLimiter({ limit: walkLimit, windowMs: 86_400_000, now: () => clock }) });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
  /** @param {string} path @param {{ method?: string, body?: unknown, headers?: Record<string, string | null> }} [init] */
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const merged = {
      ...(method === "GET" ? {} : { Origin: origin, "Content-Type": "application/json" }),
      ...(user && method !== "GET" ? { "X-CSRF-Token": sessionCsrfToken(secret, `session-${user}`) } : {}),
      ...(!user ? { "X-Review-Key": KEY } : {}),
      ...headers,
    };
    const response = await fetch(base + path, { method, headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)), ...(method === "GET" ? {} : { body: JSON.stringify(body ?? {}) }) });
    return { status: response.status, headers: response.headers, text: await response.text(), get data() { return JSON.parse(this.text); } };
  };
  let key = 0;
  /** @param {string} title @param {"private" | "shared" | "public"} visibility @param {"approve" | "hide" | null} [decision] */
  const walk = (title, visibility, decision = null, owner = "anna") => {
    const created = accountStore.createWalk(owner, { title, snapshot: routed(title), idempotencyKey: `top-walk-${key++}` });
    const result = visibility === "private" ? created : accountStore.setWalkVisibility(owner, created.id, created.revision, visibility);
    if (decision) accountStore.moderateWalkListing(result.id, { action: decision, revision: result.revision });
    return result;
  };
  return { call, db, accountStore, walk, as: (/** @type {string | null} */ value) => { user = value; }, advance: (/** @type {number} */ ms) => { clock += ms; } };
}
const launch = (/** @type {string} */ token) => `/api/story-walks/shared/${token}/launches`;

test("catalog and shared or public walks count launches; other targets are 404", async t => {
  const { call, walk, accountStore } = await fixture(t);
  const shared = walk("Ссылка", "shared"), open = walk("Всем", "public"), closed = walk("Личная", "private");
  assert.deepEqual((await call(`/api/story-walks/${CATALOG}/launches`, { method: "POST" })).data, { counted: true });
  assert.deepEqual((await call(launch(shared.shareToken), { method: "POST" })).data, { counted: true });
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST" })).data, { counted: true });
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST" })).data, { counted: false }, "deduplicated per day");
  const revoked = accountStore.setWalkVisibility("anna", shared.id, shared.revision, "private");
  for (const path of [launch(revoked.shareToken ?? shared.shareToken), launch(closed.id), launch("99999999-9999-4999-8999-999999999999"), "/api/story-walks/unknown-walk/launches"]) {
    const response = await call(path, { method: "POST" });
    assert.equal(response.status, 404, path);
    assert.equal(response.data.error.code, "NOT_FOUND");
  }
  assert.equal(accountStore.launchTotals().get(`account:${open.id}`), 1);
});

test("owners, guests without a key and bad requests are not counted", async t => {
  const { call, walk, as } = await fixture(t);
  const open = walk("Всем", "public");
  as("anna");
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST" })).data, { counted: false }, "owner");
  assert.equal((await call(launch(open.shareToken), { method: "POST", headers: { "X-CSRF-Token": null } })).status, 403, "session without CSRF");
  as("boris");
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST" })).data, { counted: true });
  as(null);
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": null } })).data, { counted: false }, "guest without key");
  assert.equal((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": "short" } })).status, 400);
  assert.equal((await call(launch(open.shareToken), { method: "POST", body: { count: 5 } })).status, 400);
  assert.equal((await call(`${launch(open.shareToken)}?x=1`, { method: "POST" })).status, 400);
  assert.equal((await call(launch(open.shareToken), { method: "POST", headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await call(launch(open.shareToken), { method: "POST", headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
});

test("the per-client limit answers 429 and the per-walk IP cap stops counting quietly", async t => {
  const { call, walk, advance } = await fixture(t, { launchLimit: 3, walkLimit: 2 });
  const open = walk("Всем", "public");
  const keys = ["a", "b", "c", "d"].map(letter => letter.repeat(43));
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": keys[0] } })).data, { counted: true });
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": keys[1] } })).data, { counted: true });
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": keys[2] } })).data, { counted: false }, "key rotation from one IP");
  const limited = await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": keys[3] } });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, "RATE_LIMITED");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  advance(86_400_001);
  assert.deepEqual((await call(launch(open.shareToken), { method: "POST", headers: { "X-Review-Key": keys[3] } })).data, { counted: true });
});

test("the top lists the catalog and approved public walks only, without private data", async t => {
  const { call, walk, as, accountStore } = await fixture(t);
  const approved = walk("Одобренная", "public", "approve");
  walk("На проверке", "public"); walk("Скрытая", "public", "hide"); walk("Ссылка", "shared"); walk("Личная", "private");
  as("boris");
  await call(launch(approved.shareToken), { method: "POST" });
  await call(`/api/story-walks/shared/${approved.shareToken}/reviews/mine`, { method: "PUT", body: { rating: 5 } });
  as(null);
  const response = await call("/api/top-walks");
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const { walks } = response.data;
  assert.deepEqual(walks.map((/** @type {any} */ item) => [item.kind, item.id]).sort(), [["catalog", CATALOG], ["shared", approved.shareToken]].sort());
  const item = walks.find((/** @type {any} */ entry) => entry.kind === "shared");
  assert.deepEqual(item, { kind: "shared", id: approved.shareToken, title: "Одобренная", walkingMinutes: 45, distanceM: 3200, stopCount: 1, rating: { average: 5, count: 1 } });
  assert.equal(walks[0].kind, "shared", "a launched walk ranks above one with no launches");
  for (const secretValue of ["anna", "Анна", "@example.test", approved.id, "launches"]) assert.equal(response.text.includes(secretValue), false, secretValue);
  assert.equal(accountStore.launchTotals().get(`account:${approved.id}`), 1);
  assert.equal((await call("/api/top-walks?limit=5")).status, 400);
});

test("a damaged approved walk gives its place to the next one", async t => {
  const { call, walk, db } = await fixture(t);
  const damaged = walk("Повреждённая", "public", "approve"), next = walk("Следующая", "public", "approve");
  db.prepare("UPDATE user_walks SET snapshot_json='{' WHERE id=?").run(damaged.id);
  const { walks } = (await call("/api/top-walks")).data;
  assert.equal(walks.some((/** @type {any} */ item) => item.title === "Повреждённая"), false);
  assert.ok(walks.some((/** @type {any} */ item) => item.id === next.shareToken));
});

test("owners switch access with visibility or the legacy enabled flag", async t => {
  const { call, walk, as, accountStore } = await fixture(t);
  as("anna");
  const created = walk("Моя", "private");
  const path = `/api/me/walks/${created.id}/sharing`;
  const opened = await call(path, { method: "PUT", body: { revision: created.revision, visibility: "public" } });
  assert.equal(opened.status, 200);
  assert.equal(opened.data.walk.listingStatus, "pending");
  const legacy = await call(path, { method: "PUT", body: { revision: opened.data.walk.revision, enabled: false } });
  assert.equal(legacy.data.walk.visibility, "private");
  assert.equal((await call(path, { method: "PUT", body: { revision: legacy.data.walk.revision, enabled: true } })).data.walk.visibility, "shared");
  for (const body of [{ revision: 0, visibility: "public", enabled: true }, { revision: 0 }, { revision: 0, visibility: "public", extra: 1 }, { revision: 0, enabled: "yes" }])
    assert.equal((await call(path, { method: "PUT", body })).status, 400, JSON.stringify(body));
  const draft = accountStore.createWalk("anna", { title: "Черновик", idempotencyKey: "top-walk-draft", snapshot: { version: 1, title: "Черновик", start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null } });
  const refused = await call(`/api/me/walks/${draft.id}/sharing`, { method: "PUT", body: { revision: draft.revision, visibility: "public" } });
  assert.equal(refused.status, 409);
  assert.deepEqual(refused.data.error, { code: "WALK_NOT_READY", message: "Сначала постройте маршрут — черновик нельзя открыть всем." });
});
