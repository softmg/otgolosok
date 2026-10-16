import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const bundle = JSON.parse(readFileSync(new URL("./changes.json", import.meta.url), "utf8"));
const realWords = (paragraphs) => paragraphs.flatMap(({ text }) => text.split(/\s+/u))
  .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
const tokens = (paragraphs) => paragraphs.flatMap(({ text }) => text.split(/\s+/u)).filter(Boolean).length;
// The search pattern from the remove-initials skill: «И. С. Кузнецова», «Э.-Р. Нирнзее», «Ф.Шехтель».
const INITIALS = /(?<![А-ЯЁа-яёA-Za-z])[А-ЯЁ]\.(?:\s?-?[А-ЯЁ]\.)*\s?[А-ЯЁ][а-яё]+/u;
// Postal references: «адрес», «дом 4», «строение 1» and a street name followed by «, 22»; a year after a toponym is not one.
const POSTAL = /(?:адрес|\bдом\s+\d+|\bстроени[еия]\s+\d+|(?:улиц|переул|проезд|тупик|набережн|вал)[^.!?]{0,40}?,\s*\d+)/iu;

test("партия охватывает все места рамки Лефортова", () => {
  assert.equal(bundle.entries.length, 26);
  assert.equal(bundle.entries.filter((entry) => entry.status === "changed").length, 15);
  assert.equal(bundle.withoutStory.length, 46);
  const ids = [...bundle.entries.map((entry) => entry.placeId), ...bundle.withoutStory.map((place) => place.placeId)];
  assert.equal(new Set(ids).size, 72);
});

for (const entry of bundle.entries) {
  const story = entry.status === "changed" ? entry.story : entry.expected.story;
  test(`${entry.name}: без инициалов и почтовых справок, связи фактов целы`, () => {
    const text = story.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
    assert.doesNotMatch(text, INITIALS);
    assert.doesNotMatch(text, POSTAL);
    assert.ok(realWords(story.paragraphs) >= 100, `${realWords(story.paragraphs)} слов`);
    const sources = new Set(story.sources.map(({ id }) => id));
    const facts = new Map(story.facts.map((fact) => [fact.id, fact]));
    assert.equal(sources.size, story.sources.length);
    assert.equal(facts.size, story.facts.length);
    for (const fact of facts.values()) for (const sourceId of fact.sourceIds) assert.ok(sources.has(sourceId), sourceId);
    for (const paragraph of story.paragraphs) {
      assert.ok(paragraph.factIds.length > 0);
      for (const factId of paragraph.factIds) assert.ok(facts.has(factId), factId);
    }
  });
  if (entry.status === "changed") {
    test(`${entry.name}: карточка и заголовок не тронуты, служебные поля обновлены`, () => {
      assert.equal(story.title, entry.expected.story.title);
      assert.equal(story.address, entry.expected.story.address);
      assert.notDeepEqual(story.paragraphs, entry.expected.story.paragraphs);
      assert.equal(story.wordCount, tokens(story.paragraphs));
      assert.equal(story.verification, "editorial");
      assert.notEqual(story.audioDisposition, "not_applicable_short_text");
    });
  }
}

test("пример: исходный рассказ о дворце содержал инициалы и почтовый адрес", () => {
  const palace = bundle.entries.find((entry) => entry.name === "Екатерининский дворец");
  const before = palace.expected.story.paragraphs.map(({ text }) => text).join(" ");
  assert.match(before, INITIALS);
  assert.match(before, POSTAL);
});

const walkBundle = JSON.parse(readFileSync(new URL("./walk-changes.json", import.meta.url), "utf8"));

test("вторая партия дополняет десять рассказов прогулки поверх первой", () => {
  assert.equal(walkBundle.id, "lefortovo-walk-2026-10-16");
  assert.equal(walkBundle.entries.length, 10);
  const cleaned = new Map(bundle.entries.filter((entry) => entry.status === "changed").map((entry) => [entry.placeId, entry.story]));
  for (const entry of walkBundle.entries) {
    // A story edited by the first batch is extended from exactly that published revision.
    if (cleaned.has(entry.placeId)) assert.deepEqual(entry.expected.story.paragraphs, cleaned.get(entry.placeId).paragraphs, entry.name);
    // Every earlier paragraph survives: the second batch only adds text.
    for (const paragraph of entry.expected.story.paragraphs) assert.ok(entry.story.paragraphs.some((next) => next.text === paragraph.text), entry.name);
  }
});

for (const entry of walkBundle.entries) {
  test(`${entry.name}: дополненный рассказ без инициалов и адресов, 140+ слов`, () => {
    const text = entry.story.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
    assert.doesNotMatch(text, INITIALS);
    assert.doesNotMatch(text, POSTAL);
    assert.ok(realWords(entry.story.paragraphs) >= 140, `${realWords(entry.story.paragraphs)} слов`);
    assert.equal(entry.story.wordCount, tokens(entry.story.paragraphs));
    assert.equal(entry.story.title, entry.expected.story.title);
    const facts = new Set(entry.story.facts.map(({ id }) => id));
    const sources = new Set(entry.story.sources.map(({ id }) => id));
    assert.equal(facts.size, entry.story.facts.length);
    for (const fact of entry.story.facts) for (const sourceId of fact.sourceIds) assert.ok(sources.has(sourceId), sourceId);
    for (const paragraph of entry.story.paragraphs) for (const factId of paragraph.factIds) assert.ok(facts.has(factId), factId);
  });
}
