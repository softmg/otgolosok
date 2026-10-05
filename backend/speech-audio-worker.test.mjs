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

async function queuedPlace(t, model = "eleven_v4", path = ":memory:") {
  const store = createStore(path, { externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile("RuVoice1", model) },
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

test("a new ElevenLabs model voices an already voiced text again; the same model reuses the finished job", async t => {
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
  t.after(() => upgraded.close());
  const revoiced = await enqueue(upgraded);
  assert.notEqual(revoiced.id, audioJob.id);
  assert.equal(revoiced.state, "queued");
  // The old recording stays published until the new one succeeds.
  assert.equal(upgraded.getPlace("osm:node:7").text.audio.model, "eleven_v3");
});
