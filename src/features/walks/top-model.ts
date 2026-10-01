import type { ReviewSummary } from "../reviews/model";

/** One entry of the public «Топ прогулок»: no launch counts and no author by design. */
export type TopWalk = {
  kind: "catalog" | "shared";
  /** Catalog slug or share token. */
  id: string;
  title: string;
  walkingMinutes: number;
  distanceM: number;
  stopCount: number;
  rating: ReviewSummary;
};

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Ожидался объект.");
  return value as Record<string, unknown>;
};
const positive = (value: unknown) => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new TypeError("Ожидалось положительное число.");
  return value;
};

function validateTopWalk(raw: unknown): TopWalk {
  const item = record(raw);
  if (item.kind !== "catalog" && item.kind !== "shared") throw new TypeError("Неверный вид прогулки.");
  const id = item.id;
  if (typeof id !== "string" || !(item.kind === "catalog" ? /^[a-z0-9][a-z0-9-]{0,127}$/ : /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/).test(id))
    throw new TypeError("Неверный идентификатор прогулки.");
  if (typeof item.title !== "string" || !item.title.trim()) throw new TypeError("Нет названия прогулки.");
  if (!Number.isSafeInteger(item.stopCount) || (item.stopCount as number) < 0) throw new TypeError("Неверное число историй.");
  const rating = record(item.rating);
  if (!Number.isSafeInteger(rating.count) || (rating.count as number) < 0) throw new TypeError("Неверное число оценок.");
  const count = rating.count as number;
  if (count === 0 ? rating.average !== null : typeof rating.average !== "number" || rating.average < 1 || rating.average > 5) throw new TypeError("Неверная средняя оценка.");
  return {
    kind: item.kind, id, title: item.title,
    walkingMinutes: positive(item.walkingMinutes), distanceM: positive(item.distanceM), stopCount: item.stopCount as number,
    rating: { average: rating.average as number | null, count },
  };
}

export function validateTopWalks(value: unknown): TopWalk[] {
  const walks = record(value).walks;
  if (!Array.isArray(walks)) throw new TypeError("Ожидался список прогулок.");
  return walks.map(validateTopWalk);
}

export function topWalkHref(walk: Pick<TopWalk, "kind" | "id">) {
  return walk.kind === "catalog" ? `/walk?catalog=${encodeURIComponent(walk.id)}` : `/walk?share=${encodeURIComponent(walk.id)}`;
}

const plural = new Intl.PluralRules("ru");
const storyWords: Record<string, string> = { one: "история", few: "истории", many: "историй", other: "истории" };

export function storyCountLabel(count: number) {
  return `${count} ${storyWords[plural.select(count)]}`;
}

/** «45 мин · 3,2 км · 6 историй». */
export function formatTopWalkMeta(walk: Pick<TopWalk, "walkingMinutes" | "distanceM" | "stopCount">) {
  const km = (walk.distanceM / 1000).toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${Math.round(walk.walkingMinutes)} мин · ${km} км · ${storyCountLabel(walk.stopCount)}`;
}
