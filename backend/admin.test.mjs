import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { adminAuth, adminDetail } from "./admin.mjs";
import { validateDraft, validateFacts, sha256 } from "./domain.mjs";
import { runJob } from "./pipeline.mjs";

/**
 * @param {import("node:test").TestContext} t
 * @param {{provider?: any, yandexTts?: any, elevenLabsTts?: any, maxActive?: number, adminToken?: string}} [options]
 */
async function fixture(t, { provider = {}, yandexTts = null, elevenLabsTts = null, maxActive = 2, adminToken = "test-secret" } = {}) {
  const store = createStore(":memory:", { maxActive });
  const app = createApp({ store, provider, yandexTts, elevenLabsTts: /** @type {any} */ (elevenLabsTts), adminToken, origin: "https://site.test", workerEnabled: false });
  await /** @type {Promise<void>} */ (new Promise(done => app.server.listen(0, "127.0.0.1", done)));
  t.after(async () => { await app.close(); store.close(); });
  const base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
  const request = (path = "", value, headers = {}) => fetch(base + "/api/story-admin/jobs" + path, {
    method: value === undefined ? "GET" : "POST",
    headers: { Authorization: "Bearer test-secret", Origin: "https://site.test", "Content-Type": "application/json", ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const quote = "A checked source quotation with enough characters.";
  const sources = [1, 2].map(i => ({ id: `s${i}`, url: `https://source${i}.example/history`, publisher: `source${i}.example`, title: "Source", text: quote + " PRIVATE_PAGE", secret: "PRIVATE_SOURCE" }));
  const factReview = { addressConfirmed: true, placeName: "House", resolvedAddress: "Address 1", identityNote: "<script>bad()</script>Identity", facts: Array.from({ length: 5 }, (_, i) => ({ id: `f${i + 1}`, claim: "Checked fact", evidence: [{ sourceId: `s${i % 2 + 1}`, quote }] })) };
  const evidence = validateFacts(factReview, sources);
  const draft = { title: "House", paragraphs: [ { text: "word ".repeat(55).trim(), factIds: ["f1", "f2", "f3"] }, { text: "word ".repeat(55).trim(), factIds: ["f4", "f5"] } ] };
  const seed = (key = "one", data = {}) => {
    const job = store.createOrGet({ key, address: "Address 1" });
    return store.update(job.id, { stage: "review_required", error: { code: "REVIEW_REQUIRED", message: "PRIVATE_ERROR" }, data: {
      sources, evidence, factReview, draft, draftCandidate: { ...draft, secret: "PRIVATE_CANDIDATE" },
      review: { approved: false, issues: ["<img src=x onerror=bad()>Check this", { secret: "PRIVATE_ISSUE" }], secret: "PRIVATE_REVIEW" },
      usage: "PRIVATE_USAGE", ...data,
    } }, job.revision);
  };
  return { store, request, seed, draft, base };
}

test("admin auth fails closed, accepts only bearer credentials, throttles with fixed memory and expires", async t => {
  const f = await fixture(t, { adminToken: "" });
  assert.equal((await f.request()).status, 401);
  let now = 0;
  const auth = adminAuth("secret", () => now);
  assert.equal(auth("Bearer secret"), 200);
  for (let i = 0; i < 20; i++) assert.equal(auth(i % 2 ? "Basic secret" : "Bearer wrong"), 401);
  assert.equal(auth("Bearer wrong"), 429);
  assert.equal(auth("Bearer secret"), 200);
  assert.equal(auth("Bearer wrong"), 429);
  now = 60_000;
  assert.equal(auth("Bearer wrong"), 401);
  assert.equal(auth("Bearer secret"), 200);
});

test("admin routes authenticate before lookup, never cache, and project only safe UI fields", async t => {
  const f = await fixture(t); const job = f.seed();
  for (const path of ["", `/${job.id}`, "/not-a-job"]) {
    const res = await f.request(path, undefined, { Authorization: "Bearer wrong" });
    assert.equal(res.status, 401); assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.text()).includes(job.id), false);
  }
  const res = await f.request(`/${job.id}`); const value = /** @type {any} */ (await res.json());
  assert.deepEqual(Object.keys(value), ["job"]);
  assert.deepEqual(Object.keys(value.job).sort(), ["id", "address", "stage", "revision", "updatedAt", "irrelevant", "ttsProvider", "ttsVoice", "error", "data", "canApprove", "canRegenerate", "canRetry", "canRevoice", "ttsProviders"].sort());
  assert.deepEqual(Object.keys(value.job.data), ["ttsProvider", "ttsVoice", "story", "audio", "revoice", "editorDraft", "draft", "draftCandidate", "evidence", "review", "factReview"]);
  assert.equal(value.job.canApprove, false);
  assert.equal(JSON.stringify(value).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(value).includes("<"), false);
  assert.equal(value.job.data.evidence.sources[0].text, undefined);
  const publicValue = /** @type {any} */ (await (await fetch(`${f.base}/api/story-jobs/${job.id}`)).json());
  assert.equal(publicValue.data, undefined);
  const list = /** @type {any} */ (await (await f.request()).json());
  assert.deepEqual(Object.keys(list), ["jobs", "hasMore"]);
  assert.equal(list.jobs[0].data, undefined);
  assert.equal(list.hasMore, false);
});

test("pagination is deterministic and bounded to 50 with validated offsets", async t => {
  const f = await fixture(t);
  for (let i = 0; i < 51; i++) f.seed(String(i));
  const first = /** @type {any} */ (await (await f.request()).json());
  const last = /** @type {any} */ (await (await f.request("?offset=50")).json());
  assert.equal(first.jobs.length, 50); assert.equal(first.hasMore, true);
  assert.equal(last.jobs.length, 1); assert.equal(last.hasMore, false);
  assert.equal(first.jobs.some(job => job.id === last.jobs[0].id), false);
  for (const query of ["?limit=51", "?limit=0", "?offset=-1", "?offset=1.5", "?offset=9007199254740992", "?limit=1&limit=2", "?secret=1"]) assert.equal((await f.request(query)).status, 400);
});

test("edits validate origin, schema, byte limit and revision, preserving all model checkpoints", async t => {
  const f = await fixture(t); const job = f.seed(); const path = `/${job.id}/edit`;
  const input = { revision: job.revision, draft: f.draft };
  for (const headers of [{ Origin: "https://evil.test" }, { "Sec-Fetch-Site": "cross-site" }]) assert.equal((await f.request(path, input, headers)).status, 403);
  for (const value of [{ ...input, revision: -1 }, { ...input, secret: true }, { ...input, draft: null }, { ...input, draft: { ...f.draft, verification: "editorial" } }, { ...input, draft: { ...f.draft, title: "я".repeat(17000) } }, { ...input, draft: { ...f.draft, paragraphs: [] } }]) assert.equal((await f.request(path, value)).status, 400);
  const results = await Promise.all([f.request(path, input), f.request(path, input)]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = f.store.get(job.id);
  assert.deepEqual(saved.data, { ...job.data, editorDraft: f.draft });
  assert.equal(saved.revision, job.revision + 1);
  assert.equal(/** @type {any} */ (await (await f.request(`/${job.id}`)).json()).job.canApprove, true);
  const moved = f.store.update(job.id, { stage: "failed" }, saved.revision);
  assert.equal((await f.request(path, { ...input, revision: moved.revision })).status, 409);
});

test("editor draft text roundtrips exactly through editing, review and publication", async t => {
  const f = await fixture(t); const job = f.seed();
  const draft = { title: "House <old>\u0001 title", paragraphs: f.draft.paragraphs.map(p => ({
    ...p, text: "Before <arch>\u0007 after " + p.text,
  })) };
  const valid = validateDraft(draft, job.data.evidence);
  assert.deepEqual({ title: valid.title, paragraphs: valid.paragraphs }, draft);
  const response = await f.request(`/${job.id}/edit`, { revision: job.revision, draft });
  assert.equal(response.status, 200);
  const { job: saved } = /** @type {any} */ (await response.json());
  assert.deepEqual(saved.data.editorDraft, draft);
  assert.deepEqual(f.store.get(job.id).data.editorDraft, draft);
  const { job: detail } = /** @type {any} */ (await (await f.request(`/${job.id}`)).json());
  assert.equal(detail.canApprove, true);
  assert.deepEqual(detail.data.editorDraft, draft);
  assert.equal((await f.request(`/${job.id}/approve`, { revision: detail.revision })).status, 200);
  const ready = await runJob(f.store.claimNext(), { store: f.store, provider: {},
    narrate: async story => {
      assert.deepEqual({ title: story.title, paragraphs: story.paragraphs }, draft);
      return { url: "audio", durationSec: 100 };
    },
  });
  assert.equal(ready.stage, "ready");
  const published = /** @type {any} */ (await (await fetch(`${f.base}/api/story-jobs/${job.id}`)).json());
  assert.deepEqual({ title: published.story.title, paragraphs: published.story.paragraphs }, draft);
});

test("provider unavailable permits reads and edits but rejects approval without state changes", async t => {
  const f = await fixture(t, { provider: null }); const job = f.seed();
  const response = await f.request(`/${job.id}/edit`, { revision: job.revision, draft: f.draft });
  assert.equal(response.status, 200); const { job: saved } = /** @type {any} */ (await response.json());
  assert.equal(saved.canApprove, false);
  const before = f.store.get(job.id);
  assert.equal((await f.request(`/${job.id}/approve`, { revision: saved.revision })).status, 503);
  assert.deepEqual(f.store.get(job.id), before);
});

test("approval requires a saved valid draft and revalidated evidence", async t => {
  const f = await fixture(t); const job = f.seed();
  assert.equal((await f.request(`/${job.id}/approve`, { revision: job.revision })).status, 400);
  let saved = f.store.editAdmin(job.id, job.revision, f.draft);
  saved = f.store.update(job.id, { data: { ...saved.data, sources: saved.data.sources.map(s => ({ ...s, text: "no matching quote" })) } }, saved.revision);
  assert.equal(/** @type {any} */ (await (await f.request(`/${job.id}`)).json()).job.canApprove, false);
  assert.equal((await f.request(`/${job.id}/approve`, { revision: saved.revision })).status, 400);
  assert.deepEqual(f.store.get(job.id), saved);
});

test("approval is atomic, audits the draft, and continues with audio only", async t => {
  const f = await fixture(t); const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  const path = `/${saved.id}/approve`;
  const results = await Promise.all([f.request(path, { revision: saved.revision }), f.request(path, { revision: saved.revision })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const response = /** @type {any} */ (await results.find(r => r.status === 200).json());
  assert.equal(response.job.stage, "queued"); assert.equal(response.job.canApprove, false);
  const approved = f.store.get(saved.id);
  assert.deepEqual(approved.data.draft, original.data.draft);
  assert.deepEqual(approved.data.review, original.data.review);
  assert.equal(approved.data.story.verification, "editorial");
  assert.equal(approved.data.ttsProvider, "openai");
  assert.equal(approved.data.editorialApproval.draftHash, sha256(JSON.stringify(saved.data.editorDraft)));
  assert.equal(approved.data.editorialApproval.approvedAt, approved.updatedAt);
  let modelCalls = 0, fetches = 0, voices = 0;
  const ready = await runJob(f.store.claimNext(), { store: f.store,
    provider: { response: async () => { modelCalls++; throw new Error("Must not call model"); } },
    fetchPage: async () => { fetches++; throw new Error("Must not fetch"); },
    narrate: async story => { voices++; assert.equal(story.verification, "editorial"); return { url: "audio", durationSec: 100 }; },
  });
  assert.equal(ready.stage, "ready"); assert.equal(modelCalls, 0); assert.equal(fetches, 0); assert.equal(voices, 1);
});

test("a full queue rolls back approval and its revision", async t => {
  const f = await fixture(t, { maxActive: 1 });
  const job = f.seed(); const saved = f.store.editAdmin(job.id, job.revision, f.draft);
  const blocker = f.store.createOrGet({ key: "blocker", address: "Address 2" });
  const response = await f.request(`/${job.id}/approve`, { revision: saved.revision });
  assert.equal(response.status, 429);
  assert.equal(/** @type {any} */ (await response.json()).error.code, "QUEUE_FULL");
  assert.deepEqual(f.store.get(job.id), saved);
  f.store.update(blocker.id, { stage: "failed" }, blocker.revision);
  assert.equal((await f.request(`/${job.id}/approve`, { revision: saved.revision })).status, 200);
});

test("malformed raw findings stay readable and unsafe source URLs are removed", async t => {
  const f = await fixture(t);
  const job = f.seed({}.toString(), { evidence: { facts: [null, 42, { evidence: [null] }], sources: [null, { url: "javascript:alert(1)" }, { url: "https://user:secret@example.com" }] }, draftCandidate: { paragraphs: [null, false] }, factReview: { facts: [null] }, review: { issues: [null, {}] } });
  const response = await f.request(`/${job.id}`);
  assert.equal(response.status, 200);
  const { job: detail } = /** @type {any} */ (await response.json());
  assert.equal(detail.canApprove, false);
  assert.ok(detail.data.evidence.sources.every(source => source.url === null));
  assert.equal(JSON.stringify(detail).includes("secret"), false);
});

test("HTTP auth throttle covers mutation routes without modifying jobs", async t => {
  const f = await fixture(t); const job = f.seed();
  for (let i = 0; i < 20; i++) {
    assert.equal((await f.request(`/${job.id}/approve`, { revision: job.revision }, { Authorization: "Bearer invalid" })).status, 401);
  }
  assert.equal((await f.request()).status, 200);
  const response = await f.request(`/${job.id}/approve`, { revision: job.revision }, { Authorization: "Bearer invalid" });
  assert.equal(response.status, 429); assert.equal(response.headers.get("retry-after"), "60");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(f.store.get(job.id), job);
});

test("editorial audio failure and retry never call models or alter the approved text", async t => {
  const f = await fixture(t); const job = f.seed();
  const edited = f.store.editAdmin(job.id, job.revision, f.draft);
  const approved = f.store.approveAdmin(job.id, edited.revision);
  let calls = 0;
  const options = { store: f.store, provider: { response: async () => { calls++; throw new Error("Unexpected model call"); } },
    narrate: async () => { throw new Error("Private TTS failure"); } };
  const failed = await runJob(f.store.claimNext(), options);
  assert.equal(failed.stage, "failed"); assert.equal(failed.error.code, "TTS_FAILED");
  assert.deepEqual(failed.data.story, approved.data.story);
  f.store.retry(job.id, failed.revision);
  const ready = await runJob(f.store.claimNext(), { ...options, narrate: async () => ({ url: "audio", durationSec: 100 }) });
  assert.equal(ready.stage, "ready"); assert.equal(calls, 0);
  assert.deepEqual(ready.data.editorialApproval, approved.data.editorialApproval);
  assert.deepEqual(ready.data.story, approved.data.story);
});

test("Yandex selection is persisted, audited and reused after an audio-only retry", async t => {
  const yandexTts = { ttsProvider: "yandex", voice: "marina", privateKey: "PRIVATE_YANDEX_KEY" };
  const f = await fixture(t, { yandexTts });
  const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  const response = await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider: "yandex", ttsVoice: "kirill" });
  assert.equal(response.status, 200);
  const { job } = /** @type {any} */ (await response.json());
  assert.equal(job.data.ttsProvider, "yandex");
  assert.deepEqual(job.ttsProviders.map(({ id, label, available }) => ({ id, label, available })), [{ id: "openai", label: "OpenAI", available: true }, { id: "yandex", label: "Яндекс SpeechKit", available: true }, { id: "elevenlabs", label: "ElevenLabs (с аудиотегами)", available: false }]);
  assert.equal(job.data.ttsVoice, "kirill");
  assert.equal(job.ttsProviders[1].defaultVoice, "marina");
  assert.ok(job.ttsProviders[1].voices.some(voice => voice.id === "kirill"));
  assert.equal(JSON.stringify(job).includes("PRIVATE_"), false);
  const approved = f.store.get(saved.id);
  assert.equal(approved.data.editorialApproval.ttsProvider, "yandex");
  assert.equal(approved.data.editorialApproval.ttsVoice, "kirill");
  const provider = { response: async () => assert.fail("Research must not repeat") };
  const options = { store: f.store, provider, speechProviders: { openai: provider, yandex: yandexTts } };
  const failed = await runJob(f.store.claimNext(), { ...options, narrate: async (_story, selected) => {
    assert.deepEqual(selected, { ...yandexTts, voice: "kirill" }); throw new Error("PRIVATE_FAILURE");
  } });
  assert.equal(failed.stage, "failed");
  assert.equal(failed.error.code, "TTS_FAILED");
  f.store.retry(job.id, failed.revision);
  yandexTts.voice = "dasha"; // A configuration change must not change the approved voice.
  const ready = await runJob(f.store.claimNext(), { ...options, narrate: async (story, selected) => {
    assert.deepEqual(selected, { ...yandexTts, voice: "kirill" }); assert.deepEqual(story, approved.data.story);
    return { url: "yandex-audio", durationSec: 100 };
  } });
  assert.equal(ready.stage, "ready");
  assert.equal(ready.data.audio.url, "yandex-audio");
  assert.deepEqual(ready.data.editorialApproval, approved.data.editorialApproval);
});

test("unavailable and invalid speech selections do not modify the job or consume quota", async t => {
  const f = await fixture(t);
  const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  const detail = /** @type {any} */ (await (await f.request(`/${saved.id}`)).json()).job;
  assert.equal(detail.ttsProviders.find(option => option.id === "yandex").available, false);
  for (const ttsProvider of ["invalid", "__proto__", "constructor", null, {}, 1]) {
    assert.equal((await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider })).status, 400);
  }
  assert.equal((await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider: "yandex" })).status, 503);
  assert.deepEqual(f.store.get(saved.id), saved);
  assert.equal((await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider: "openai" })).status, 200);
});

test("a missing Yandex provider after restart never falls back to OpenAI", async t => {
  const f = await fixture(t);
  const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  f.store.approveAdmin(saved.id, saved.revision, "yandex");
  const failed = await runJob(f.store.claimNext(), { store: f.store, provider: {},
    narrate: async () => assert.fail("Must not substitute another provider"),
  });
  assert.equal(failed.stage, "failed");
  assert.equal(failed.error.code, "TTS_FAILED");
  assert.equal(failed.data.ttsProvider, "yandex");
});

test("approval rejects voices from another service and malformed values without consuming quota", async t => {
  const f = await fixture(t, { yandexTts: { voice: "marina" } });
  const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  for (const ttsProvider of ["openai", "yandex"]) {
    for (const ttsVoice of ["", "unknown", "__proto__", "constructor", null, {}, [], 42, "a".repeat(100), ttsProvider === "openai" ? "marina" : "marin"]) {
      assert.equal((await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider, ttsVoice })).status, 400);
      assert.deepEqual(f.store.get(saved.id), saved);
    }
  }
  assert.equal((await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider: "openai", ttsVoice: "cedar" })).status, 200);
  assert.equal(f.store.get(saved.id).data.ttsVoice, "cedar");
});

test("approval without a voice freezes the configured default including custom server voices", async t => {
  for (const voice of ["ermil", "custom_voice"]) {
    const f = await fixture(t, { yandexTts: { voice } });
    const original = f.seed();
    const saved = f.store.editAdmin(original.id, original.revision, f.draft);
    const detail = /** @type {any} */ (await (await f.request(`/${saved.id}`)).json()).job;
    const options = detail.ttsProviders.find(option => option.id === "yandex");
    assert.equal(options.defaultVoice, voice);
    assert.ok(options.voices.some(option => option.id === voice));
    assert.equal(detail.data.ttsVoice, null);
    const response = await f.request(`/${saved.id}/approve`, { revision: saved.revision, ttsProvider: "yandex" });
    assert.equal(response.status, 200);
    assert.equal(/** @type {any} */ (await response.json()).job.data.ttsVoice, voice);
    assert.equal(f.store.get(saved.id).data.editorialApproval.ttsVoice, voice);
  }
});

test("legacy completed jobs show their recorded audio voice and malformed values remain private", async t => {
  const f = await fixture(t);
  const original = f.seed();
  let job = f.store.update(original.id, { stage: "ready", data: { ...original.data, audio: { voice: "ermil" }, ttsProvider: "yandex" } }, original.revision);
  assert.equal(/** @type {any} */ (await (await f.request(`/${job.id}`)).json()).job.data.ttsVoice, "ermil");
  job = f.store.update(job.id, { data: { ...job.data, ttsVoice: { secret: "PRIVATE_VALUE" }, audio: { voice: "<script>bad()</script>" } } }, job.revision);
  const detail = /** @type {any} */ (await (await f.request(`/${job.id}`)).json()).job;
  assert.equal(detail.data.ttsVoice, null);
  assert.equal(JSON.stringify(detail).includes("PRIVATE_VALUE"), false);
});

test("store list filters are composable, case-insensitive for Russian and validate inputs", t => {
  const store = createStore(":memory:", { maxActive: 20 });
  t.after(() => store.close());
  const pushkin = store.createOrGet({ key: "pushkin", address: "Москва, улица Пушкина, 10" });
  const pushkinReady = store.update(pushkin.id, { stage: "ready" }, pushkin.revision);
  const other = store.createOrGet({ key: "other", address: "Москва, Тверская улица, 2" });
  store.update(other.id, { stage: "ready" }, other.revision);
  const hidden = store.createOrGet({ key: "hidden", address: "Москва, УЛИЦА ПУШКИНА, 12" });
  store.setRelevanceAdmin(hidden.id, hidden.revision, true);

  assert.deepEqual(store.listAdmin({ q: "пУшКиНа", stage: "ready" }).jobs.map(job => job.id), [pushkinReady.id]);
  assert.deepEqual(store.listAdmin({ q: "улица пушкина", relevance: "irrelevant" }).jobs.map(job => job.id), [hidden.id]);
  assert.equal(store.listAdmin({ relevance: "all", limit: 2 }).hasMore, true);
  for (const options of /** @type {any[]} */ ([{ q: 1 }, { q: "x".repeat(201) }, { stage: "unknown" }, { relevance: "hidden" }])) {
    assert.throws(() => store.listAdmin(options), { code: "BAD_REQUEST" });
  }
});

test("revoice queues only the existing story, preserves published audio and occupies a queue slot", t => {
  let clock = Date.parse("2026-09-08T10:00:00.000Z");
  const store = createStore(":memory:", { now: () => clock, maxActive: 1 });
  t.after(() => store.close());
  let job = store.createOrGet({ key: "ready", address: "Address 1" });
  const story = { title: "House", paragraphs: [
    { text: "word ".repeat(55).trim(), factIds: ["f1"] },
    { text: "word ".repeat(55).trim(), factIds: ["f2"] },
  ], verification: "automatic" };
  const audio = { url: `/api/story-audio/${"a".repeat(64)}.mp3`, durationSec: 90, voice: "alloy" };
  job = store.update(job.id, { stage: "ready", data: { story, audio, privateCheckpoint: "kept" } }, job.revision);
  const staleRevision = job.revision - 1;
  assert.throws(() => store.revoiceAdmin(job.id, staleRevision, "yandex", "marina"), { code: "CONFLICT" });
  assert.deepEqual(store.get(job.id), job);

  clock += 1000;
  const queued = store.revoiceAdmin(job.id, job.revision, "yandex", "marina");
  assert.equal(queued.stage, "queued");
  assert.equal(queued.revision, job.revision + 1);
  assert.equal(queued.error, null);
  assert.deepEqual(queued.data.story, story);
  assert.equal(queued.data.audio, null);
  assert.deepEqual(queued.data.revoice, { requestedAt: queued.updatedAt, previousAudio: audio });
  assert.equal(queued.data.ttsProvider, "yandex");
  assert.equal(queued.data.ttsVoice, "marina");
  assert.equal(queued.data.privateCheckpoint, "kept");
  assert.throws(() => store.createOrGet({ key: "queued-behind", address: "Address 2" }), { code: "QUEUE_FULL" });
});

test("revoice and selected retry failures roll back state and reject invalid jobs", t => {
  const store = createStore(":memory:", { maxActive: 1 });
  t.after(() => store.close());
  const created = store.createOrGet({ key: "failed", address: "Address 1" });
  let failed = store.update(created.id, { stage: "failed", attempts: 1, data: { story: null, checkpoint: "kept" } }, created.revision);
  assert.throws(() => store.revoiceAdmin(failed.id, failed.revision, "openai", "alloy"), { code: "BAD_REQUEST" });
  failed = store.update(failed.id, { data: { ...failed.data, story: { title: "House", paragraphs: [
    { text: "word ".repeat(55).trim() }, { text: "word ".repeat(55).trim() },
  ] } } }, failed.revision);
  const blocker = store.createOrGet({ key: "blocker", address: "Address 2" });
  assert.throws(() => store.revoiceAdmin(failed.id, failed.revision, "openai", "alloy"), { code: "QUEUE_FULL" });
  assert.throws(() => store.retryAdmin(failed.id, failed.revision, "yandex", "kirill"), { code: "QUEUE_FULL" });
  assert.equal(store.get(blocker.id).stage, "queued");
  assert.deepEqual(store.get(failed.id), failed);
});

test("selected admin retry persists speech choice and detail exposes safe retry and revoice state", t => {
  const store = createStore(":memory:", { maxActive: 2 });
  t.after(() => store.close());
  let job = store.createOrGet({ key: "failed", address: "Address 1" });
  job = store.update(job.id, { stage: "failed", attempts: 1, data: { story: null, checkpoint: "kept" } }, job.revision);
  const failedDetail = adminDetail(job, true, error => error, []);
  assert.equal(failedDetail.canRetry, true);
  assert.equal(failedDetail.canRevoice, false);
  const queued = store.retryAdmin(job.id, job.revision, "yandex", "kirill");
  assert.equal(queued.stage, "queued");
  assert.equal(queued.data.ttsProvider, "yandex");
  assert.equal(queued.data.ttsVoice, "kirill");
  assert.equal(queued.data.checkpoint, "kept");
  assert.throws(() => store.retryAdmin(job.id, job.revision, "yandex", "kirill"), { code: "CONFLICT" });

  let ready = store.createOrGet({ key: "ready", address: "Address 2" });
  const story = { title: "House", paragraphs: [
    { text: "word ".repeat(55).trim(), factIds: ["f1"] },
    { text: "word ".repeat(55).trim(), factIds: ["f2"] },
  ] };
  const audio = { url: `/api/story-audio/${"b".repeat(64)}.mp3`, durationSec: 91, voice: "cedar", secret: "PRIVATE_AUDIO" };
  ready = store.update(ready.id, { stage: "ready", data: { story, audio } }, ready.revision);
  const detail = adminDetail(ready, true, error => error, []);
  assert.equal(detail.canRevoice, true);
  assert.equal(detail.canRetry, false);
  assert.deepEqual(detail.data.story, story);
  assert.deepEqual(detail.data.audio, { url: audio.url, durationSec: 91, voice: "cedar", provider: "openai", model: "" });
  assert.equal(detail.ttsVoice, "cedar");
  assert.equal(JSON.stringify(detail).includes("PRIVATE_AUDIO"), false);
});

test("address admin mutations cannot operate on queued walk chapters", t => {
  const store = createStore(":memory:", { maxActive: 2 });
  t.after(() => store.close());
  const walk = store.getWalkAdmin(store.listWalksAdmin().walks[0].id);
  const chapter = walk.chapters[0];
  const job = store.revoiceWalkChapterAdmin(walk.id, chapter.id, chapter.revision, "openai", "alloy");
  const calls = [
    () => store.setRelevanceAdmin(job.id, job.revision, true),
    () => store.editAdmin(job.id, job.revision, {}),
    () => store.approveAdmin(job.id, job.revision),
    () => store.revoiceAdmin(job.id, job.revision),
    () => store.retryAdmin(job.id, job.revision),
    () => store.retry(job.id, job.revision),
  ];
  for (const call of calls) assert.throws(call, { code: "CONFLICT" });
  assert.deepEqual(store.listAdmin({ relevance: "all" }).jobs, []);
});

test("ElevenLabs revoicing offers the account voices and narrates with the selected one", async t => {
  const elevenLabsTts = { ttsProvider: "elevenlabs", voice: "RuVoice1", voices: [{ id: "RuVoice1", label: "Отголосок (ru)" }, { id: "EnVoice1", label: "George (en)" }] };
  const f = await fixture(t, { elevenLabsTts });
  const original = f.seed();
  const saved = f.store.editAdmin(original.id, original.revision, f.draft);
  const approved = f.store.approveAdmin(saved.id, saved.revision);
  const ready = await runJob(f.store.claimNext(), { store: f.store, provider: {}, narrate: async () => ({ url: "openai-audio", durationSec: 100, provider: "openai" }) });
  const detail = /** @type {any} */ (await (await f.request(`/${approved.id}`)).json()).job;
  assert.deepEqual(detail.ttsProviders.find(option => option.id === "elevenlabs"), { id: "elevenlabs", label: "ElevenLabs (с аудиотегами)", available: true,
    defaultVoice: "RuVoice1", voices: elevenLabsTts.voices });
  assert.equal((await f.request(`/${ready.id}/revoice`, { revision: ready.revision, ttsProvider: "elevenlabs", ttsVoice: "marin" })).status, 400);
  const response = await f.request(`/${ready.id}/revoice`, { revision: ready.revision, ttsProvider: "elevenlabs", ttsVoice: "EnVoice1" });
  assert.equal(response.status, 200);
  const revoiced = await runJob(f.store.claimNext(), { store: f.store, provider: {}, speechProviders: { elevenlabs: elevenLabsTts },
    narrate: async (story, selected) => {
      assert.deepEqual(selected, { ...elevenLabsTts, voice: "EnVoice1" }); assert.deepEqual(story, approved.data.story);
      return { url: "elevenlabs-audio", durationSec: 100, provider: "elevenlabs", voice: "EnVoice1" };
    } });
  assert.equal(revoiced.stage, "ready");
  assert.equal(revoiced.data.audio.url, "elevenlabs-audio");
  const summary = /** @type {any} */ (await (await f.request(`/${ready.id}`)).json()).job;
  assert.equal(summary.data.ttsProvider, "elevenlabs");
});
