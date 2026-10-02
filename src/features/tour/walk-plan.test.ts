import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import routeData from "../../../public/data/routes/paveletskaya.json";
import { arrivalTarget, arrivalTriggerConfig, chapterTriggerConfig, getWalkChapters, hasFinishLeg, highlightedLeg, nextChapterTarget } from "./walk-plan";
import type { Route } from "./types";

const route = routeData as Route;
const walk = route.walk!;

describe("The short walk", () => {
  it("resolves all four chapters once, in walking order", () => {
    const chapters = getWalkChapters(route);
    expect(chapters).toHaveLength(walk.steps.length);
    expect(chapters.map((chapter) => chapter.id)).toEqual(["kozhevniki", "derbenevskaya", "housing", "zindel"]);
    expect(new Set(chapters.map((chapter) => chapter.content_id)).size).toBe(4);
    expect(chapters.at(-1)?.content).toBe(route.pois[0]);
  });

  it("counts transitions within the one-minute note budget", () => {
    for (const chapter of getWalkChapters(route)) {
      const text = [...chapter.content.story.paragraphs.map((paragraph) => paragraph.text), chapter.transition, chapter.next_hint].join(" ");
      const isNote = route.notes!.some((note) => note.id === chapter.content_id);
      expect(text.trim().split(/\s+/).length).toBeLessThanOrEqual(isNote ? 110 : 240);
      expect(chapter.duration_sec).toBeGreaterThan(0);
      expect(chapter.duration_sec).toBeLessThanOrEqual(isNote ? 60 : 120);
    }
  });

  it("keeps the requested buildings and the pedestrian route explicit", () => {
    expect(walk.start.address).toBe("2-й Кожевнический переулок, 12с10");
    expect(walk.finish.address).toBe("Дербеневская набережная, 7с22");
    expect(walk.path.costing).toBe("pedestrian");
    expect(walk.path.coordinates.length).toBeGreaterThan(20);
    expect(walk.field_checked).toBe(false);
    expect(route.distance_km * 1000).toBe(walk.distance_m);
  });

  it("ships a distinct, complete recording matching each visible chapter and its transitions", () => {
    const chapters = getWalkChapters(route);
    expect(new Set(chapters.map((chapter) => chapter.audio?.url)).size).toBe(4);
    for (const chapter of chapters) {
      const audio = chapter.audio!;
      expect(audio, chapter.id).toBeDefined();
      expect(audio.url).toMatch(/^\/audio\/walk\/[a-z0-9-]+\.mp3$/);
      const bytes = readFileSync(resolve("public", audio.url.slice(1)));
      expect(bytes.byteLength).toBeGreaterThan(100_000);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(audio.audio_sha256);
      const text = [chapter.transition, ...chapter.content.story.paragraphs.map((paragraph) => paragraph.text), chapter.next_hint].filter(Boolean).join("\n\n");
      expect(createHash("sha256").update(text).digest("hex"), `${chapter.id}: regenerate audio after editing the narrative`).toBe(audio.script_sha256);
      expect(audio.synthetic).toBe(true);
      expect(audio.duration_sec).toBeGreaterThan(30);
      expect(audio.duration_sec).toBeLessThanOrEqual(chapter.id === "zindel" ? 120 : 60);
      expect(chapter.duration_sec).toBe(Math.ceil(audio.duration_sec));
    }
  });
});

describe("Chapter triggers", () => {
  const chapters = getWalkChapters(route);
  const fallback = { enterM: 35, exitM: 60, minFixes: 3, windowSize: 5, maxAccuracyM: 50 };
  const finish = walk.finish.location;

  it("listens for the stop of the chapter that plays next", () => {
    for (let index = 0; index < chapters.length - 1; index += 1) {
      const next = chapters[index + 1];
      expect(nextChapterTarget(chapters, index, finish)).toEqual(next.trigger_location ?? next.location);
    }
  });

  it("listens from the street for a stop set back from the route", () => {
    const housing = chapters.findIndex((chapter) => chapter.id === "housing");
    expect(chapters[housing].trigger_location).toBeDefined();
    expect(nextChapterTarget(chapters, housing - 1, finish)).toEqual(chapters[housing].trigger_location);
    expect(nextChapterTarget(chapters, housing - 1, finish)).not.toEqual(chapters[housing].location);
  });

  it("falls back to the finish on the last chapter and outside the walk", () => {
    expect(nextChapterTarget(chapters, chapters.length - 1, finish)).toEqual(finish);
    expect(nextChapterTarget([], 0, finish)).toEqual(finish);
  });

  it("uses the shared trigger until a stop is checked on the ground", () => {
    expect(chapterTriggerConfig(chapters, 0, fallback)).toBe(fallback);
  });

  it("prefers a field-checked trigger declared on the next stop", () => {
    const checked = [chapters[0], { ...chapters[1], trigger: { enter_m: 20, exit_m: 45, min_fixes: 4, max_accuracy_m: 25 } }];
    expect(chapterTriggerConfig(checked, 0, fallback)).toEqual({ enterM: 20, exitM: 45, minFixes: 4, windowSize: 5, maxAccuracyM: 25 });
  });
});

describe("Walking to a stop before its story", () => {
  const chapters = getWalkChapters(route);
  const fallback = { enterM: 35, exitM: 60, minFixes: 3, windowSize: 5, maxAccuracyM: 50 };
  const finish = walk.finish.location;
  const stopPoint = (index: number) => chapters[index].trigger_location ?? chapters[index].location;
  const checked = { enter_m: 20, exit_m: 45, min_fixes: 4, max_accuracy_m: 25 };

  it.each([
    { name: "on the way to the first stop", index: 0, stage: "approach" as const, expected: () => stopPoint(0) },
    { name: "at the first stop", index: 0, stage: "stop" as const, expected: () => stopPoint(1) },
    { name: "on the way to the last stop", index: 3, stage: "approach" as const, expected: () => stopPoint(3) },
    { name: "at the last stop", index: 3, stage: "stop" as const, expected: () => finish },
  ])("listens $name", ({ index, stage, expected }) => {
    expect(arrivalTarget(chapters, index, stage, finish)).toEqual(expected());
  });

  it("falls back to the finish without chapters", () => {
    expect(arrivalTarget([], 0, "approach", finish)).toEqual(finish);
    expect(arrivalTriggerConfig([], 0, "approach", fallback)).toBe(fallback);
  });

  it("uses the trigger of the stop it listens for", () => {
    const withTrigger = [{ ...chapters[0], trigger: checked }, chapters[1]];
    const expected = { enterM: 20, exitM: 45, minFixes: 4, windowSize: 5, maxAccuracyM: 25 };
    expect(arrivalTriggerConfig(withTrigger, 0, "approach", fallback)).toEqual(expected);
    expect(arrivalTriggerConfig(withTrigger, 0, "stop", fallback)).toBe(fallback);
    expect(arrivalTriggerConfig([chapters[0], { ...chapters[1], trigger: checked }], 0, "stop", fallback)).toEqual(expected);
  });

  it.each([
    { index: 0, stage: "approach" as const, count: 4, leg: 0 },
    { index: 0, stage: "stop" as const, count: 4, leg: 1 },
    { index: 2, stage: "approach" as const, count: 4, leg: 2 },
    { index: 3, stage: "stop" as const, count: 4, leg: 4 },
    { index: 4, stage: "approach" as const, count: 4, leg: 4 },
    { index: 0, stage: "approach" as const, count: 0, leg: 0 },
    { index: 0, stage: "stop" as const, count: 0, leg: 0 },
  ])("highlights leg $leg at chapter $index ($stage) of $count", ({ index, stage, count, leg }) => {
    expect(highlightedLeg(index, stage, count)).toBe(leg);
  });

  it.each([
    { name: "far from the last stop", finish: () => ({ lat: stopPoint(3).lat + 0.01, lon: stopPoint(3).lon }), expected: true },
    { name: "at the last stop", finish: () => stopPoint(3), expected: false },
    { name: "within the arrival radius", finish: () => ({ lat: stopPoint(3).lat + 0.0001, lon: stopPoint(3).lon }), expected: false },
  ])("goes on to a finish $name: $expected", ({ finish: target, expected }) => {
    expect(hasFinishLeg(chapters, target(), 30)).toBe(expected);
  });

  it("measures the finish against the last stop's own arrival radius", () => {
    // About 33 m north of the last stop.
    const near = { lat: stopPoint(3).lat + 0.0003, lon: stopPoint(3).lon };
    expect(hasFinishLeg(chapters.map((item, i) => i === 3 ? { ...item, trigger: { ...checked, enter_m: 20 } } : item), near, 60)).toBe(true);
    expect(hasFinishLeg(chapters, near, 60)).toBe(false);
  });

  it("has no finish leg without stops", () => {
    expect(hasFinishLeg([], { lat: 55.74, lon: 37.64 }, 30)).toBe(false);
  });
});
