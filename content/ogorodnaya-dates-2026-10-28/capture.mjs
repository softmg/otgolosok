// PLACE_IDS=<id,id,...> node --input-type=module < capture.mjs > captured.json
// Runs inside the generator container (read-only rootfs, so the script comes on stdin), read-only: the published story, audio and photo of every stop of the given walks.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const backend = process.env.BACKEND_DIR ?? "/app/backend";
const databasePath = process.env.DATABASE_PATH ?? "/data/jobs.sqlite";
const { createContentStore } = await import(pathToFileURL(join(backend, "content-store.mjs")).href);
const placeIds = [...new Set((process.env.PLACE_IDS ?? "").split(",").filter(Boolean))];
assert.ok(placeIds.length, "PLACE_IDS пуст");
const db = new DatabaseSync(databasePath, { readOnly: true, timeout: 10000 });
db.function("casefold", (value) => typeof value === "string" ? value.toLocaleLowerCase("ru-RU") : "");
try {
  const store = createContentStore({ db, now: Date.now, transaction: (fn) => fn() });
  const places = [];
  for (const placeId of placeIds) {
    const place = db.prepare("SELECT * FROM places WHERE id=?").get(placeId);
    const published = store.getPublishedPlace(placeId);
    assert.ok(place && published?.text, `Нет опубликованной точки ${placeId}`);
    const latest = db.prepare(`SELECT id FROM place_texts WHERE place_id=? AND approved_story_json IS NOT NULL
      ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(placeId);
    places.push({ placeId, name: place.name, textId: latest.id, publishedTextId: published.text.id,
      placeContentHash: place.content_hash, address: place.address, location: { lat: place.lat, lon: place.lon },
      story: published.text.story, audio: published.text.audio ?? null, photo: store.getPlaceImageRow(placeId) });
  }
  console.log(JSON.stringify({ capturedAt: new Date().toISOString(), places }, null, 2));
} finally {
  db.close();
}
