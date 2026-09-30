import test from "node:test";
import assert from "node:assert/strict";
import { fetchWithRetry, isTransientError, retryAfterMs, withRetry } from "./retry.mjs";

const recorder = () => { const waits = []; return { waits, wait: async milliseconds => { waits.push(milliseconds); } }; };
const reply = (status, headers = {}) => new Response(status === 200 ? "ok" : "busy", { status, headers });

test("a transient response is retried and the success returned", async () => {
  const statuses = [503, 200], timer = recorder();
  const response = await fetchWithRetry(async () => reply(statuses.shift()), "https://api.test", {}, { ...timer, random: () => 0.5 });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
  assert.deepEqual(timer.waits, [250]);
});

test("Retry-After is honoured and capped", async t => {
  // HTTP dates have whole-second precision; elapsed wall time must not make this test flaky.
  t.mock.method(Date, "now", () => Date.parse("2026-09-28T10:00:00.125Z"));
  for (const [header, expected] of /** @type {Array<[string, number]>} */ ([["2", 2000], ["60", 8000], ["Mon, 28 Sep 2026 10:00:03 GMT", 2875], ["Mon, 28 Sep 2026 10:01:00 GMT", 8000]])) {
    const statuses = [429, 200], timer = recorder();
    await fetchWithRetry(async () => reply(statuses.shift(), { "Retry-After": header }), "https://api.test", {}, timer);
    assert.deepEqual(timer.waits, [expected], header);
  }
});

test("deterministic client errors are returned without a retry", async () => {
  for (const status of [400, 401, 403, 404, 422]) {
    let calls = 0;
    const response = await fetchWithRetry(async () => { calls++; return reply(status); }, "https://api.test", {}, recorder());
    assert.equal(response.status, status);
    assert.equal(calls, 1);
  }
});

test("attempts are bounded and the last transient response is handed back", async () => {
  let calls = 0; const timer = recorder();
  const response = await fetchWithRetry(async () => { calls++; return reply(502); }, "https://api.test", {}, { attempts: 3, ...timer, random: () => 1 });
  assert.equal(response.status, 502);
  assert.equal(calls, 3);
  assert.deepEqual(timer.waits, [500, 1000]);
  await assert.rejects(withRetry(async () => { throw new TypeError("fetch failed"); }, { attempts: 2, wait: async () => {} }), TypeError);
});

test("aborting the caller's signal cancels a pending backoff at once", async () => {
  const controller = new AbortController(), started = Date.now();
  const pending = withRetry(async () => { throw Object.assign(new Error("busy"), { status: 503 }); }, { signal: controller.signal, baseMs: 60000, maxMs: 60000, random: () => 1 });
  setTimeout(() => controller.abort(new Error("stopped")), 20);
  await assert.rejects(pending, /stopped/);
  assert.ok(Date.now() - started < 5000);
});

test("transient errors are network failures and retryable statuses only", () => {
  const cases = /** @type {Array<[any, boolean]>} */ ([
    [new TypeError("fetch failed"), true],
    [Object.assign(new Error("reset"), { code: "ECONNRESET" }), true],
    [Object.assign(new Error("undici"), { cause: { code: "UND_ERR_SOCKET" } }), true],
    [Object.assign(new Error("status"), { status: 408 }), true],
    [Object.assign(new Error("status"), { status: 429 }), true],
    [Object.assign(new Error("status"), { status: 503 }), true],
    [Object.assign(new Error("status"), { status: 501 }), false],
    [Object.assign(new Error("status"), { status: 400 }), false],
    [new DOMException("deadline", "TimeoutError"), false],
    [new DOMException("stopped", "AbortError"), false],
    [new TypeError("x is not a function"), false],
    [null, false],
  ]);
  for (const [error, expected] of cases) assert.equal(isTransientError(error), expected, String(error?.message ?? error));
});

test("Retry-After accepts seconds and HTTP dates", () => {
  const now = Date.parse("2026-09-28T10:00:00Z");
  for (const [value, expected] of [["0", 0], ["1.5", 1500], ["Mon, 28 Sep 2026 10:00:05 GMT", 5000], ["Mon, 28 Sep 2026 09:00:00 GMT", 0], ["soon", null], ["", null], [null, null]]) {
    assert.equal(retryAfterMs(value, now), expected, String(value));
  }
});
