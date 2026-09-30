// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedWalkAdmin } from "./shared-walk-admin";
import type { AdminApi, AdminRun } from "./model";

const walk = { id: "walk", title: "Арбат", shareToken: "public-token", author: { id: "anna", name: "Анна", email: "anna@example.test" },
  mode: "loop", stopCount: 4, walkingMinutes: 20, distanceM: 1200, snapshotError: null,
  createdAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T11:00:00Z" };
let root: Root, container: HTMLDivElement;
const request = vi.fn();
const api: AdminApi = async <T,>(path: string): Promise<T> => request(path) as Promise<T>;

function Harness() {
  const [busy, setBusy] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label);
    try { await action(new AbortController().signal); } catch { /* The component also offers retry. */ }
    finally { setBusy(""); }
  };
  return createElement(SharedWalkAdmin, { api, run, busy });
}
function button(text: string) { return [...container.querySelectorAll("button")].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function mount() { await act(async () => root.render(createElement(Harness))); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  request.mockResolvedValue({ walks: [walk], total: 26, offset: 0, hasMore: true });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows author, route metadata and the public link, and confirms a successful copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await mount();
  expect(container.textContent).toContain("anna@example.test");
  expect(container.textContent).toContain("Точек: 4 · 1,2 км · 20 мин пешком");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/walk?share=public-token");
  await click("Скопировать ссылку");
  expect(writeText).toHaveBeenCalledWith(new URL("/walk?share=public-token", window.location.origin).href);
  expect(container.textContent).toContain("Ссылка на «Арбат» скопирована.");
});

it("offers a selectable URL when clipboard access fails", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  await mount(); await click("Скопировать ссылку");
  const input = container.querySelector<HTMLInputElement>("input[readonly]")!;
  expect(input.value).toBe(new URL("/walk?share=public-token", window.location.origin).href);
  await act(async () => input.focus());
  expect(input.selectionEnd).toBe(input.value.length);
  expect(container.textContent).toContain("Браузер не разрешил копирование");
});

it("loads the next page and accepts the server offset after a page disappears", async () => {
  await mount();
  request.mockResolvedValueOnce({ walks: [{ ...walk, title: "Последняя прогулка" }], total: 26, offset: 25, hasMore: false });
  await click("Далее");
  expect(request.mock.lastCall?.[0]).toContain("offset=25");
  expect(container.textContent).toContain("Страница 2 из 2");
  expect(button("Далее").disabled).toBe(true);
  request.mockResolvedValueOnce({ walks: [walk], total: 25, offset: 0, hasMore: false });
  await click("Обновить список");
  expect(container.textContent).toContain("Страница 1 из 1");
  expect(button("Назад").disabled).toBe(true);
});

it("keeps a failed load retryable and distinguishes an empty result", async () => {
  request.mockRejectedValueOnce(new Error("offline"));
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить список");
  request.mockResolvedValueOnce({ walks: [], total: 0, offset: 0, hasMore: false });
  await click("Повторить");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Пока никто не открыл доступ");
  expect(button("Далее").disabled).toBe(true);
});

it("renders a damaged walk with an unknown author without invented route metrics", async () => {
  request.mockResolvedValueOnce({ walks: [{ ...walk, author: null, mode: null, stopCount: null, distanceM: null, walkingMinutes: null, snapshotError: "Повреждён" }], total: 1, offset: 0, hasMore: false });
  await mount();
  expect(container.textContent).toContain("Автор неизвестен");
  expect(container.textContent).toContain("Снимок повреждён");
  expect(container.textContent).not.toContain("мин пешком");
});
