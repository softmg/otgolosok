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

export function chapterTriggerConfig(chapters: WalkChapter[], index: number, fallback: TriggerConfig): TriggerConfig {
  const trigger = chapters[index + 1]?.trigger;
  return trigger
    ? { enterM: trigger.enter_m, exitM: trigger.exit_m, minFixes: trigger.min_fixes, windowSize: fallback.windowSize, maxAccuracyM: trigger.max_accuracy_m }
    : fallback;
}

export function getWalkChapters(route: Route, includePending = false): WalkChapter[] {
  const contentById = new Map([...route.pois, ...(route.notes ?? [])].map((content) => [content.id, content]));
  return (route.walk?.steps ?? []).flatMap((step) => {
    const content = contentById.get(step.content_id);
    return content && (includePending || content.story.text_status === "ready") ? [{ ...step, content }] : [];
  });
}

export function WalkPlanPreview({ chapters }: { chapters: WalkChapter[] }) {
  if (chapters.length === 0) return null;
  const hasAudio = chapters.every((chapter) => chapter.audio?.url);
  const count = chapters.length;
  const noun = count % 10 === 1 && count % 100 !== 11 ? "история" : count % 10 >= 2 && count % 10 <= 4 && (count % 100 < 10 || count % 100 >= 20) ? "истории" : "историй";
  return <section className="walk-plan" id="walk-plan" aria-labelledby="walk-plan-title">
    <p className="kicker">Маршрут и остановки</p>
    <h2 id="walk-plan-title">Одна прогулка, {count} {noun}</h2>
    <p className="walk-plan-intro">Начните прогулку, чтобы {hasAudio ? "слушать" : "читать"} рассказы по порядку. Между частями есть переходы; двигаться дальше можно в своём темпе.</p>
    <ol className="walk-plan-steps">
      {chapters.map((chapter, index) => <li key={chapter.id}>
        <span className="walk-plan-index" aria-hidden="true">{index + 1}</span>
        <div><h3>{chapter.title}</h3><p>{chapter.place}</p></div>
        <span className="walk-plan-duration">{chapter.audio ? "" : "≈ "}{chapter.duration_sec} сек</span>
      </li>)}
    </ol>
    <p className="walk-plan-intro">{hasAudio ? `${count} ${noun} с озвучкой. «Дальше» включает следующую часть; текст и источники остаются под рукой.` : "Пока доступен текст. Части переключаются вручную, озвучка готовится."}</p>
  </section>;
}
