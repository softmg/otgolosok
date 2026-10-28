// node revoice.mjs enqueue|status <walk-stops-*.json>...
// Runs inside the generator container. Queues ElevenLabs v4 («Отголосок2») for every stop of the given walks when its
// selected recording is not v4 «Отголосок2» or belongs to an older text revision; the running generator's worker
// synthesises them one by one.
// Each place gets a stable re-voice intent: a rerun acknowledges the queued job instead of paying for a second one.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [mode, ...stopPaths] = process.argv.slice(2);
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
// Paid batch confirmed by the user on 28 October 2026.
const EXPECTED = Number(process.env.EXPECTED ?? NaN);
const placeIds = [...new Set(stopPaths.flatMap((file) => JSON.parse(readFileSync(file, "utf8")).map((stop) => stop.placeId)))];

/** UUID-shaped stable intent: version 5 nibble, RFC variant, derived from the place and its approved text. */
const intentId = (placeId, textId) => {
  const hex = createHash("sha256").update(`garden-promo-walks-revoice-2026-10-28:${placeId}:${textId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${(8 | (parseInt(hex[16], 16) & 3)).toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

const store = createStore(databasePath, { normalizeExternalText: normalizeForSpeech,
  externalTtsProfiles: { [ELEVENLABS_PROFILE_ID]: elevenLabsProfile(VOICE, MODEL) } });
const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 10000 });
const results = [];
try {
  const plan = placeIds.map((placeId) => {
    const place = store.getPublishedPlace(placeId);
    assert.ok(place?.text, `Нет опубликованного текста: ${placeId}`);
    const own = db.prepare("SELECT audio_json FROM place_texts WHERE id=?").get(place.text.id)?.audio_json;
    const audio = place.text.audio;
    const isV4 = audio?.provider === "elevenlabs" && audio.model === MODEL && audio.voice === VOICE;
    const current = Boolean(own && own !== "null");
    return { place, audio, needed: !isV4 || !current, reason: !isV4 ? `${audio?.provider ?? "нет"}/${audio?.model ?? "-"}` : current ? "ok" : "старый текст" };
  });
  const needed = plan.filter((item) => item.needed);
  if (mode === "enqueue") assert.equal(needed.length, EXPECTED, `Партия не совпадает с подтверждённой: ${needed.length} вместо ${EXPECTED}`);
  for (const { place, audio, needed: need, reason } of plan) {
    const requestId = intentId(place.id, place.text.id);
    const job = db.prepare(`SELECT id,state,attempts,error_json FROM external_audio_jobs WHERE source_job_id=? AND profile_id=?
      AND json_extract(payload_json,'$.revoiceRequestId')=? ORDER BY created_at DESC LIMIT 1`).get(`place-text:${place.text.id}`, ELEVENLABS_PROFILE_ID, requestId);
    if (mode === "status") {
      results.push({ placeId: place.id, name: place.name, textId: place.text.id, reason, job: job ?? null,
        audio: audio && { sha256: audio.sha256, durationSec: audio.durationSec, provider: audio.provider, model: audio.model, voice: audio.voice } });
      continue;
    }
    if (!need) continue;
    const queued = await store.enqueueExternalAudio({ sourceJobId: `place-text:${place.text.id}`, sourceRevision: 0,
      story: { ...place.text.story, address: place.address ?? place.name }, profileId: ELEVENLABS_PROFILE_ID, revoiceRequestId: requestId });
    results.push({ placeId: place.id, name: place.name, textId: place.text.id, reason, requestId, audioJobId: queued.id, state: queued.state,
      previousAudioSha256: audio?.sha256 ?? null });
  }
  if (mode === "status") console.error(`нужно переозвучить: ${needed.length}`);
} finally {
  store.close();
  db.close();
}
console.log(JSON.stringify({ mode, at: new Date().toISOString(), count: results.length, results }, null, 2));
