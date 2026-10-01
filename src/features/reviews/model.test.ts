import { describe, expect, it } from "vitest";
import { formatRatingSummary, ratingCountLabel, reviewsPath, targetKey, validateReviewPage, validateReviewWrite } from "./model";

const valid = {
  summary: { average: 4.6, count: 12 },
  reviews: [{ id: "r1", author: "Анна", rating: 5, text: "Хорошо", createdAt: "2026-10-01T10:00:00Z" }],
  nextCursor: null,
  mine: { rating: 4, text: "", status: "published", updatedAt: "2026-10-01T10:00:00Z" },
};

describe("модель отзывов", () => {
  it("строит адреса API с экранированием сегментов", () => {
    expect(reviewsPath({ kind: "catalog", id: "arbat walk" })).toBe("/api/story-walks/arbat%20walk/reviews");
    expect(reviewsPath({ kind: "share", token: "a/b" })).toBe("/api/story-walks/shared/a%2Fb/reviews");
    expect(reviewsPath({ kind: "account", id: "id" })).toBe("/api/me/walks/id/reviews");
    expect(targetKey({ kind: "share", token: "t" })).toBe("share:t");
  });

  it("принимает корректную страницу и ответ записи", () => {
    expect(validateReviewPage(valid)).toEqual(valid);
    expect(validateReviewPage({ ...valid, summary: { average: null, count: 0 }, mine: null, nextCursor: "c" }).nextCursor).toBe("c");
    expect(validateReviewWrite({ summary: valid.summary, mine: null })).toEqual({ summary: valid.summary, mine: null });
  });

  it.each([
    ["нет summary", { ...valid, summary: undefined }],
    ["средняя без оценок", { ...valid, summary: { average: 4, count: 0 } }],
    ["нет средней при оценках", { ...valid, summary: { average: null, count: 2 } }],
    ["дробное число оценок", { ...valid, summary: { average: 4, count: 1.5 } }],
    ["оценка вне диапазона", { ...valid, reviews: [{ ...valid.reviews[0], rating: 6 }] }],
    ["текст не строка", { ...valid, reviews: [{ ...valid.reviews[0], text: null }] }],
    ["неизвестный статус", { ...valid, mine: { ...valid.mine, status: "approved" } }],
    ["reviews не массив", { ...valid, reviews: {} }],
    ["курсор числом", { ...valid, nextCursor: 5 }],
    ["заглушка { user: null }", { user: null }],
  ])("отклоняет повреждённую страницу: %s", (_, value) => {
    expect(() => validateReviewPage(value)).toThrow();
  });

  it.each([
    [1, "1 оценка"], [2, "2 оценки"], [5, "5 оценок"], [11, "11 оценок"], [21, "21 оценка"], [22, "22 оценки"],
  ])("склоняет число оценок: %i", (count, label) => {
    expect(ratingCountLabel(count)).toBe(label);
  });

  it("форматирует итог с одним знаком после запятой", () => {
    expect(formatRatingSummary({ average: 4.56, count: 12 })).toBe("★ 4,6 · 12 оценок");
    expect(formatRatingSummary({ average: 5, count: 1 })).toBe("★ 5,0 · 1 оценка");
    expect(formatRatingSummary({ average: null, count: 0 })).toBe("");
    expect(formatRatingSummary(null)).toBe("");
  });
});
