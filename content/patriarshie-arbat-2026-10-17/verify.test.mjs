import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { BUNDLE_ID, WALK_BUNDLE_ID, realWords, tokens } from "./build.mjs";

const read = (file) => JSON.parse(readFileSync(new URL(`./${file}`, import.meta.url), "utf8"));
const bundle = read("changes.json");
const walkBundle = read("walk-changes.json");
// The search pattern from the remove-initials skill: «И. С. Кузнецова», «Э.-Р. Нирнзее», «Ф.Шехтель».
const INITIALS = /(?<![А-ЯЁа-яёA-Za-z])[А-ЯЁ]\.(?:\s?-?[А-ЯЁ]\.)*\s?[А-ЯЁ][а-яё]+/u;
// Postal references: «дом 4», «строение 1» and a street name followed by «, 22». The word «адрес» is checked by hand:
// «пошла по другому адресу» (сквер Булгакова) and «не его московскому адресу» (стена Цоя) are figurative.
const POSTAL = /(?:(?<![а-яё])дом\s+\d+|(?<![а-яё])строени[еия]\s+\d+|(?<![а-яё])(?:улиц|переул|проезд|тупик|набережн|вал)[^.!?]{0,40}?,\s*\d+)/iu;
const FIGURATIVE_ADDRESS = ["пошла по другому адресу", "не его московскому адресу"];

test("пакет: 38 остановок двух прогулок, 10 правок", () => {
  assert.equal(bundle.id, BUNDLE_ID);
  assert.equal(bundle.entries.length, 38);
  assert.equal(new Set(bundle.entries.map((entry) => entry.placeId)).size, 38);
  assert.equal(bundle.entries.filter((entry) => entry.status === "changed").length, 10);
});

for (const entry of [...bundle.entries, ...walkBundle.entries]) {
  const story = entry.status === "changed" ? entry.story : entry.expected.story;
  test(`${entry.name}: без инициалов и почтовых справок, от 100 слов, связи фактов целы`, () => {
    const text = story.paragraphs.map(({ text: paragraph }) => paragraph).join(" ");
    assert.doesNotMatch(text, INITIALS);
    assert.doesNotMatch(text, POSTAL);
    for (const match of text.matchAll(/адрес[а-я]*/giu)) {
      assert.ok(FIGURATIVE_ADDRESS.some((phrase) => text.includes(phrase)), `«${match[0]}» в ${entry.name}`);
    }
    assert.doesNotMatch(text, /wikimapia|на снимке/iu);
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

test("пример: исходные рассказы содержали инициалы и ссылку на Wikimapia", () => {
  const before = (name) => bundle.entries.find((entry) => entry.name === name).expected.story.paragraphs.map(({ text }) => text).join(" ");
  assert.match(before("Центральный дом архитектора"), INITIALS);
  assert.match(before("Садовый павильон с садом"), /Wikimapia/u);
});

test("вторая партия дополняет три рассказа поверх первой, не теряя ни одного абзаца", () => {
  assert.equal(walkBundle.id, WALK_BUNDLE_ID);
  assert.deepEqual(walkBundle.entries.map((entry) => entry.name).sort(), ["Патриаршие пруды", "Театр им. Евгения Вахтангова", "Центральный дом архитектора"]);
  for (const entry of walkBundle.entries) {
    const first = bundle.entries.find((item) => item.placeId === entry.placeId);
    assert.deepEqual(entry.expected.story, first.story ?? first.expected.story, entry.name);
    for (const paragraph of entry.expected.story.paragraphs) assert.ok(entry.story.paragraphs.some((next) => next.text === paragraph.text), entry.name);
    assert.equal(entry.story.paragraphs.length, entry.expected.story.paragraphs.length + 1, entry.name);
  }
});
