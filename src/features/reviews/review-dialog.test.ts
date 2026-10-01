// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewDialog } from "./review-dialog";
import type { WalkReviewsModel } from "./use-walk-reviews";

let root: Root, container: HTMLDivElement;
function model(overrides: Partial<WalkReviewsModel> = {}): WalkReviewsModel {
  return {
    target: { kind: "catalog", id: "arbat" }, state: "ready", reviewer: { kind: "guest" }, summary: { average: 0, count: 0 },
    reviews: [], nextCursor: null, mine: null, loadingMore: false,
    reload: vi.fn(), loadMore: vi.fn(), save: vi.fn().mockResolvedValue({ ok: true, status: "pending" }), remove: vi.fn(),
    ...overrides,
  };
}
async function mount(reviews: WalkReviewsModel, open = true) {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(ReviewDialog, { reviews, open, onClose, walkTitle: "Арбат" })));
  return onClose;
}
const dialog = () => container.querySelector("dialog")!;
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opens the form as a modal window titled by the walk", async () => {
  const original = HTMLDialogElement.prototype.showModal;
  const showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute("open", ""); });
  HTMLDialogElement.prototype.showModal = showModal;
  try { await mount(model()); } finally { HTMLDialogElement.prototype.showModal = original; }
  expect(showModal).toHaveBeenCalledTimes(1);
  expect(dialog().open).toBe(true);
  const title = container.querySelector(`#${CSS.escape(dialog().getAttribute("aria-labelledby")!)}`);
  expect(title?.textContent).toBe("Оцените прогулку");
  expect(dialog().textContent).toContain("Арбат");
  expect(container.querySelector("form")?.getAttribute("aria-labelledby")).toBe(dialog().getAttribute("aria-labelledby"));
  expect(container.querySelectorAll("h2"), "у формы нет второго заголовка").toHaveLength(1);
});

it("renders no form while closed, so every opening starts from a fresh draft", async () => {
  await mount(model(), false);
  expect(dialog().open).toBe(false);
  expect(container.querySelector("form")).toBeNull();
});

it("closes by the cross and by «Готово» after a successful send", async () => {
  const onClose = await mount(model());
  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Закрыть']")!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => container.querySelector<HTMLInputElement>("input[aria-label='4 звезды из 5']")!.click());
  await act(async () => container.querySelector("form")!.requestSubmit());
  expect(container.textContent).toContain("Отзыв появится после проверки редакцией.");
  await act(async () => button("Готово")!.click());
  expect(onClose).toHaveBeenCalledTimes(2);
});

it("shows the author's own review and the unavailable state with a retry", async () => {
  await mount(model({ mine: { rating: 5, text: "Отлично", status: "pending", updatedAt: "2026-10-01T10:00:00Z" } }));
  expect(container.querySelector("h2")?.textContent).toBe("Ваш отзыв");
  expect(container.querySelector("textarea")?.value).toBe("Отлично");
  const reviews = model({ state: "unavailable" });
  await mount(reviews);
  expect(container.querySelector("form")).toBeNull();
  await act(async () => button("Повторить")!.click());
  expect(reviews.reload).toHaveBeenCalledTimes(1);
});
