// Read-only snapshot of promo walks and narrated places, run INSIDE the production
// generator container: `ssh "$VPS" 'docker exec -i <container> node --input-type=module' < collect.mjs`.
// Prints one JSON document to stdout; writes nothing to the server.
import { DatabaseSync } from "node:sqlite";

const auth = new DatabaseSync("/data/auth.sqlite", { readOnly: true });
const jobs = new DatabaseSync("/data/jobs.sqlite", { readOnly: true });

const walks = auth.prepare(`SELECT id, title, visibility, listing_status, snapshot_json, created_at
  FROM user_walks WHERE user_id = 'promo-walks' ORDER BY created_at`).all().map((row) => {
  let snapshot = null;
  try { snapshot = JSON.parse(row.snapshot_json); } catch { /* reported below as an empty walk */ }
  return {
    id: row.id, title: row.title, visibility: row.visibility, listing: row.listing_status,
    createdAt: row.created_at, city: snapshot?.city ?? null,
    broken: snapshot === null,
    stops: (snapshot?.stops ?? []).map((stop) => ({
      placeId: stop.placeId ?? stop.storyRef?.id ?? null,
      address: stop.place?.address ?? null,
      lat: stop.place?.location?.lat ?? null,
      lon: stop.place?.location?.lon ?? null,
    })),
  };
});

// Short stops that rarely carry a walk on their own: a plaque, a grave, an embassy behind a fence.
function minorKind(name, tags) {
  if (["plaque", "stolperstein"].includes(tags.memorial)) return "plaque";
  if (["tomb", "grave"].includes(tags.historic)) return "tomb";
  if (tags.office === "diplomatic" || tags.diplomatic || /^Посольство(\s|$)/u.test(name)) return "embassy";
  return null;
}

// The same selection as listWalkCandidates({published: true}): the latest approved text of each
// live place, with its latest approved audio when one exists.
const places = jobs.prepare(`SELECT p.id, p.name, p.address, p.lat, p.lon, p.tags_json,
    (SELECT approved_story_json FROM place_texts t WHERE t.place_id = p.id AND t.approved_story_json IS NOT NULL
      ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1) story_json,
    (SELECT audio_json FROM place_texts t WHERE t.place_id = p.id AND t.approved_story_json IS NOT NULL
      AND t.audio_json IS NOT NULL AND t.audio_json <> 'null' ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1) audio_json
  FROM places p WHERE p.archived = 0`).all().flatMap((row) => {
  if (!row.story_json) return [];
  let story = null, audio = null, tags = {};
  try { story = JSON.parse(row.story_json); } catch { /* keep the place without a title */ }
  try { tags = JSON.parse(row.tags_json) ?? {}; } catch { /* no kind */ }
  try { audio = row.audio_json ? JSON.parse(row.audio_json) : null; } catch { /* treated as not narrated */ }
  return [{
    id: row.id, name: row.name, address: row.address, lat: row.lat, lon: row.lon,
    storyTitle: story?.title ?? null,
    kind: minorKind(row.name, tags),
    // Spoken words: a non-v4 recording must be re-voiced, and its new length follows the text.
    words: (story?.paragraphs ?? []).reduce((sum, paragraph) => sum + (paragraph?.text?.split(/\s+/).filter(Boolean).length ?? 0), 0),
    audio: audio && Number.isFinite(audio.durationSec) ? {
      sha256: audio.sha256, durationSec: audio.durationSec,
      provider: audio.provider ?? null, model: audio.model ?? null, voice: audio.voice ?? null,
    } : null,
  }];
});

console.log(JSON.stringify({ collectedAt: new Date().toISOString(), walks, places }));
