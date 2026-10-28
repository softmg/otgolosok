import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUNDLE_ID, OGORODNAYA_BUNDLE_ID, realWords, tokens } from "./build.mjs";

const read = (file) => JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
const WALKS = ["bryusov-nikitskaya", "ivanovskaya-gorka", "tatarskaya-sloboda", "ogorodnaya-sloboda"];
const bundle = read("changes.json");
const ogorodnaya = read("changes-ogorodnaya.json");
const entries = [...bundle.entries, ...ogorodnaya.entries];
const stops = new Set(WALKS.flatMap((walk) => read(`walk-stops-${walk}.json`).map(({ placeId }) => placeId)));
// The search pattern from the remove-initials skill: «И. С. Кузнецова», «Э.-Р. Нирнзее», «К.С. Станиславского».
const INITIALS = /(?<![А-ЯЁа-яёA-Za-z])[А-ЯЁ][а-яё]?\.(?:\s?-?[А-ЯЁ]\.)*\s?[А-ЯЁ][а-яё]+/u;
// Postal references: «дом 111», «строение 5», «владение 119» and a street name followed by «, 22».
const POSTAL = /(?:(?<![а-яё])дом\s+\d+|(?<![а-яё])строени[еия]\s+\d+|(?<![а-яё])владени[еия]\s+\d+|(?<![а-яё])(?:улиц|переул|проезд|тупик|набережн|вал|проспект)[^.!?]{0,40}?,\s*\d+)/iu;
// Third-party sources named in the spoken text instead of the sources field.
const SOURCE_MENTION = /адрес|wikimapia|на снимке|под номером|на сайте|по данным|учётн\S* карточк|городскому описанию|в рассказе|в интервью/iu;

// Stops of the first draft that were dropped for lack of a free photo of the object itself (see README.md).
const NO_PHOTO = ["osm:node:2594758089", "osm:node:11323317893", "osm:node:2510079135", "osm:node:5083895950", "osm:relation:7997754",
  "osm:relation:7400861", "osm:node:5218469188", "osm:node:12474542766", "osm:way:36358910", "osm:node:3503058809", "osm:node:2868787302"];

test("пакет: 75 точек черновика и 6 добавленных, 17 и 3 правки; в прогулках 69 остановок, точки без фото исключены", () => {
  assert.equal(bundle.id, BUNDLE_ID);
  assert.equal(ogorodnaya.id, OGORODNAYA_BUNDLE_ID);
  assert.equal(bundle.entries.length, 75);
  assert.equal(ogorodnaya.entries.length, 6);
  assert.equal(bundle.entries.filter((entry) => entry.status === "changed").length, 17);
  assert.equal(ogorodnaya.entries.filter((entry) => entry.status === "changed").length, 3);
  assert.equal(stops.size, 69);
  const drafted = new Set(entries.map((entry) => entry.placeId));
  assert.equal(drafted.size, 81);
  for (const placeId of stops) assert.ok(drafted.has(placeId), placeId);
  for (const placeId of NO_PHOTO) assert.ok(drafted.has(placeId) && !stops.has(placeId), placeId);
});

test("у каждой остановки есть подпись, адрес и координаты", () => {
  for (const walk of WALKS) for (const stop of read(`walk-stops-${walk}.json`)) {
    assert.ok(stop.label.trim() && stop.address.startsWith("Москва, "), stop.placeId);
    assert.ok(Number.isFinite(stop.location.lat) && Number.isFinite(stop.location.lon), stop.placeId);
  }
});

for (const entry of entries.filter(({ placeId }) => stops.has(placeId))) {
  const story = entry.status === "changed" ? entry.story : entry.expected.story;
  test(`${entry.name}: без инициалов, почтовых справок и упоминаний источников, от 100 слов, связи фактов целы`, () => {
    const text = story.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
    assert.doesNotMatch(text, INITIALS);
    assert.doesNotMatch(text, POSTAL);
    assert.doesNotMatch(text, SOURCE_MENTION);
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

test("пример: исходные рассказы содержали инициалы и ссылки на источники", () => {
  const before = (placeId) => entries.find((entry) => entry.placeId === placeId).expected.story.paragraphs.map(({ text }) => text).join(" ");
  assert.match(before("osm:relation:8888875"), INITIALS);
  assert.match(before("osm:way:52132608"), SOURCE_MENTION);
  assert.match(before("osm:node:10015992717"), SOURCE_MENTION);
  assert.match(before("osm:node:1106845052"), INITIALS);
  assert.match(before("osm:way:484755695"), SOURCE_MENTION);
  assert.ok(realWords(bundle.entries.find((entry) => entry.placeId === "osm:node:1855700832").expected.story.paragraphs) < 100);
});
