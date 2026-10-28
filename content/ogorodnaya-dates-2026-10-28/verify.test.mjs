import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUNDLE_ID, realWords, tokens } from "./build.mjs";

const here = (file) => new URL(`./${file}`, import.meta.url);
const bundle = JSON.parse(readFileSync(here("changes.json"), "utf8"));
const stops = JSON.parse(readFileSync(here("walk-stops-ogorodnaya-sloboda.json"), "utf8")).map(({ placeId }) => placeId);
const counter = new URL("../../.claude/skills/reduce-dates/scripts/count_dates.py", import.meta.url).pathname;
// The skill's own counter, run on the stories as they will be published.
const overloaded = (entries) => execFileSync("python3", ["-I", counter, "/dev/stdin"], {
  input: JSON.stringify(entries.map((entry) => ({ placeId: entry.placeId, name: entry.name, story: entry.story ?? entry.expected.story }))),
  encoding: "utf8", stdio: ["pipe", "pipe", "ignore"] });

test("пакет: все 17 остановок прогулки, 11 рассказов переписаны", () => {
  assert.equal(bundle.id, BUNDLE_ID);
  assert.deepEqual(bundle.entries.map(({ placeId }) => placeId).sort(), [...stops].sort());
  assert.equal(bundle.entries.filter(({ status }) => status === "changed").length, 11);
});

test("до правки скилл находил перегруз датами, после — нет", () => {
  assert.match(overloaded(bundle.entries.map((entry) => ({ ...entry, story: entry.expected.story }))), /Библиотека-читальня/u);
  assert.equal(overloaded(bundle.entries), "");
});

test("общий объём не уменьшился: прогулка держит порог звука", () => {
  const changed = bundle.entries.filter(({ status }) => status === "changed");
  const before = changed.reduce((sum, entry) => sum + realWords(entry.expected.story.paragraphs), 0);
  const after = changed.reduce((sum, entry) => sum + realWords(entry.story.paragraphs), 0);
  assert.ok(after >= before, `${before} → ${after}`);
});

for (const entry of bundle.entries.filter(({ status }) => status === "changed")) {
  test(`${entry.name}: от 100 слов, факты и источники не тронуты, карточка прежняя`, () => {
    const { story, expected } = entry;
    assert.ok(realWords(story.paragraphs) >= 100, `${realWords(story.paragraphs)} слов`);
    assert.deepEqual(story.facts, expected.story.facts);
    assert.deepEqual(story.sources, expected.story.sources);
    assert.deepEqual(story.paragraphs.map(({ factIds }) => factIds), expected.story.paragraphs.map(({ factIds }) => factIds));
    assert.equal(story.title, expected.story.title);
    assert.equal(story.address, expected.story.address);
    assert.equal(story.wordCount, tokens(story.paragraphs));
  });
}

const extend = JSON.parse(readFileSync(here("changes-extend.json"), "utf8"));

test("вторая партия: два рассказа дописаны без новых перегрузов датами, факты со ссылками", () => {
  const changed = extend.entries.filter(({ status }) => status === "changed");
  assert.deepEqual(changed.map(({ placeId }) => placeId).sort(), ["osm:way:53016616", "osm:way:758586236"]);
  assert.equal(overloaded(extend.entries), "");
  for (const { story, expected } of changed) {
    assert.ok(realWords(story.paragraphs) - realWords(expected.story.paragraphs) >= 55);
    const sources = new Set(story.sources.map(({ id }) => id));
    const facts = new Set(story.facts.map(({ id }) => id));
    for (const fact of story.facts) for (const id of fact.sourceIds) assert.ok(sources.has(id), id);
    for (const paragraph of story.paragraphs) for (const id of paragraph.factIds) assert.ok(facts.has(id), id);
  }
});
