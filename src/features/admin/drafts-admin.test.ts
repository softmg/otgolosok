// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsAdmin } from "./drafts-admin";
import type { AdminApi, AdminRun, ContentDraft, ContentDraftPage } from "./model";

const draft = (index: number): ContentDraft => ({
  placeId: `osm:node:${index}`, name: `Место ${index}`, address: index === 1 ? "Москва, Арбат, 1" : null, location: { lat: 55.75 + index / 1000, lon: 37.61 },
  text: { id: `t${index}`, title: `Заголовок ${index}`, paragraphs: [`Первый абзац ${index}.`, `Второй абзац ${index}.`], verification: "automatic", createdAt: "2026-09-28T17:00:00Z" },
});

let container: HTMLDivElement, root: Root, requests: string[], total: number;
const api: AdminApi = async <T,>(path: string) => {
  requests.push(path);
  const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset"));
  const items = Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, index) => draft(offset + index + 1));
  return { total, hasMore: offset + items.length < total, items } satisfies ContentDraftPage as T;
};
const run: AdminRun = async (_label, action) => { await action(new AbortController().signal); };

async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(createElement(DraftsAdmin, { api, run, busy: "" })); });
}
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = []; total = 2;
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe("вкладка черновиков", () => {
  it("показывает черновики с координатами и копирует точку с абзацами", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount();
    expect(requests).toEqual(["/content/drafts?limit=50&offset=0"]);
    expect(container.textContent).toContain("Москва, Арбат, 1 · 55.751, 37.61");
    expect(container.textContent).toContain("Показано 1–2 из 2 черновиков.");
    await act(async () => { button("Копировать черновик: Место 1").click(); });
    expect(writeText).toHaveBeenCalledWith("Место: Место 1\nАдрес: Москва, Арбат, 1\nКоординаты: 55.751, 37.61\nOSM: osm:node:1\nЗаголовок: Заголовок 1\n\nАбзац 1: Первый абзац 1.\nАбзац 2: Второй абзац 1.");
    expect(container.textContent).toContain("Скопировано: Место 1.");
  });

  it("сообщает, если браузер не дал доступ к буферу обмена", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    await mount();
    await act(async () => { button("Копировать черновик: Место 2").click(); });
    expect(container.textContent).toContain("Не удалось скопировать");
  });

  it("листает страницы и показывает пустой список", async () => {
    total = 60;
    await mount();
    await act(async () => { button("Далее").click(); });
    expect(requests.at(-1)).toBe("/content/drafts?limit=50&offset=50");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(10);
    await act(async () => { root.unmount(); });
    total = 0;
    await mount();
    expect(container.textContent).toContain("Черновиков нет.");
  });
});
