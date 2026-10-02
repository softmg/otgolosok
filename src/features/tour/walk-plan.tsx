import { distanceMeters } from "@/lib/geo/distance";
import type { TriggerConfig } from "@/lib/geo/types";
import type { Coordinates, HistoricalContent, Route, WalkStep } from "./types";

export type WalkChapter = WalkStep & { content: HistoricalContent; status?: WalkStep["status"] };

/**
 * Where the walk listens next. Each chapter belongs to the stop it describes, so
 * arriving at the following stop is what should start the following chapter.
 * The last chapter has nothing left to trigger and falls back to the finish.
 */
export function nextChapterTarget(chapters: WalkChapter[], index: number, fallback: Coordinates): Coordinates {
  const next = chapters[index + 1];
  return next?.trigger_location ?? next?.location ?? fallback;
}

function triggerConfigOf(step: WalkChapter | undefined, fallback: TriggerConfig): TriggerConfig {
  const trigger = step?.trigger;
  return trigger
    ? { enterM: trigger.enter_m, exitM: trigger.exit_m, minFixes: trigger.min_fixes, windowSize: fallback.windowSize, maxAccuracyM: trigger.max_accuracy_m }
    : fallback;
}

export function chapterTriggerConfig(chapters: WalkChapter[], index: number, fallback: TriggerConfig): TriggerConfig {
  return triggerConfigOf(chapters[index + 1], fallback);
}

/**
 * Where a universal walk stands at chapter `index`: on the way to its stop, its
 * story not started yet ("approach"), or arrived there ("stop").
 */
export type StopStage = "approach" | "stop";

/** On the way to a stop the walk listens for that stop; after arriving, for the next one. */
export function arrivalTarget(chapters: WalkChapter[], index: number, stage: StopStage, fallback: Coordinates): Coordinates {
  if (stage === "stop") return nextChapterTarget(chapters, index, fallback);
  const step = chapters[index];
  return step?.trigger_location ?? step?.location ?? fallback;
}

export function arrivalTriggerConfig(chapters: WalkChapter[], index: number, stage: StopStage, fallback: TriggerConfig): TriggerConfig {
  return stage === "stop" ? chapterTriggerConfig(chapters, index, fallback) : triggerConfigOf(chapters[index], fallback);
}

/**
 * The leg the walker should walk now (see legRange): the leg into the stop on the
 * way to it, the leg out of it after arriving; after the last stop, the leg to the finish.
 * Index `chapterCount` at "approach" is the way to the finish itself (see hasFinishLeg).
 */
export function highlightedLeg(index: number, stage: StopStage, chapterCount: number): number {
  if (chapterCount === 0) return 0;
  return stage === "approach" ? Math.min(index, chapterCount) : Math.min(index + 1, chapterCount);
}

/**
 * Whether the walk still goes on after the last stop: its finish lies outside the
 * last stop's arrival radius (a loop back to the start, a chosen destination).
 * Then the walk has one more step, index `chapters.length`, on the way to the finish.
 */
export function hasFinishLeg(chapters: WalkChapter[], finish: Coordinates, fallbackEnterM: number): boolean {
  const last = chapters.at(-1);
  if (!last) return false;
  return distanceMeters(last.trigger_location ?? last.location, finish) > (last.trigger?.enter_m ?? fallbackEnterM);
}

export function getWalkChapters(route: Route, includePending = false): WalkChapter[] {
  const contentById = new Map([...route.pois, ...(route.notes ?? [])].map((content) => [content.id, content]));
  return (route.walk?.steps ?? []).flatMap((step) => {
    const content = contentById.get(step.content_id);
    return content && (includePending || content.story.text_status === "ready") ? [{ ...step, content }] : [];
  });
}
