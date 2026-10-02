import { routeShortfall } from "../walk-builder/model";
import type { WalkView } from "./model";

/** What the walk page adds for the viewer's own walk: the way back to the builder and its notes. */
export type OwnWalk = { editHref: string; notes: string[] };

const plural = new Intl.PluralRules("ru");

/** The builder of a walk saved on this device (`local`) or in the viewer's account (`id`). */
export function ownWalkEditHref(kind: "local" | "id", id: string) {
  return `/?${new URLSearchParams({ walk: "create", [kind]: id, edit: "1" })}`;
}

/** Builder results the walk page keeps showing: a short automatic walk and stops without a story. */
export function ownWalkNotes(view: WalkView): string[] {
  const { document } = view;
  const notes: string[] = [];
  const shortfall = document.route && !document.destination ? routeShortfall(document.route, document.minutes) : null;
  if (shortfall !== null) notes.push(`Рядом нашлось мест только на ${shortfall} мин из ${document.minutes}. Измените начало прогулки.`);
  const missing = view.chapters.filter(chapter => chapter.status === "not_requested").length;
  if (missing) notes.push(`У ${missing} ${plural.select(missing) === "one" ? "остановки" : "остановок"} пока нет истории.`);
  return notes;
}
