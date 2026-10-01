export const REVIEW_TEXT_MAX = 1000;

export type ReviewTarget = { kind: "catalog"; id: string } | { kind: "share"; token: string } | { kind: "account"; id: string };
export type ReviewStatus = "pending" | "published" | "hidden";
export type ReviewSummary = { average: number | null; count: number };
export type PublicReview = { id: string; author: string; rating: number; text: string; createdAt: string };
export type MyReview = { rating: number; text: string; status: ReviewStatus; updatedAt: string };
export type ReviewPage = { summary: ReviewSummary; reviews: PublicReview[]; nextCursor: string | null; mine: MyReview | null };
export type ReviewWrite = { summary: ReviewSummary; mine: MyReview | null };
export type ReviewInput = { rating: number; text: string };

export function reviewsPath(target: ReviewTarget) {
  if (target.kind === "catalog") return `/api/story-walks/${encodeURIComponent(target.id)}/reviews`;
  if (target.kind === "share") return `/api/story-walks/shared/${encodeURIComponent(target.token)}/reviews`;
  return `/api/me/walks/${encodeURIComponent(target.id)}/reviews`;
}

export function targetKey(target: ReviewTarget) {
  return target.kind === "share" ? `share:${target.token}` : `${target.kind}:${target.id}`;
}

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Ожидался объект.");
  return value as Record<string, unknown>;
};
const string = (value: unknown) => { if (typeof value !== "string") throw new TypeError("Ожидалась строка."); return value; };
const rating = (value: unknown) => { if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 5) throw new TypeError("Неверная оценка."); return value as number; };

function validateSummary(value: unknown): ReviewSummary {
  const item = record(value);
  if (!Number.isSafeInteger(item.count) || (item.count as number) < 0) throw new TypeError("Неверное число оценок.");
  const count = item.count as number;
  if (count === 0 ? item.average !== null : typeof item.average !== "number" || item.average < 1 || item.average > 5) throw new TypeError("Неверная средняя оценка.");
  return { average: item.average as number | null, count };
}

function validateMine(value: unknown): MyReview | null {
  if (value === null) return null;
  const item = record(value);
  if (!["pending", "published", "hidden"].includes(item.status as string)) throw new TypeError("Неверный статус отзыва.");
  return { rating: rating(item.rating), text: string(item.text), status: item.status as ReviewStatus, updatedAt: string(item.updatedAt) };
}

export function validateReviewPage(value: unknown): ReviewPage {
  const page = record(value);
  if (!Array.isArray(page.reviews)) throw new TypeError("Ожидался список отзывов.");
  if (page.nextCursor !== null && typeof page.nextCursor !== "string") throw new TypeError("Неверный курсор.");
  return {
    summary: validateSummary(page.summary),
    reviews: page.reviews.map(raw => {
      const item = record(raw);
      return { id: string(item.id), author: string(item.author), rating: rating(item.rating), text: string(item.text), createdAt: string(item.createdAt) };
    }),
    nextCursor: page.nextCursor as string | null,
    mine: validateMine(page.mine),
  };
}

export function validateReviewWrite(value: unknown): ReviewWrite {
  const item = record(value);
  return { summary: validateSummary(item.summary), mine: validateMine(item.mine) };
}

const plural = new Intl.PluralRules("ru");
const ratingWords: Record<string, string> = { one: "оценка", few: "оценки", many: "оценок", other: "оценки" };

export function ratingCountLabel(count: number) {
  return `${count} ${ratingWords[plural.select(count)]}`;
}

/** «★ 4,6 · 12 оценок», or "" while there is nothing to show. */
export function formatRatingSummary(summary: ReviewSummary | null) {
  if (!summary || summary.count === 0 || summary.average === null) return "";
  const average = summary.average.toLocaleString("ru-RU", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `★ ${average} · ${ratingCountLabel(summary.count)}`;
}
