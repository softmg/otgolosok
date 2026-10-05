import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { ELEVENLABS_PROFILE_ID, elevenLabsProfile, startSpeechAudioWorker } from "./speech-audio-worker.mjs";

const paragraph = ("Проверенный рассказ о московском парке, его истории, архитектуре и людях. ").repeat(9).trim();
const story = { title: "Парк", paragraphs: [{ text: paragraph, factIds: ["f1"] }, { text: paragraph, factIds: ["f2"] }] };
const artifact = { url: `/api/story-audio/${"e".repeat(64)}.mp3`, sha256: "e".repeat(64), bytes: 100, durationSec: 120, model: "eleven_v4", voice: "RuVoice1", provider: "elevenlabs", synthetic: true };

async function queuedPlace(t, model = "eleven_v4", path = ":memory:", options = {}) {
  const store = createStore(path, { ...options, externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile("RuVoice1", model) },
    normalizeExternalText: Object.assign(async text => text.replace("1930", "тысяча девятьсот тридцатом"), { version: "test" }) });
  t.after(() => { try { store.close(); } catch { /* Closed by the test. */ } });
  store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), rulesVersion: "v1", coverage: "fixture",
    places: [{ placeId: "osm:node:7", osmType: "node", osmId: 7, name: "Парк", location: { lat: 55.75, lon: 37.61 }, tags: { leisure: "park" } }] });
  store.createBatch({ requestKey: "speech-worker-1", placeIds: ["osm:node:7"], limit: 1, mode: "text-only" });
  const job = store.claimContentJob();
  store.completeContentJob(job.id, { story, evidence: { facts: [] } });
  const place = store.approvePlaceText("osm:node:7", story);
  const audioJob = await store.enqueueExternalAudio({ sourceJobId: `place-text:${place.text.id}`, sourceRevision: 0,
    story: { ...story, address: "Парк" }, profileId: ELEVENLABS_PROFILE_ID });
  return { store, audioJob };
}

const until = async (check) => { for (let index = 0; index < 200; index++) { const value = check(); if (value) return value; await new Promise(done => setTimeout(done, 5)); } assert.fail("timed out"); };

test("catalog audio queued for ElevenLabs is voiced with the profile voice and attached to the place", async t => {
  const { store } = await queuedPlace(t);
  const calls = [];
  const worker = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "OtherVoice" },
    narrate: async (value, provider, directory, signal, options) => { calls.push({ value, provider, options, normalized: await options.normalize("Дом 1930") }); return artifact; } });
  t.after(() => worker.stop());
  const audio = await until(() => store.getPlace("osm:node:7").text.audio);
  assert.equal(audio.sha256, artifact.sha256);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].provider.voice, "RuVoice1");
  assert.equal(calls[0].options.maxDurationSec, 300);
  assert.equal(calls[0].options.cacheNamespace, undefined);
  // The queue already normalized the text: the worker passes it through unchanged.
  assert.equal(calls[0].normalized, "Дом 1930");
  assert.equal(calls[0].value.paragraphs[0].text, `${paragraph}\n\n${paragraph}`);
});

test("a failed synthesis returns the job to the queue with its error code and no audio", async t => {
  const { store, audioJob } = await queuedPlace(t);
  const worker = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1" },
    narrate: async () => { throw Object.assign(new Error("quota"), { code: "TTS_QUOTA_EXCEEDED" }); } });
  t.after(() => worker.stop());
  const failed = await until(() => { const value = store.getExternalAudio(audioJob.id); return value.state === "retry_wait" ? value : null; });
  assert.equal(failed.error.code, "TTS_QUOTA_EXCEEDED");
  assert.equal(store.getPlace("osm:node:7").text.audio ?? null, null);
});

test("the dispatcher ignores jobs of other profiles", async t => {
  const { store, audioJob } = await queuedPlace(t);
  const worker = startSpeechAudioWorker({ store, profileId: "other-profile", audioDirectory: "unused", pollMs: 5,
    speechProvider: { voice: "RuVoice1" }, narrate: async () => assert.fail("must not claim") });
  await new Promise(done => setTimeout(done, 30));
  await worker.stop();
  assert.equal(store.getExternalAudio(audioJob.id).state, "queued");
});

test("published ElevenLabs audio survives model upgrades and database restarts without new synthesis", async t => {
  const directory = await mkdtemp(join(tmpdir(), "speech-model-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { store, audioJob } = await queuedPlace(t, "eleven_v3", join(directory, "jobs.sqlite"));
  const worker = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1" }, narrate: async () => ({ ...artifact, model: "eleven_v3" }) });
  await until(() => store.getExternalAudio(audioJob.id).state === "succeeded");
  await worker.stop();
  const textId = store.getPlace("osm:node:7").text.id;
  const enqueue = target => target.enqueueExternalAudio({ sourceJobId: `place-text:${textId}`, sourceRevision: 0,
    story: { ...story, address: "Парк" }, profileId: ELEVENLABS_PROFILE_ID });
  assert.equal((await enqueue(store)).id, audioJob.id);
  store.close();
  // The same database after the backend switched to Eleven v4.
  const upgraded = createStore(join(directory, "jobs.sqlite"), { externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile("RuVoice1", "eleven_v4") },
    normalizeExternalText: Object.assign(async text => text.replace("1930", "тысяча девятьсот тридцатом"), { version: "test" }) });
  t.after(() => { try { upgraded.close(); } catch { /* Closed before second restart. */ } });
  const revoiced = await enqueue(upgraded);
  assert.equal(revoiced.id, audioJob.id);
  assert.equal(revoiced.state, "succeeded");
  assert.equal(upgraded.listExternalAudio({ states: ["queued", "retry_wait", "leased", "failed", "cancelled", "succeeded"] }).length, 1);
  // An ordinary model switch preserves the successful publication.
  assert.equal(upgraded.getPlace("osm:node:7").text.audio.model, "eleven_v3");
  upgraded.close();
  const turbo = createStore(join(directory, "jobs.sqlite"), { externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile("RuVoice1", "eleven_v4_turbo") },
    normalizeExternalText: Object.assign(async text => text, { version: "test" }) });
  t.after(() => turbo.close());
  assert.equal((await enqueue(turbo)).id, audioJob.id);
  assert.equal(turbo.listExternalAudio({ states: ["queued", "retry_wait", "leased", "failed", "cancelled", "succeeded"] }).length, 1);
  let calls = 0;
  const idle = startSpeechAudioWorker({ store: turbo, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1" }, narrate: async () => { calls++; return artifact; } });
  await new Promise(done => setTimeout(done, 30));
  await idle.stop();
  assert.equal(calls, 0);
  assert.equal(turbo.getPlace("osm:node:7").text.audio.sha256, artifact.sha256);
});

test("deliberate worker synthesis keeps its cache identity after publication failure and renewed lease", async t => {
  let now = Date.now();
  const { store, audioJob } = await queuedPlace(t, "eleven_v4", ":memory:", { now: () => now });
  const first = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1" }, narrate: async () => artifact });
  await until(() => store.getExternalAudio(audioJob.id).state === "succeeded");
  await first.stop();
  const textId = store.getPlace("osm:node:7").text.id;
  const enqueue = revoiceRequestId => store.enqueueExternalAudio({ sourceJobId: `place-text:${textId}`, sourceRevision: 0,
    story: { ...story, address: "Парк" }, profileId: ELEVENLABS_PROFILE_ID, revoiceRequestId });
  const deliberate = await enqueue("1932051c-d71f-4f16-8466-d7e58b965caa");
  assert.notEqual(deliberate.id, audioJob.id);
  assert.equal(store.getPlace("osm:node:7").text.audio.sha256, artifact.sha256);
  const replacement = { ...artifact, sha256: "f".repeat(64), url: `/api/story-audio/${"f".repeat(64)}.mp3` };
  let providerCalls = 0;
  const completedCache = new Map(), optionsSeen = [], generations = [], cacheProfiles = [];
  const narrate = async (_story, provider, _directory, _signal, options) => {
    optionsSeen.push(options);
    cacheProfiles.push({ model: provider.ttsModel, scriptVersion: provider.scriptVersion });
    if (!completedCache.has(options.cacheNamespace)) { providerCalls++; completedCache.set(options.cacheNamespace, replacement); }
    return completedCache.get(options.cacheNamespace);
  };
  const originalAccept = store.acceptExternalAudio.bind(store);
  const failingStore = { ...store, acceptExternalAudio: (_id, lease) => {
    generations.push(lease.generation);
    throw new Error("fixture publication unavailable");
  } };
  const failingWorker = startSpeechAudioWorker({ store: failingStore, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1", ttsModel: "eleven_v4", scriptVersion: "runtime-before" }, narrate });
  t.after(() => failingWorker.stop());
  await until(() => store.getExternalAudio(deliberate.id).state === "retry_wait");
  await failingWorker.stop();
  assert.equal(store.getPlace("osm:node:7").text.audio.sha256, artifact.sha256);
  assert.equal(optionsSeen[0].cacheNamespace, `external-revoice:${deliberate.id}`);
  now += 60000;
  const succeedingStore = { ...store, acceptExternalAudio: (id, lease) => { generations.push(lease.generation); return originalAccept(id, lease); } };
  const retryWorker = startSpeechAudioWorker({ store: succeedingStore, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1", ttsModel: "eleven_v4", scriptVersion: "runtime-after" }, narrate });
  t.after(() => retryWorker.stop());
  await until(() => store.getExternalAudio(deliberate.id).state === "succeeded");
  await retryWorker.stop();
  assert.equal(generations.length, 2);
  assert.ok(generations[1] > generations[0]);
  assert.equal(optionsSeen[1].cacheNamespace, optionsSeen[0].cacheNamespace);
  assert.deepEqual(cacheProfiles[0], { model: "eleven_v4", scriptVersion: "external-revoice-v1" });
  assert.deepEqual(cacheProfiles[1], cacheProfiles[0]);
  assert.equal(providerCalls, 1, "a completed artifact prevents another paid call after publication failure");
  assert.equal(store.getPlace("osm:node:7").text.audio.sha256, replacement.sha256);
  const next = await enqueue("6f1466c1-9e02-4d22-8dbd-4465f63cfe1a");
  assert.notEqual(next.id, deliberate.id);
  const nextWorker = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1" }, narrate });
  t.after(() => nextWorker.stop());
  await until(() => store.getExternalAudio(next.id).state === "succeeded");
  await nextWorker.stop();
  assert.equal(optionsSeen[2].cacheNamespace, `external-revoice:${next.id}`);
  assert.equal(providerCalls, 2, "a second explicit action bypasses the first explicit cache");
});

test("a deliberate cache miss cannot synthesize with a different runtime model", async t => {
  const { store, audioJob } = await queuedPlace(t, "eleven_v3");
  const first = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: "unused", pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1", ttsModel: "eleven_v3" }, narrate: async () => ({ ...artifact, model: "eleven_v3" }) });
  t.after(() => first.stop());
  await until(() => store.getExternalAudio(audioJob.id).state === "succeeded");
  await first.stop();
  const deliberate = await store.enqueueExternalAudio({ sourceJobId: `place-text:${store.getPlace("osm:node:7").text.id}`, sourceRevision: 0,
    story: { ...story, address: "Парк" }, profileId: ELEVENLABS_PROFILE_ID, revoiceRequestId: "6cf3a282-5a11-46f7-a82f-10bc0836d621" });
  const directory = await mkdtemp(join(tmpdir(), "speech-model-mismatch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const worker = startSpeechAudioWorker({ store, profileId: ELEVENLABS_PROFILE_ID, audioDirectory: directory, pollMs: 5,
    speechProvider: { ttsProvider: "elevenlabs", voice: "RuVoice1", ttsModel: "eleven_v4", speech: async () => { calls++; return Buffer.from("runtime audio"); } } });
  t.after(() => worker.stop());
  const failed = await until(() => { const job = store.getExternalAudio(deliberate.id); return job.state === "failed" ? job : null; });
  await worker.stop();
  assert.equal(failed.state, "failed");
  assert.equal(failed.error.code, "TTS_MODEL_MISMATCH");
  assert.equal(failed.error.message, "Speech synthesis failed");
  assert.equal(calls, 0, "an incompatible runtime must not incur provider credits on a cache miss");
  assert.equal(store.getPlace("osm:node:7").text.audio.model, "eleven_v3");
});
