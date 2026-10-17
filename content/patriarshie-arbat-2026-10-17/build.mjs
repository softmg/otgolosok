// node build.mjs — builds changes.json (first batch, from captured.json) and walk-changes.json (second batch, from
// captured-walk.json taken after the first one was published) with the editorial edits from edits.mjs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { EDITS, WALK_EDITS } from "./edits.mjs";

export const BUNDLE_ID = "patriarshie-arbat-2026-10-17";
export const WALK_BUNDLE_ID = "patriarshie-arbat-walk-2026-10-17";
const here = (file) => new URL(`./${file}`, import.meta.url);
export const realWords = (paragraphs) => paragraphs.flatMap(({ text }) => text.split(/\s+/u))
  .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
export const tokens = (paragraphs) => paragraphs.flatMap(({ text }) => text.split(/\s+/u)).filter(Boolean).length;

const edit = (story, change) => {
  const next = structuredClone(story);
  for (const [index, paragraph] of Object.entries(change.paragraph ?? {})) {
    assert.ok(next.paragraphs[index], `Нет абзаца ${index}`);
    next.paragraphs[index] = { ...next.paragraphs[index], ...paragraph };
  }
  for (const [from, to] of change.replace ?? []) {
    const found = next.paragraphs.filter((paragraph) => paragraph.text.includes(from));
    assert.equal(found.length, 1, `Фрагмент «${from}» должен быть ровно в одном абзаце`);
    found[0].text = found[0].text.replace(from, to);
  }
  // Inserted paragraphs go after the given original index, last first so earlier indexes stay valid.
  for (const { after, ...paragraph } of [...(change.insert ?? [])].sort((a, b) => b.after - a.after)) {
    assert.ok(next.paragraphs[after], `Нет абзаца ${after}`);
    next.paragraphs.splice(after + 1, 0, paragraph);
  }
  for (const [index, ids] of Object.entries(change.addFactIds ?? {})) {
    next.paragraphs[index].factIds = [...new Set([...next.paragraphs[index].factIds, ...ids])];
  }
  next.facts = [...next.facts, ...(change.facts ?? [])];
  next.sources = [...next.sources, ...(change.sources ?? [])];
  // Facts left without a paragraph (replaced bureaucratic or technical passages) stay as evidence.
  next.wordCount = tokens(next.paragraphs);
  next.verification = "editorial";
  return next;
};

const bundle = (id, capture, edits, { all }) => {
  const used = new Set();
  const entries = capture.places.flatMap((place) => {
    assert.equal(place.textId, place.publishedTextId, `Опубликован не последний текст: ${place.placeId}`);
    const expected = { textId: place.textId, placeContentHash: place.placeContentHash, address: place.address,
      location: place.location, story: place.story, audio: place.audio };
    const change = edits[place.placeId];
    if (!change) return all ? [{ placeId: place.placeId, name: place.name, status: "unchanged", realWords: realWords(place.story.paragraphs), expected }] : [];
    used.add(place.placeId);
    const story = edit(place.story, change);
    return [{ placeId: place.placeId, name: place.name, status: "changed", realWords: realWords(story.paragraphs), expected, story }];
  });
  assert.deepEqual([...used].sort(), Object.keys(edits).sort(), "Правка для точки вне пакета");
  return { id, capturedAt: capture.capturedAt, entries };
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const read = (file) => JSON.parse(readFileSync(here(file), "utf8"));
  const first = bundle(BUNDLE_ID, read("captured.json"), EDITS, { all: true });
  const second = bundle(WALK_BUNDLE_ID, read("captured-walk.json"), WALK_EDITS, { all: false });
  // The second batch extends exactly what the first one published.
  for (const entry of second.entries) {
    const published = first.entries.find((item) => item.placeId === entry.placeId);
    assert.deepEqual(entry.expected.story, published.story ?? published.expected.story, `Текст изменился после первой партии: ${entry.name}`);
  }
  for (const [file, value] of [["changes.json", first], ["walk-changes.json", second]]) {
    writeFileSync(here(file), JSON.stringify(value, null, 2) + "\n");
    console.log(file, value.entries.map((entry) => `${entry.status} ${entry.realWords} ${entry.name}`).join("; "));
  }
}
