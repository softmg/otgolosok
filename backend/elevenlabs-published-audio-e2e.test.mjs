import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { sessionCsrfToken } from "./auth.mjs";
import { ELEVENLABS_PROFILE_ID, elevenLabsProfile, startSpeechAudioWorker } from "./speech-audio-worker.mjs";

// Local PCM fixtures pass through the production encoder, loudness filter and ffprobe.
function wave(frequency) {
  const sampleRate = 24000, samples = sampleRate * 2;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF", 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24); bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index++) bytes.writeInt16LE(Math.round(4000 * Math.sin(2 * Math.PI * frequency * index / sampleRate)), 44 + index * 2);
  return bytes;
}

async function until(check) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Локальный аудиоворкер не завершил ожидаемый этап за 10 секунд");
}

test("HTTP approval, restart, deliberate synthesis and publication retry protect public ElevenLabs audio", async t => {
  const directory = await mkdtemp(join(tmpdir(), "elevenlabs-publication-e2e-"));
  const databasePath = join(directory, "isolated.sqlite"), audioDirectory = join(directory, "audio");
  const origin = "https://audio-fixture.test", placeId = "osm:node:7";
  const paragraph = ("Проверенный рассказ о московском парке, его истории, архитектуре и людях. ").repeat(9).trim();
  const story = { title: "Парк", paragraphs: [{ text: paragraph, factIds: ["f1"] }, { text: paragraph, factIds: ["f2"] }] };
  let now = Date.now(), calls = 0;
  /** @type {ReturnType<typeof createApp> | null} */ let app = null;
  /** @type {ReturnType<typeof createStore> | null} */ let store = null;
  /** @type {ReturnType<typeof startSpeechAudioWorker> | null} */ let worker = null;
  /** @type {(() => void) | null} */ let releaseSpeech = null;
  let speechGate = null;
  const auth = { api: { getSession: async () => ({ user: { id: "fixture-editor", role: "editor" }, session: { id: "fixture-session", createdAt: new Date() } }) } };
  t.after(async () => {
    releaseSpeech?.();
    if (worker) await worker.stop();
    if (app) await app.close();
    store?.close();
    await rm(directory, { recursive: true, force: true });
  });
  let base;
  const start = async model => {
    store = createStore(databasePath, { now: () => now, random: () => 0,
      externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile("Отголосок2", model) },
      normalizeExternalText: Object.assign(async text => text, { version: "fixture-local" }) });
    const speechProvider = { ttsProvider: "elevenlabs", ttsModel: model, voice: "Отголосок2", voices: [], scriptVersion: `fixture-tagging-${model}`, speech: async (script, options) => {
      assert.ok(script.includes(paragraph));
      assert.equal(options.voice, "Отголосок2");
      calls++;
      if (speechGate) await speechGate;
      return wave(200 + calls * 100);
    } };
    // No runtime provider or credentials are loaded; only the explicitly started local worker runs.
    app = createApp({ store, provider: null, origin, audioDirectory, workerEnabled: false,
      elevenLabsTts: speechProvider, auth: /** @type {any} */ (auth), adminToken: "", workerToken: "", promoWalksToken: "" });
    await /** @type {Promise<void>} */ (new Promise(resolve => app.server.listen(0, "127.0.0.1", resolve)));
    base = `http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
    return speechProvider;
  };
  const post = async (path, input) => {
    const response = await fetch(`${base}/api/story-admin/content/${path}`, { method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json", "X-CSRF-Token": sessionCsrfToken("", "fixture-session") }, body: JSON.stringify(input) });
    const body = /** @type {any} */ (await response.json());
    assert.equal(response.status, 200, JSON.stringify(body));
    return body;
  };
  const published = async () => {
    const response = await fetch(`${base}/api/content/places/${placeId}`);
    assert.equal(response.status, 200);
    return /** @type {any} */ (await response.json()).place.text.audio;
  };
  const assertServed = async artifact => {
    assert.equal((await published()).sha256, artifact.sha256);
    const admin = /** @type {any} */ (await fetch(`${base}/api/story-admin/content/places/${placeId}`).then(response => response.json()));
    assert.equal(admin.place.text.audio.sha256, artifact.sha256);
    const response = await fetch(`${base}${artifact.url}`);
    assert.equal(response.status, 200);
    assert.equal((await response.arrayBuffer()).byteLength, artifact.bytes);
  };
  const startWorker = provider => {
    worker = startSpeechAudioWorker({ store, speechProvider: provider, profileId: ELEVENLABS_PROFILE_ID, audioDirectory, pollMs: 10 });
  };
  const restart = async model => {
    if (worker) { await worker.stop(); worker = null; }
    await app.close(); app = null;
    store.close(); store = null;
    return start(model);
  };
  const jobs = () => store.listExternalAudio({ states: ["queued", "leased", "retry_wait", "failed", "cancelled", "succeeded"] });

  const v3 = await start("eleven_v3");
  store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), places: [{ placeId, osmType: "node", osmId: 7, name: "Парк", location: { lat: 55.75, lon: 37.61 }, tags: { leisure: "park" } }] });
  store.createBatch({ requestKey: "e2e-local", placeIds: [placeId], limit: 1, mode: "text-and-audio", ttsProfile: ELEVENLABS_PROFILE_ID });
  const contentJob = store.claimContentJob();
  store.completeContentJob(contentJob.id, { story, evidence: { facts: [] } });
  await post(`places/${placeId}/approve`, { story });
  assert.equal(jobs().length, 1);
  const initialJobId = jobs()[0].id;
  startWorker(v3);
  await until(() => store.getExternalAudio(initialJobId).state === "succeeded");
  const original = await published();
  assert.equal(original.model, "eleven_v3");
  assert.equal(calls, 1);

  const v4 = await restart("eleven_v4");
  await post(`places/${placeId}/approve`, { story });
  assert.equal(jobs().length, 1);
  assert.equal(jobs()[0].id, initialJobId);
  startWorker(v4);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 1);
  await assertServed(original);
  await worker.stop(); worker = null;

  const requestId = randomUUID();
  const request = { profileId: ELEVENLABS_PROFILE_ID, requestId };
  const replacement = (await post(`places/${placeId}/audio`, request)).audioJob;
  assert.notEqual(replacement.id, initialJobId);
  assert.equal(jobs().length, 2);
  await assertServed(original);
  assert.equal((await post(`places/${placeId}/audio`, request)).audioJob.id, replacement.id);
  assert.equal(jobs().length, 2);

  // Fail exactly at publication, after createNarration durably writes its real MP3/cache metadata.
  const accept = store.acceptExternalAudio.bind(store);
  /** @type {any} */ let rejectedArtifact;
  store.acceptExternalAudio = (id, upload) => {
    if (id === replacement.id && !rejectedArtifact) {
      rejectedArtifact = upload.artifact;
      throw Object.assign(new Error("Локальный сбой публикации"), { code: "TTS_FAILED" });
    }
    return accept(id, upload);
  };
  speechGate = /** @type {Promise<void>} */ (new Promise(resolve => { releaseSpeech = resolve; }));
  startWorker(v4);
  await until(() => calls === 2);
  assert.equal(store.getExternalAudio(replacement.id).state, "leased");
  await assertServed(original);
  releaseSpeech(); speechGate = null;
  await until(() => store.getExternalAudio(replacement.id).state === "retry_wait");
  assert.notEqual(rejectedArtifact.sha256, original.sha256);
  await assertServed(original);
  assert.equal(calls, 2);

  // Restart and a model upgrade remove the injection; retry must retain the original synthesis identity.
  const retriedProvider = await restart("eleven_v4_turbo");
  assert.equal((await post(`places/${placeId}/audio`, request)).audioJob.id, replacement.id);
  now += 60000;
  startWorker(retriedProvider);
  await until(() => store.getExternalAudio(replacement.id).state === "succeeded");
  assert.equal(calls, 2, "Публикационный повтор должен использовать сохранённый MP3 без нового speech");
  assert.equal((await published()).model, "eleven_v4");
  await assertServed(rejectedArtifact);
  assert.equal((await post(`places/${placeId}/audio`, request)).audioJob.id, replacement.id);
  assert.equal(jobs().length, 2);
  await worker.stop(); worker = null;

  // A new action uses the newly configured model and receives a fresh synthesis namespace.
  const next = (await post(`places/${placeId}/audio`, { profileId: ELEVENLABS_PROFILE_ID, requestId: randomUUID() })).audioJob;
  assert.notEqual(next.id, replacement.id);
  await assertServed(rejectedArtifact);
  startWorker(retriedProvider);
  await until(() => store.getExternalAudio(next.id).state === "succeeded");
  assert.equal(calls, 3);
  assert.equal((await published()).model, "eleven_v4_turbo");
  assert.notEqual((await published()).sha256, rejectedArtifact.sha256);
  assert.equal(jobs().length, 3);
});
