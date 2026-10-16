// node revoice.mjs enqueue|status <changes.json> <walk-changes.json>
// Runs inside the generator container. Queues ElevenLabs v4 («Отголосок2») for every edited Lefortovo text whose
// selected recording belongs to an older revision; the running generator's worker synthesises them one by one.
// Each place gets a stable re-voice intent: a rerun acknowledges the queued job instead of paying for a second one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, ...bundlePaths] = process.argv.slice(2);
assert.ok(["enqueue", "status"].includes(mode), "Режим: enqueue или status");
const backend = process.env.BACKEND_DIR ?? "/app/backend";
const databasePath = process.env.DATABASE_PATH ?? "/data/jobs.sqlite";
const load = (file) => import(pathToFileURL(join(backend, file)).href);
const { createStore } = await load("store.mjs");
const { normalizeForSpeech } = await load("text-normalizer.mjs");
const { ELEVENLABS_PROFILE_ID, elevenLabsProfile } = await load("speech-audio-worker.mjs");

const VOICE = "9ivxhQ6xIsHd6R3Xc635", MODEL = "eleven_v4";
assert.equal(process.env.ELEVENLABS_VOICE_ID, VOICE, "Голос генератора не «Отголосок2»");
assert.equal(process.env.ELEVENLABS_MODEL, MODEL, "Модель генератора не eleven_v4");
// Cards whose text an earlier batch (ТТК, 9 October) changed without re-voicing; they stand next to the walk.
const STALE = ["osm:way:39254926", "osm:way:48894240"];
const placeIds = [...new Set([...bundlePaths.flatMap((file) => JSON.parse(readFileSync(file, "utf8")).entries
  .filter((entry) => entry.status === "changed").map((entry) => entry.placeId)), ...STALE])];

/** UUID-shaped stable intent: version 5 nibble, RFC variant, derived from the place and its approved text. */
const intentId = (placeId, textId) => {
  const hex = createHash("sha256").update(`lefortovo-revoice-2026-10-16:${placeId}:${textId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const store = createStore(databasePath, { normalizeExternalText: normalizeForSpeech,
  externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile(VOICE, MODEL) } });
const jobs = new DatabaseSync(databasePath, { readOnly: true, timeout: 10000 });
const results = [];
try {
  for (const placeId of placeIds) {
    const place = store.getPublishedPlace(placeId);
    assert.ok(place?.text, `Нет опубликованного текста: ${placeId}`);
    const requestId = intentId(placeId, place.text.id);
    const current = place.text.audio;
    const job = jobs.prepare(`SELECT id,state,attempts,error_json FROM external_audio_jobs WHERE source_job_id=? AND profile_id=?
      AND json_extract(payload_json,'$.revoiceRequestId')=? ORDER BY created_at DESC LIMIT 1`).get(`place-text:${place.text.id}`, ELEVENLABS_PROFILE_ID, requestId);
    if (mode === "status") {
      results.push({ placeId, name: place.name, textId: place.text.id, job: job ?? null,
        audio: current && { sha256: current.sha256, durationSec: current.durationSec, provider: current.provider, model: current.model, voice: current.voice } });
      continue;
    }
    const queued = await store.enqueueExternalAudio({ sourceJobId: `place-text:${place.text.id}`, sourceRevision: 0,
      story: { ...place.text.story, address: place.address ?? place.name }, profileId: ELEVENLABS_PROFILE_ID, revoiceRequestId: requestId });
    results.push({ placeId, name: place.name, textId: place.text.id, requestId, audioJobId: queued.id, state: queued.state,
      previousAudioSha256: current?.sha256 ?? null });
  }
} finally {
  store.close();
  jobs.close();
}
console.log(JSON.stringify({ mode, at: new Date().toISOString(), count: results.length, results }, null, 2));
