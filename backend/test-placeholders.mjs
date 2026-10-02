import { randomUUID } from "node:crypto";
import { assessPlaceEligibility } from "./place-eligibility.mjs";

export const TEST_PROFILE = "test-placeholder-v2";
const LEGACY_PROFILE = "test-placeholder-v1";

/** @typedef {{id: string, name: string, address: string | null, lat: number, lon: number, tags_json: string, content_hash: string}} PlaceRow */

/** @param {{id: string, name: string}} place */
function osmUrl(place) {
  const [, type, id] = /^osm:(node|way|relation):(\d+)$/.exec(place.id) ?? [];
  return type ? `https://www.openstreetmap.org/${type}/${id}` : "https://www.openstreetmap.org/";
}

/**
 * The same test story for every place: the full card shape (paragraphs, facts, sources) with the place name substituted.
 * @param {{id: string, name: string, address: string | null}} place
 */
export function testStory(place) {
  const where = place.address ?? `Москва, ${place.name}`;
  const paragraphs = [
    `${place.name} — одна из тех точек на карте, мимо которых легко пройти, не заметив. Этот рассказ тестовый: он показывает, как будет выглядеть настоящая история о месте, когда редакция её подготовит. Пока что здесь общий текст, одинаковый для всех достопримечательностей.`,
    `Остановитесь на минуту и посмотрите вокруг. Обратите внимание на фасады, вывески, деревья и то, как люди проходят мимо. У каждого места в городе есть своя история: кто здесь жил, что строили и перестраивали, какие события оставили след на этой улице.`,
    `Адрес точки: ${where}. Скоро вместо этого текста появится рассказ с проверенными фактами и ссылками на источники, а запись озвучки будет посвящена именно этому месту.`,
  ];
  return {
    title: place.name,
    address: where,
    verification: "editorial",
    requestedProfile: "story-v1",
    effectiveProfile: "story-v1",
    audioDisposition: "eligible",
    wordCount: paragraphs.join(" ").split(/\s+/u).length,
    paragraphs: paragraphs.map((text, index) => ({ text, factIds: index === 2 ? ["f2"] : ["f1"] })),
    facts: [
      { id: "f1", claim: `Объект «${place.name}» отмечен на карте OpenStreetMap.`, sourceIds: ["s1"] },
      { id: "f2", claim: `Адрес объекта: ${where}.`, sourceIds: ["s1"] },
    ],
    sources: [{ id: "s1", title: `${place.name} на OpenStreetMap`, url: osmUrl(place), publisher: "OpenStreetMap" }],
  };
}

/**
 * Local test data only: no content jobs, batches or audio jobs are created.
 * Eligible places without any text get the test story; earlier test stories are upgraded in place.
 * Real publications are never touched. `audio` is one shared artifact for every test story, or null.
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {{audio?: object | null}} [options]
 */
export function seedTestPlaceholders(db, { audio = null } = {}) {
  const audioJson = audio ? JSON.stringify(audio) : null;
  db.exec("BEGIN IMMEDIATE");
  try {
    const rows = /** @type {PlaceRow[]} */ (db.prepare("SELECT * FROM places WHERE archived=0 AND NOT EXISTS (SELECT 1 FROM place_texts WHERE place_id=places.id)").all());
    const insert = db.prepare(`INSERT INTO place_texts
      (id,place_id,input_key,profile,content_hash,story_json,evidence_json,verification,audio_json,approved_story_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let inserted = 0;
    for (const row of rows) {
      if (!assessPlaceEligibility({ name: row.name, address: row.address, location: { lat: row.lat, lon: row.lon }, tags: JSON.parse(row.tags_json) }).eligible) continue;
      const story = JSON.stringify(testStory(row));
      // A real publication always supersedes this fixture, including older imports.
      insert.run(randomUUID(), row.id, `${TEST_PROFILE}:${row.id}`, TEST_PROFILE, row.content_hash, story, "{}", "test_placeholder", audioJson, story, "1970-01-01T00:00:00.000Z");
      inserted++;
    }
    const stale = /** @type {Array<{id: string, place_id: string, name: string, address: string | null}>} */ (db.prepare(`SELECT t.id,p.id place_id,p.name,p.address FROM place_texts t JOIN places p ON p.id=t.place_id
      WHERE t.verification='test_placeholder' AND (t.profile=? OR t.audio_json IS NOT ?)`).all(LEGACY_PROFILE, audioJson));
    const update = db.prepare("UPDATE place_texts SET profile=?,story_json=?,approved_story_json=?,audio_json=? WHERE id=?");
    for (const row of stale) {
      const story = JSON.stringify(testStory({ id: row.place_id, name: row.name, address: row.address }));
      update.run(TEST_PROFILE, story, story, audioJson, row.id);
    }
    db.exec("COMMIT");
    return { inserted, updated: stale.length, generationJobsCreated: 0, audioJobsCreated: 0 };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
