import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUNDLE_ID, realWords, tokens } from "./build.mjs";

const read = (file) => JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
const bundle = read("changes.json");
const stops = new Set(["teatralnaya", "vdnh"].flatMap((walk) => read(`walk-stops-${walk}.json`).map(({ placeId }) => placeId)));
// The search pattern from the remove-initials skill: «И. С. Кузнецова», «Э.-Р. Нирнзее», «К.С. Станиславского».
const INITIALS = /(?<![А-ЯЁа-яёA-Za-z])[А-ЯЁ][а-яё]?\.(?:\s?-?[А-ЯЁ]\.)*\s?[А-ЯЁ][а-яё]+/u;
// Postal references: «дом 111», «строение 5», «владение 119» and a street name followed by «, 22».
const POSTAL = /(?:(?<![а-яё])дом\s+\d+|(?<![а-яё])строени[еия]\s+\d+|(?<![а-яё])владени[еия]\s+\d+|(?<![а-яё])(?:улиц|переул|проезд|тупик|набережн|вал|проспект)[^.!?]{0,40}?,\s*\d+)/iu;

test("пакет: 38 точек, 27 правок, все остановки прогулок в пакете", () => {
  assert.equal(bundle.id, BUNDLE_ID);
  assert.equal(bundle.entries.length, 38);
  assert.equal(new Set(bundle.entries.map((entry) => entry.placeId)).size, 38);
  assert.equal(bundle.entries.filter((entry) => entry.status === "changed").length, 27);
  for (const placeId of stops) assert.ok(bundle.entries.some((entry) => entry.placeId === placeId), placeId);
});

test("павильон № 70 разобран в 2025 году и в прогулку не входит", () => {
  const pavilion = bundle.entries.find((entry) => entry.placeId === "osm:way:23161470");
  assert.match(pavilion.expected.story.paragraphs.map(({ text }) => text).join(" "), /В 2025 году его разобрали/u);
  assert.ok(!stops.has("osm:way:23161470"));
});

for (const entry of bundle.entries.filter(({ placeId }) => stops.has(placeId))) {
  const story = entry.status === "changed" ? entry.story : entry.expected.story;
  test(`${entry.name}: без инициалов и почтовых справок, от 100 слов, связи фактов целы`, () => {
    const text = story.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
    assert.doesNotMatch(text, INITIALS);
    assert.doesNotMatch(text, POSTAL);
    assert.doesNotMatch(text, /адрес|wikimapia|на снимке|под номером/iu);
    assert.ok(realWords(story.paragraphs) >= 100, `${realWords(story.paragraphs)} слов`);
    const sources = new Set(story.sources.map(({ id }) => id));
    const facts = new Set(story.facts.map(({ id }) => id));
    assert.equal(sources.size, story.sources.length);
    assert.equal(facts.size, story.facts.length);
    for (const fact of story.facts) for (const sourceId of fact.sourceIds) assert.ok(sources.has(sourceId), sourceId);
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
    });
  }
}

test("пример: исходные рассказы содержали инициалы и почтовые адреса", () => {
  const before = (placeId) => bundle.entries.find((entry) => entry.placeId === placeId).expected.story.paragraphs.map(({ text }) => text).join(" ");
  assert.match(before("osm:relation:456961"), INITIALS);
  assert.match(before("osm:relation:1391529"), INITIALS);
  assert.match(before("osm:way:28852219"), POSTAL);
  assert.match(before("osm:relation:18440666"), POSTAL);
});
