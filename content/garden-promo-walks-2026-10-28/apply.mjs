// node apply.mjs <changes.json> dry-run|apply <backup.json>
// Runs inside the generator container or against an isolated DB copy. Publishes edited texts only:
// the previous MP3 stays selected until a separately confirmed ElevenLabs v4 re-voice replaces it.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Both batches of this package: the first for all four walks, the second for the stops added to the Ogorodnaya walk.
const BATCHES = { "garden-promo-walks-2026-10-28": 17, "garden-promo-walks-ogorodnaya-2026-10-28": 3 };
const [bundlePath, mode, backupPath] = process.argv.slice(2);
assert.ok(["dry-run", "apply"].includes(mode), "Режим: dry-run или apply");
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
const BUNDLE_ID = bundle.id;
assert.ok(Object.hasOwn(BATCHES, BUNDLE_ID), `Неизвестная партия ${BUNDLE_ID}`);
const changed = bundle.entries.filter((entry) => entry.status === "changed");
assert.equal(changed.length, BATCHES[BUNDLE_ID]);
const backend = process.env.BACKEND_DIR ?? "/app/backend";
const databasePath = process.env.DATABASE_PATH ?? "/data/jobs.sqlite";
const { createContentStore } = await import(pathToFileURL(join(backend, "content-store.mjs")).href);
const sha = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const parse = (value) => value === null ? null : JSON.parse(value);
const audioSha = (published) => published?.text?.audio?.sha256 ?? null;

let db;
let inTransaction = false;
try {
  db = new DatabaseSync(databasePath, { timeout: 10000 });
  db.function("casefold", (value) => typeof value === "string" ? value.toLocaleLowerCase("ru-RU") : "");
  const store = createContentStore({ db, now: Date.now, transaction: (fn) => fn() });
  const latest = (placeId) => db.prepare(`SELECT * FROM place_texts WHERE place_id=? AND approved_story_json IS NOT NULL
    ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(placeId);
  db.exec("BEGIN IMMEDIATE");
  inTransaction = true;
  const pending = [];
  const before = { places: [], texts: [], audioJobs: [] };
  const results = [];
  for (const entry of changed) {
    const place = db.prepare("SELECT * FROM places WHERE id=?").get(entry.placeId);
    const current = latest(entry.placeId);
    assert.ok(place && !place.archived && current, `Отсутствует точка ${entry.placeId}`);
    if (current.id !== entry.expected.textId) {
      // A rerun after a successful apply finds this batch's own revision and skips it.
      const marker = parse(current.evidence_json)?.editorialCleanup;
      assert.equal(marker?.bundleId, BUNDLE_ID, `Другая редакция: ${entry.placeId}`);
      assert.equal(marker.storyHash, sha(entry.story), `Изменилась партия: ${entry.placeId}`);
      assert.deepEqual(parse(current.approved_story_json), entry.story, `Другая редакция: ${entry.placeId}`);
      results.push({ placeId: entry.placeId, textId: current.id, skipped: true });
      continue;
    }
    const rows = db.prepare("SELECT * FROM place_texts WHERE place_id=? ORDER BY created_at,rowid").all(entry.placeId);
    const sourceJobs = db.prepare("SELECT * FROM external_audio_jobs WHERE source_job_id IN (SELECT 'place-text:'||id FROM place_texts WHERE place_id=?)").all(entry.placeId);
    assert.equal(place.content_hash, entry.expected.placeContentHash, `Изменена точка: ${entry.placeId}`);
    assert.equal(place.address, entry.expected.address, `Изменён адрес карточки: ${entry.placeId}`);
    assert.equal(place.lat, entry.expected.location.lat, `Изменена широта: ${entry.placeId}`);
    assert.equal(place.lon, entry.expected.location.lon, `Изменена долгота: ${entry.placeId}`);
    assert.deepEqual(parse(current.approved_story_json), entry.expected.story, `Изменён рассказ: ${entry.placeId}`);
    assert.equal(audioSha(store.getPublishedPlace(entry.placeId)), entry.expected.audio?.sha256 ?? null, `Изменено аудио: ${entry.placeId}`);
    assert.equal(rows.at(-1).id, current.id, `Есть новая редакция или черновик: ${entry.placeId}`);
    assert.equal(db.prepare("SELECT count(*) n FROM content_jobs WHERE place_id=? AND state IN ('queued','retry_wait','working')").get(entry.placeId).n, 0,
      `Активное исследование: ${entry.placeId}`);
    assert.ok(sourceJobs.every((job) => !["queued", "retry_wait", "leased"].includes(job.state)), `Активная запись: ${entry.placeId}`);
    before.places.push(place);
    before.texts.push(...rows);
    before.audioJobs.push(...sourceJobs);
    pending.push(entry);
  }
  if (mode === "apply" && pending.length) {
    assert.ok(backupPath, "Нужен путь единого резервного снимка");
    writeFileSync(backupPath, JSON.stringify({ bundleId: BUNDLE_ID, createdAt: new Date().toISOString(), before }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 });
  }
  for (const entry of pending) {
    const old = latest(entry.placeId);
    const saved = store.approvePlaceText(entry.placeId, entry.story);
    assert.ok(saved?.text?.id && saved.text.id !== old.id, `Не создана редакция: ${entry.placeId}`);
    const evidence = { ...(parse(old.evidence_json) ?? {}), sources: entry.story.sources, facts: entry.story.facts,
      editorialCleanup: { bundleId: BUNDLE_ID, storyHash: sha(entry.story) } };
    db.prepare("UPDATE place_texts SET evidence_json=?,profile=? WHERE id=?").run(JSON.stringify(evidence), "story-v1", saved.text.id);
    const published = store.getPublishedPlace(entry.placeId);
    assert.deepEqual(published.text.story, entry.story);
    assert.equal(audioSha(published), entry.expected.audio?.sha256 ?? null, `Прежнее аудио пропало: ${entry.placeId}`);
    results.push({ placeId: entry.placeId, textId: saved.text.id, previousTextId: old.id, previousAudioSha256: entry.expected.audio?.sha256 ?? null });
  }
  db.exec(mode === "apply" ? "COMMIT" : "ROLLBACK");
  inTransaction = false;
  console.log(JSON.stringify({ mode, results }));
} catch (error) {
  if (inTransaction) db?.exec("ROLLBACK");
  console.error(error.message);
  process.exitCode = 1;
} finally {
  db?.close();
}
