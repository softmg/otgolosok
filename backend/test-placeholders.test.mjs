import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { seedTestPlaceholders } from "./test-placeholders.mjs";

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
    assert.ok(store.listPlaces({ status: "ready" }).places.every(p => !p.audio && p.story.paragraphs[0].text.startsWith("Тестовая точка")));
    db.exec("CREATE TRIGGER reject_placeholder BEFORE INSERT ON place_texts BEGIN SELECT RAISE(ABORT,'fixture error'); END");
    store.importPlaces({ source: "test", sourceSha256: "b".repeat(64), places: [{ ...places[0], placeId: "osm:node:3", osmId: 3 }] });
    assert.throws(() => seedTestPlaceholders(db), /fixture error/);
    assert.equal(db.prepare("SELECT count(*) n FROM place_texts").get().n, 2);
  } finally { db.close(); store.close(); }
});
