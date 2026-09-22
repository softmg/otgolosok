import { randomUUID } from "node:crypto";
import { assessPlaceEligibility } from "./place-eligibility.mjs";

// Local test data only: no content jobs, batches or audio jobs are created.
export function seedTestPlaceholders(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = db.prepare("SELECT * FROM places WHERE archived=0 AND NOT EXISTS (SELECT 1 FROM place_texts WHERE place_id=places.id)").all();
    const insert = db.prepare(`INSERT INTO place_texts
      (id,place_id,input_key,profile,content_hash,story_json,evidence_json,verification,audio_json,approved_story_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,NULL,?,?)`);
    let inserted = 0;
    for (const row of rows) {
      if (!assessPlaceEligibility({ name: row.name, address: row.address, location: { lat: row.lat, lon: row.lon }, tags: JSON.parse(row.tags_json) }).eligible) continue;
      const story = JSON.stringify({ title: row.name, paragraphs: [{ text: "Тестовая точка. Описание и аудио пока не подготовлены.", factIds: [] }], audioDisposition: "not_applicable_short_text" });
      // A real publication always supersedes this fixture, including older imports.
      insert.run(randomUUID(), row.id, `test-placeholder-v1:${row.id}`, "test-placeholder-v1", row.content_hash, story, "{}", "test_placeholder", story, "1970-01-01T00:00:00.000Z");
      inserted++;
    }
    db.exec("COMMIT");
    return { inserted, generationJobsCreated: 0, audioJobsCreated: 0 };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
