// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearReviewDraft, getReviewKey, loadReviewDraft, markWalkStarted, saveReviewDraft, STARTED_LIMIT, wasWalkStarted } from "./device";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe("данные отзывов в браузере", () => {
  it("создаёт ключ устройства один раз и переиспользует его", () => {
    expect(getReviewKey({ create: false })).toBeNull();
    const key = getReviewKey({ create: true });
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(getReviewKey({ create: true })).toBe(key);
    expect(getReviewKey({ create: false })).toBe(key);
  });

  it("возвращает null, когда хранилище недоступно", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("full", "QuotaExceededError"); });
    expect(getReviewKey({ create: true })).toBeNull();
    expect(markWalkStarted({ kind: "catalog", id: "a" })).toBe(false);
    expect(wasWalkStarted({ kind: "catalog", id: "a" })).toBe(false);
    expect(loadReviewDraft({ kind: "catalog", id: "a" })).toBeNull();
    expect(() => saveReviewDraft({ kind: "catalog", id: "a" }, { rating: 5, text: "" })).not.toThrow();
  });

  it("помнит начатые прогулки и хранит только последние 200", () => {
    for (let index = 0; index <= STARTED_LIMIT; index++) markWalkStarted({ kind: "catalog", id: `walk-${index}` });
    expect(wasWalkStarted({ kind: "catalog", id: "walk-0" })).toBe(false);
    expect(wasWalkStarted({ kind: "catalog", id: "walk-1" })).toBe(true);
    expect(wasWalkStarted({ kind: "catalog", id: `walk-${STARTED_LIMIT}` })).toBe(true);
    markWalkStarted({ kind: "catalog", id: "walk-1" });
    markWalkStarted({ kind: "share", token: "new" });
    expect(wasWalkStarted({ kind: "catalog", id: "walk-1" }), "повторный старт обновляет место в списке").toBe(true);
    expect(JSON.parse(localStorage.getItem("otgolosok:walk-reviews:started:v1")!)).toHaveLength(STARTED_LIMIT);
  });

  it("хранит черновик отдельно для каждой прогулки и игнорирует мусор", () => {
    const target = { kind: "share" as const, token: "t" };
    saveReviewDraft(target, { rating: 4, text: "черновик" });
    expect(loadReviewDraft(target)).toEqual({ rating: 4, text: "черновик" });
    expect(loadReviewDraft({ kind: "catalog", id: "t" })).toBeNull();
    clearReviewDraft(target);
    expect(loadReviewDraft(target)).toBeNull();
    localStorage.setItem("otgolosok:walk-reviews:draft:v1:share:t", "{\"rating\":9,\"text\":\"x\"}");
    expect(loadReviewDraft(target)).toBeNull();
  });
});
