// node build.mjs — builds changes.json from captured.json with the editorial edits from edits.mjs.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { EDITS } from "./edits.mjs";

export const BUNDLE_ID = "garden-promo-walks-2026-10-28";
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
  // addFactIds indexes refer to the paragraphs after insertion.
  for (const [index, ids] of Object.entries(change.addFactIds ?? {})) {
    assert.ok(next.paragraphs[index], `Нет абзаца ${index}`);
    next.paragraphs[index].factIds = [...new Set([...next.paragraphs[index].factIds, ...ids])];
  }
  next.facts = [...next.facts, ...(change.facts ?? [])];
  next.sources = [...next.sources, ...(change.sources ?? [])];
  // Facts left without a paragraph (removed postal references) stay as evidence.
  next.wordCount = tokens(next.paragraphs);
  next.verification = "editorial";
  return next;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const capture = JSON.parse(readFileSync(here("captured.json"), "utf8"));
  const used = new Set();
  const entries = capture.places.map((place) => {
    assert.equal(place.textId, place.publishedTextId, `Опубликован не последний текст: ${place.placeId}`);
    const expected = { textId: place.textId, placeContentHash: place.placeContentHash, address: place.address,
      location: place.location, story: place.story, audio: place.audio };
    const change = EDITS[place.placeId];
    if (!change) return { placeId: place.placeId, name: place.name, status: "unchanged", realWords: realWords(place.story.paragraphs), expected };
    used.add(place.placeId);
    const story = edit(place.story, change);
    return { placeId: place.placeId, name: place.name, status: "changed", realWords: realWords(story.paragraphs), expected, story };
  });
  assert.deepEqual([...used].sort(), Object.keys(EDITS).sort(), "Правка для точки вне пакета");
  const bundle = { id: BUNDLE_ID, capturedAt: capture.capturedAt, entries };
  writeFileSync(here("changes.json"), JSON.stringify(bundle, null, 2) + "\n");
  console.log(entries.map((entry) => `${entry.status} ${entry.realWords} ${entry.name}`).join("\n"));
}
