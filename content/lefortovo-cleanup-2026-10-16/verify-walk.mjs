// node verify-walk.mjs <share-token> > walk-verification.json
// Reads the walk through the public API: every chapter must play ElevenLabs v4 «Отголосок2» made from its current text.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const origin = "https://otgolosok.online";
const VOICE = "9ivxhQ6xIsHd6R3Xc635";
const [token] = process.argv.slice(2);
assert.match(token ?? "", /^[0-9a-f-]{36}$/, "Нужен токен общей ссылки");

async function curl(path) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = spawnSync("curl", ["--http2", "-fsS", "--connect-timeout", "8", "--max-time", "30", `${origin}${path}`],
      { encoding: null, maxBuffer: 16 * 1024 * 1024 });
    if (!result.error && result.status === 0) return result.stdout;
    lastError = result.error ?? new Error(`curl ${path}: ${result.status}; ${result.stderr?.toString("utf8").trim()}`);
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw lastError;
}

const walk = JSON.parse((await curl(`/api/story-walks/shared/${token}`)).toString("utf8"));
const chapters = [];
let total = 0;
for (const [index, chapter] of walk.chapters.entries()) {
  const stop = walk.document.stops[index];
  const place = JSON.parse((await curl(`/api/content/places/${stop.placeId}`)).toString("utf8")).place;
  // The walk view carries only the hash and duration; provenance comes from the place card of the same recording.
  const audio = place.text.audio;
  assert.ok(chapter.audio?.sha256 && audio?.url, `Нет звука: ${stop.placeId}`);
  assert.equal(audio.provider, "elevenlabs", stop.placeId);
  assert.equal(audio.model, "eleven_v4", stop.placeId);
  assert.equal(audio.voice, VOICE, stop.placeId);
  assert.deepEqual(chapter.story.paragraphs.map(({ text }) => text), place.text.story.paragraphs.map(({ text }) => text), `Текст главы не текущий: ${stop.placeId}`);
  assert.equal(chapter.audio.sha256, audio.sha256, `Звук главы не текущий: ${stop.placeId}`);
  const bytes = await curl(audio.url);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), chapter.audio.sha256, stop.placeId);
  total += chapter.audio.durationSec;
  chapters.push({ placeId: stop.placeId, title: chapter.story.title, words: place.text.story.wordCount,
    audio: { sha256: chapter.audio.sha256, bytes: bytes.byteLength, durationSec: chapter.audio.durationSec } });
}
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), title: walk.document.title, distanceM: walk.document.route.distanceM,
  walkingMinutes: walk.document.route.walkingMinutes, stops: chapters.length, audioSec: Math.round(total * 10) / 10, chapters }, null, 2));
