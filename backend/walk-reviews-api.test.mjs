import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createAccountStore } from "./account-store.mjs";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { sessionCsrfToken } from "./auth.mjs";
import { createReviewRateLimiter } from "./walk-reviews.mjs";

const origin = "https://reviews.test", secret = "walk-reviews-api-secret-longer-than-32", CATALOG = "msk-kozhevniki-zindel-short";
const GUEST_KEY = "g".repeat(43);
const snapshot = { version: 1, title: "Моя", start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null };

async function fixture(t) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT);
    INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','Борис','boris@example.test')`);
  const accountStore = createAccountStore(db), store = createStore(":memory:");
  let clock = 0;
  /** @type {{ id: string, role: string } | null} */
  let user = null;
  const auth = /** @type {any} */ ({ api: { getSession: async () => user ? { user: { ...user, name: user.id, email: `${user.id}@example.test` }, session: { id: `session-${user.id}`, createdAt: new Date() } } : null } });
  const app = createApp({ store, accountStore, auth, authSecret: secret, provider: null, origin, audioDirectory: "/tmp", workerEnabled: false, allowLegacyAdminToken: false,
    reviewLimiter: createReviewRateLimiter({ now: () => clock }) });
  await new Promise(resolve => app.server.listen(0, "127.0.0.1", () => resolve(null)));
  t.after(async () => { await app.close(); store.close(); db.close(); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
  const as = value => { user = value ? { id: value, role: value === "editor" ? "editor" : "user" } : null; };
  /** @param {string} path @param {{ method?: string, body?: unknown, headers?: Record<string, string | null> }} [init] */
  const call = async (path, { method = "GET", body, headers = {} } = {}) => {
    const merged = {
      ...(method === "GET" ? {} : { Origin: origin, "Content-Type": "application/json" }),
      ...(user && method !== "GET" ? { "X-CSRF-Token": sessionCsrfToken(secret, `session-${user.id}`) } : {}),
      ...(!user ? { "X-Review-Key": GUEST_KEY } : {}),
      ...headers,
    };
    const response = await fetch(base + path, { method, headers: Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== null)), ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, headers: response.headers, text: await response.text(), get data() { return JSON.parse(this.text); } };
  };
  const walk = accountStore.createWalk("anna", { title: "Аннина прогулка", idempotencyKey: "review-api-walk", snapshot });
  const shared = accountStore.setWalkVisibility("anna", walk.id, walk.revision, "shared");
  db.exec("INSERT INTO user VALUES ('editor','Редактор','editor@example.test')");
  return { call, as, accountStore, walk: shared, advance: ms => { clock += ms; } };
}

test("guest writes require same origin and a well-formed device key", async t => {
  const { call } = await fixture(t);
  const path = `/api/story-walks/${CATALOG}/reviews/mine`, body = { rating: 5 };
  assert.equal((await call(path, { method: "PUT", body, headers: { Origin: "https://evil.test" } })).status, 403);
  assert.equal((await call(path, { method: "PUT", body, headers: { "Sec-Fetch-Site": "cross-site" } })).status, 403);
  assert.equal((await call(path, { method: "PUT", body, headers: { "X-Review-Key": "short" } })).status, 400);
  assert.equal((await call(`/api/story-walks/${CATALOG}/reviews?cursor=a&cursor=b`)).status, 400);
  assert.equal((await call(`/api/story-walks/${CATALOG}/reviews?page=2`)).status, 400);
  const missingKey = await call(path, { method: "PUT", body, headers: { "X-Review-Key": null } });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.data.error.code, "REVIEW_KEY_REQUIRED");
  const anonymousRead = await call(`/api/story-walks/${CATALOG}/reviews`, { headers: { "X-Review-Key": null } });
  assert.equal(anonymousRead.status, 200); assert.equal(anonymousRead.data.mine, null);
  const saved = await call(path, { method: "PUT", body: { rating: 5, text: "" } });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.data.summary, { average: 5, count: 1 });
  assert.equal(saved.data.mine.status, "published");
  assert.equal((await call(path, { method: "PUT", body: { rating: 5, extra: 1 } })).status, 400);
  assert.equal((await call(path, { method: "PUT", body: { text: "только текст" } })).status, 400);
  const wrongMethod = await call(path, { method: "POST", body });
  assert.equal(wrongMethod.status, 405); assert.equal(wrongMethod.headers.get("allow"), "PUT, DELETE");
});

test("signed-in writes need CSRF; review authors are public by name only", async t => {
  const { call, as } = await fixture(t);
  as("anna");
  const path = `/api/story-walks/${CATALOG}/reviews`;
  assert.equal((await call(path + "/mine", { method: "PUT", body: { rating: 4 }, headers: { "X-CSRF-Token": "forged" } })).status, 403);
  const pending = await call(path + "/mine", { method: "PUT", body: { rating: 4, text: "Отличная прогулка" } });
  assert.equal(pending.data.mine.status, "pending");
  const own = await call(path);
  assert.equal(own.data.mine.text, "Отличная прогулка");
  assert.deepEqual(own.data.reviews, []);
  assert.deepEqual(own.data.summary, { average: null, count: 0 });
  as("editor");
  const queue = await call("/api/story-admin/reviews");
  assert.equal(queue.data.pending, 1);
  assert.equal(queue.data.reviews[0].walk.url, `/walk?catalog=${CATALOG}`);
  assert.equal(queue.data.reviews[0].author.email, "anna@example.test");
  const id = queue.data.reviews[0].id;
  const published = await call(`/api/story-admin/reviews/${id}/moderate`, { method: "POST", body: { action: "publish" } });
  assert.equal(published.data.review.status, "published");
  as(null);
  const visible = await call(path);
  assert.equal(visible.data.reviews[0].author, "Анна");
  assert.equal(visible.data.reviews[0].text, "Отличная прогулка");
  assert.equal(visible.text.includes("anna@example.test"), false);
  assert.equal(visible.data.mine, null);
  as("editor");
  await call(`/api/story-admin/reviews/${id}/moderate`, { method: "POST", body: { action: "hide" } });
  as(null);
  assert.deepEqual((await call(path)).data.summary, { average: null, count: 0 });
  as("editor");
  assert.equal((await call(`/api/story-admin/reviews/${id}/delete`, { method: "POST", body: {} })).status, 200);
  assert.equal((await call(`/api/story-admin/reviews/${id}/delete`, { method: "POST", body: {} })).status, 404);
});

test("unknown, revoked and foreign walks all answer the same 404", async t => {
  const { call, as, accountStore, walk } = await fixture(t);
  const shared = `/api/story-walks/shared/${walk.shareToken}/reviews`;
  assert.equal((await call(shared + "/mine", { method: "PUT", body: { rating: 3 } })).status, 200);
  as("boris");
  const responses = [
    await call("/api/story-walks/no-such-walk/reviews"),
    await call(`/api/story-walks/shared/${crypto.randomUUID()}/reviews`),
    await call(`/api/me/walks/${walk.id}/reviews`),
  ];
  accountStore.setWalkVisibility("anna", walk.id, walk.revision, "private");
  responses.push(await call(shared));
  for (const response of responses) {
    assert.equal(response.status, 404);
    assert.deepEqual(response.data, { error: { code: "NOT_FOUND", message: "Прогулка не найдена." } });
  }
  as("anna");
  const own = await call(`/api/me/walks/${walk.id}/reviews`);
  assert.equal(own.status, 200);
  assert.deepEqual(own.data.summary, { average: 3, count: 1 });
  const mine = await call(`/api/me/walks/${walk.id}/reviews/mine`, { method: "PUT", body: { rating: 5 } });
  assert.deepEqual(mine.data.summary, { average: 4, count: 2 });
  as("editor");
  const listed = await call("/api/story-admin/reviews?status=all");
  assert.equal(listed.data.reviews.every(review => review.walk.url === null), true, "a revoked walk has no public link");
});

test("review writes are limited to 20 per hour per client", async t => {
  const { call, advance } = await fixture(t);
  const path = `/api/story-walks/${CATALOG}/reviews/mine`;
  for (let index = 0; index < 20; index++) {
    const response = await call(path, { method: index % 2 ? "DELETE" : "PUT", body: index % 2 ? undefined : { rating: 4 } });
    assert.equal(response.status, 200, `write ${index}`);
  }
  const limited = await call(path, { method: "PUT", body: { rating: 1 } });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, "RATE_LIMITED");
  assert.equal(limited.headers.get("retry-after"), "3600");
  advance(3_600_001);
  assert.equal((await call(path, { method: "PUT", body: { rating: 1 } })).status, 200);
});

test("admin review endpoints reject non-editors and malformed filters", async t => {
  const { call, as } = await fixture(t);
  for (const role of [null, "anna"]) {
    as(role);
    assert.equal((await call("/api/story-admin/reviews")).status, 401);
  }
  as("editor");
  for (const query of ["status=bad", "rating=0", "rating=6", "rating=x", "limit=51", "offset=-1", "q=a&q=b", "unknown=1", "q=" + "x".repeat(121)]) {
    assert.equal((await call(`/api/story-admin/reviews?${query}`)).status, 400, query);
  }
  assert.equal((await call(`/api/story-admin/reviews/${crypto.randomUUID()}/moderate`, { method: "POST", body: { action: "approve" } })).status, 400);
  assert.equal((await call(`/api/story-admin/reviews/${crypto.randomUUID()}/moderate`, { method: "POST", body: { action: "publish" } })).status, 404);
});
