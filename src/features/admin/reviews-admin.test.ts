// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ReviewsAdmin } from "./reviews-admin";
import type { AdminApi, AdminRun } from "./model";

const review = {
  id: "11111111-1111-4111-8111-111111111111", rating: 4, text: "Хороший маршрут\nвторая строка", status: "pending",
  createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-01T11:00:00Z", moderatedAt: null,
  walk: { kind: "catalog", id: "arbat", title: "Арбат", url: "/walk?catalog=arbat" },
  author: { kind: "user", id: "anna", name: "Анна", email: "anna@example.test" },
};
const page = { reviews: [review], total: 1, offset: 0, hasMore: false, pending: 3 };
let root: Root, container: HTMLDivElement;
const request = vi.fn();
const api: AdminApi = async <T,>(path: string, _signal: AbortSignal, body?: unknown): Promise<T> => request(path, body) as Promise<T>;

function Harness() {
  const [busy, setBusy] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label);
    try { await action(new AbortController().signal); } catch { /* The component shows its own error. */ }
    finally { setBusy(""); }
  };
  return createElement(ReviewsAdmin, { api, run, busy });
}
const button = (text: string) => [...container.querySelectorAll("button")].find(item => item.textContent === text)!;
async function click(text: string) { await act(async () => button(text).click()); }
async function mount() { await act(async () => root.render(createElement(Harness))); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  request.mockImplementation(async (path: string) => path.startsWith("/reviews?") ? page : { review: { ...review, status: "published" } });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("opens on the moderation queue and shows the review with its walk and author", async () => {
  await mount();
  expect(request).toHaveBeenCalledWith("/reviews?status=pending&limit=25&offset=0", undefined);
  expect(container.textContent).toContain("На модерации: 3");
  expect(container.querySelector("[aria-label='Оценка 4 из 5']")).not.toBeNull();
  expect(container.textContent).toContain("Хороший маршрут\nвторая строка");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/walk?catalog=arbat");
  expect(container.textContent).toContain("anna@example.test");
  expect(button("Опубликовать")).toBeTruthy();
  expect(button("Скрыть")).toBeTruthy();
});

it("sends filters as a query string", async () => {
  await mount();
  const [status, rating] = container.querySelectorAll("select");
  const input = container.querySelector<HTMLInputElement>("input[type=search]")!;
  await act(async () => {
    status.value = "hidden"; status.dispatchEvent(new Event("change", { bubbles: true }));
    rating.value = "2"; rating.dispatchEvent(new Event("change", { bubbles: true }));
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "  арбат ");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click("Найти");
  expect(request).toHaveBeenLastCalledWith("/reviews?status=hidden&rating=2&q=%D0%B0%D1%80%D0%B1%D0%B0%D1%82&limit=25&offset=0", undefined);
});

it("moderates and deletes with inline confirmation, then reloads the page", async () => {
  await mount();
  await click("Опубликовать");
  expect(request).toHaveBeenCalledWith(`/reviews/${review.id}/moderate`, { action: "publish" });
  expect(container.textContent).toContain("Отзыв опубликован.");
  await click("Скрыть");
  expect(request).toHaveBeenCalledWith(`/reviews/${review.id}/moderate`, { action: "hide" });
  await click("Удалить");
  expect(container.textContent).toContain("Удалить отзыв?");
  expect(request).not.toHaveBeenCalledWith(`/reviews/${review.id}/delete`, {});
  await click("Удалить");
  expect(request).toHaveBeenCalledWith(`/reviews/${review.id}/delete`, {});
  expect(request.mock.calls.filter(([path]) => String(path).startsWith("/reviews?"))).toHaveLength(4);
});

it("shows empty and error states", async () => {
  request.mockResolvedValueOnce({ reviews: [], total: 0, offset: 0, hasMore: false, pending: 0 });
  await mount();
  expect(container.textContent).toContain("Новых отзывов на модерации нет.");
  request.mockRejectedValueOnce(new Error("offline"));
  await click("Обновить список");
  expect(container.querySelector("[role=alert]")?.textContent).toContain("Не удалось загрузить отзывы.");
});

it("marks reviews whose walk is gone and guest authors", async () => {
  request.mockResolvedValueOnce({ ...page, reviews: [{ ...review, status: "published", text: "", walk: { ...review.walk, url: null }, author: { kind: "guest" } }] });
  await mount();
  expect(container.textContent).toContain("Прогулка удалена или закрыта");
  expect(container.textContent).toContain("Гость");
  expect(container.textContent).toContain("Без текста");
  expect([...container.querySelectorAll("button")].some(item => item.textContent === "Опубликовать")).toBe(false);
});
