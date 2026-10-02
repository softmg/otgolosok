import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { seedTestPlaceholders, TEST_PROFILE } from "./test-placeholders.mjs";
import { hasValidStoryText } from "./admin.mjs";

test("test points are published without jobs, repeated imports preserve existing text", t => {
  const dir = mkdtempSync(join(tmpdir(), "osm-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "jobs.sqlite"), store = createStore(file);
  const places = [1, 2].map(id => ({ placeId: `osm:node:${id}`, osmType: "node", osmId: id, name: `Памятник ${id}`, location: { lat: 55.75, lon: 37.61 }, tags: { historic: "memorial", wikidata: `Q${id}` } }));
  store.importPlaces({ source: "test", sourceSha256: "a".repeat(64), places });
  const db = new DatabaseSync(file);
  try {
    assert.equal(seedTestPlaceholders(db).inserted, 2);
    assert.equal(store.listPlaces({ status: "ready" }).places.length, 2);
    const before = db.prepare("SELECT * FROM place_texts").all();
    assert.equal(seedTestPlaceholders(db).inserted, 0);
    assert.deepEqual(db.prepare("SELECT * FROM place_texts").all(), before);
    assert.equal(db.prepare("SELECT count(*) n FROM content_jobs").get().n, 0);
    assert.equal(db.prepare("SELECT count(*) n FROM content_batches").get().n, 0);
    const ready = store.listPlaces({ status: "ready" }).places;
    assert.ok(ready.every(p => !p.audio && hasValidStoryText(p.story) && p.story.title === p.name && p.story.facts.length && p.story.sources[0].url.endsWith(p.id.split(":")[2])));
    db.exec("CREATE TRIGGER reject_placeholder BEFORE INSERT ON place_texts BEGIN SELECT RAISE(ABORT,'fixture error'); END");
    store.importPlaces({ source: "test", sourceSha256: "b".repeat(64), places: [{ ...places[0], placeId: "osm:node:3", osmId: 3 }] });
    assert.throws(() => seedTestPlaceholders(db), /fixture error/);
    assert.equal(db.prepare("SELECT count(*) n FROM place_texts").get().n, 2);
  } finally { db.close(); store.close(); }
});

test("earlier test stories are upgraded and get the shared audio; real publications are untouched", t => {
  const dir = mkdtempSync(join(tmpdir(), "osm-fixture-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "jobs.sqlite"), store = createStore(file);
  const places = [1, 2].map(id => ({ placeId: `osm:way:${id}`, osmType: "way", osmId: id, name: `Усадьба ${id}`, location: { lat: 55.75, lon: 37.61 }, tags: { historic: "manor", wikidata: `Q${id}` } }));
  store.importPlaces({ source: "test", sourceSha256: "a".repeat(64), places });
  const db = new DatabaseSync(file);
  try {
    const legacy = JSON.stringify({ title: "Усадьба 1", paragraphs: [{ text: "Тестовая точка.", factIds: [] }] });
    const real = JSON.stringify({ title: "Настоящая история" });
    const insert = db.prepare("INSERT INTO place_texts (id,place_id,input_key,profile,content_hash,story_json,evidence_json,verification,audio_json,approved_story_json,created_at) VALUES (?,?,?,?,'h',?,'{}',?,NULL,?,'2026-01-01T00:00:00.000Z')");
    insert.run("a", "osm:way:1", "k1", "test-placeholder-v1", legacy, "test_placeholder", legacy);
    insert.run("b", "osm:way:2", "k2", "story-v1", real, "automatic", real);
    const audio = { url: `/api/story-audio/${"c".repeat(64)}.mp3`, sha256: "c".repeat(64), bytes: 10, durationSec: 30, synthetic: true };
    assert.deepEqual(seedTestPlaceholders(db, { audio }), { inserted: 0, updated: 1, generationJobsCreated: 0, audioJobsCreated: 0 });
    const upgraded = db.prepare("SELECT * FROM place_texts WHERE id='a'").get();
    assert.equal(upgraded.profile, TEST_PROFILE);
    assert.ok(hasValidStoryText(JSON.parse(String(upgraded.approved_story_json))));
    assert.deepEqual(JSON.parse(String(upgraded.audio_json)), audio);
    assert.equal(db.prepare("SELECT approved_story_json s FROM place_texts WHERE id='b'").get().s, real);
    assert.equal(seedTestPlaceholders(db, { audio }).updated, 0);
    assert.equal(seedTestPlaceholders(db).updated, 1, "a run without audio removes the shared audio");
    assert.equal(db.prepare("SELECT audio_json a FROM place_texts WHERE id='a'").get().a, null);
  } finally { db.close(); store.close(); }
});
