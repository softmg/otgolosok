import test from "node:test";
import assert from "node:assert/strict";
import { createAudioTagger, plainNarration, validateTaggedNarration } from "./audio-tags.mjs";

const original = "Памятник Гаазу. «Спешите делать добро». Этот девиз высечен на постаменте.\n\nРядом стоит музей-квартира Васнецова.";

test("accepts allowed tags that leave every word, mark and paragraph in place", () => {
  const tagged = "[warmly] Памятник Гаазу. [short pause] «[softly] Спешите делать добро». [long pause] Этот девиз высечен на постаменте.\n\n[storytelling]  Рядом стоит музей-квартира Васнецова.";
  assert.equal(validateTaggedNarration(original, tagged),
    "[warmly] Памятник Гаазу. [short pause] «[softly] Спешите делать добро». [long pause] Этот девиз высечен на постаменте.\n\n[storytelling] Рядом стоит музей-квартира Васнецова.");
  assert.match(validateTaggedNarration(original, "```\n[Warmly] " + original + "\n```"), /^\[Warmly\] Памятник/);
  assert.equal(validateTaggedNarration(original, `[curious] ${original.replace("Гаазу.", "Гаазу.[short pause]")}`).includes("Гаазу.[short pause] «"), true);
});

test("rejects answers that change the narration or misuse tags", () => {
  const cases = [
    ["no tags", original, "AUDIO_TAGS_INVALID"],
    ["unknown tag", `[laughs] ${original}`, "AUDIO_TAGS_INVALID"],
    ["sound effect", `[warmly] ${original} [applause]`, "AUDIO_TAGS_INVALID"],
    ["unclosed bracket", `[warmly] ${original} [pause`, "AUDIO_TAGS_INVALID"],
    ["too many tags", `[warmly] ${original.split(" ").join(" [short pause] ")}`, "AUDIO_TAGS_INVALID"],
    ["changed word", `[warmly] ${original.replace("Гаазу", "Гаазу Фёдору")}`, "AUDIO_TAGS_CHANGED_TEXT"],
    ["dropped punctuation", `[warmly] ${original.replace("постаменте.", "постаменте")}`, "AUDIO_TAGS_CHANGED_TEXT"],
    ["merged paragraphs", `[warmly] ${original.replace("\n\n", " ")}`, "AUDIO_TAGS_CHANGED_TEXT"],
    ["glued words", `[warmly] ${original.replace("Памятник Гаазу", "Памятник[short pause]Гаазу")}`, "AUDIO_TAGS_CHANGED_TEXT"],
  ];
  for (const [name, tagged, code] of cases) assert.throws(() => validateTaggedNarration(original, tagged), { code }, name);
});

test("narration brackets become parentheses so they are not read as tags", () => {
  assert.equal(plainNarration("Дом [снесён] в 1930-х"), "Дом (снесён) в 1930-х");
});

test("the tagger retries one invalid answer and never returns a rewritten text", async () => {
  const prompts = [];
  const answers = ["Совсем другой текст.", "[warmly] Дом (снесён)."];
  const tagger = createAudioTagger({ writerModel: "writer", response: async (prompt, options) => {
    prompts.push({ prompt, model: options.model }); return { text: answers.shift() };
  } });
  assert.equal(await tagger("Дом [снесён]."), "[warmly] Дом (снесён).");
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].model, "writer");
  assert.match(prompts[0].prompt, /Дом \(снесён\)\./);

  const stubborn = createAudioTagger({ response: async () => ({ text: "[laughs] Дом." }) });
  await assert.rejects(stubborn("Дом."), { code: "AUDIO_TAGS_INVALID" });
});
