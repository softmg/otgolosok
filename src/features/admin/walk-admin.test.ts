// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WalkAdmin } from "./walk-admin";
import type { AdminApi, AdminRun } from "./model";

const walkSummary = {
  id: "walk-1", title: "Замоскворечье", subtitle: "Прогулка по Пятницкой", status: "ready",
  chapterCount: 2, publishedCount: 2, pendingCount: 0, failedCount: 0, updatedAt: "2026-09-18T13:16:44Z",
};

function chapter(id: string, title: string) {
  return {
    id, contentId: `content-${id}`, title, place: "Пятницкая, 1", revision: 3, status: "draft",
    updatedAt: "2026-09-18T13:16:44Z",
    draft: { title, transition: "Переход", paragraphs: [{ id: "p1", text: "Текст абзаца", fact_ids: [] }], nextHint: "Идите прямо" },
    published: null, source: { sources: [], facts: [] }, latestJob: null,
  };
}

const walkDetail = {
  id: walkSummary.id, title: walkSummary.title, subtitle: walkSummary.subtitle, status: walkSummary.status,
  ttsProviders: [{ id: "openai" as const, label: "OpenAI", available: true, defaultVoice: "alloy", voices: [{ id: "alloy", label: "Alloy" }] }],
  chapters: [chapter("chapter-1", "Первая глава"), chapter("chapter-2", "Вторая глава")],
};

let root: Root;
let container: HTMLDivElement;
/** Holds every response open so a test can look at the tables mid-request. */
let gate: { promise: Promise<void>; open: () => void } | null;
let walks: (typeof walkSummary)[];
let total: number;
let hasMore: boolean;
const requestedPaths: string[] = [];
const onDirtyChange = vi.fn();
const openJob = vi.fn();

const api: AdminApi = async <T,>(path: string): Promise<T> => {
  if (gate) await gate.promise;
  requestedPaths.push(path);
  if (path.startsWith("/walks?")) return { walks, total, hasMore } as T;
  if (path === `/walks/${walkDetail.id}`) return { walk: structuredClone(walkDetail) } as T;
  throw new Error(`Неожиданный запрос: ${path}`);
};

function Harness() {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label); setError("");
    try { await action(new AbortController().signal); }
    catch (cause) { setError((cause as Error).message); }
    finally { setBusy(""); }
  };
  return createElement("div", null,
    error && createElement("p", { role: "alert" }, error),
    createElement(WalkAdmin, { api, run, busy, openJob, onDirtyChange }));
}

function buttons(label: string) {
  return [...container.querySelectorAll("button")].filter(button => button.textContent === label);
}

async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
}

function closeGate() {
  let open!: () => void;
  const promise = new Promise<void>(resolve => { open = resolve; });
  gate = { promise, open };
}

async function openGate() {
  const held = gate!;
  gate = null;
  await act(async () => { held.open(); await held.promise; });
}

function table(selector: string) {
  return container.querySelector(selector)!;
}

function skeletons(selector: string) {
  return table(selector).querySelectorAll("tr.admin-skeleton-row").length;
}

function rows(selector: string) {
  return table(selector).querySelectorAll("tbody tr:not(.admin-skeleton-row)").length;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  gate = null;
  walks = [structuredClone(walkSummary)];
  total = walks.length;
  hasMore = false;
  requestedPaths.length = 0;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  onDirtyChange.mockClear();
  openJob.mockClear();
});

describe("прелоадеры таблиц прогулок", () => {
  it("показывает скелетон каталога прогулок на время обновления списка", async () => {
    expect(rows(".walk-admin__table")).toBe(1);
    closeGate();
    await click(buttons("Обновить список")[0]);
    expect(skeletons(".walk-admin__table")).toBeGreaterThan(0);
    expect(rows(".walk-admin__table")).toBe(0);
    await openGate();
    expect(skeletons(".walk-admin__table")).toBe(0);
    expect(rows(".walk-admin__table")).toBe(1);
  });

  it("не показывает «в каталоге пока нет прогулок», пока список грузится", async () => {
    walks = [];
    await click(buttons("Обновить список")[0]);
    expect(container.querySelector(".walk-admin__empty")).not.toBeNull();
    closeGate();
    await click(buttons("Обновить список")[0]);
    expect(container.querySelector(".walk-admin__empty")).toBeNull();
    await openGate();
    expect(container.querySelector(".walk-admin__empty")).not.toBeNull();
  });

  it("показывает скелетон глав, пока прогулка перезагружается", async () => {
    await click(container.querySelector<HTMLButtonElement>(".walk-admin__walk-link")!);
    expect(rows(".walk-admin__chapters")).toBe(walkDetail.chapters.length);
    closeGate();
    await click(buttons("Обновить прогулку")[0]);
    expect(skeletons(".walk-admin__chapters")).toBe(walkDetail.chapters.length);
    expect(rows(".walk-admin__chapters")).toBe(0);
    await openGate();
    expect(skeletons(".walk-admin__chapters")).toBe(0);
    expect(rows(".walk-admin__chapters")).toBe(walkDetail.chapters.length);
  });

  it("размечает заголовком строки вторую колонку глав, где стоит название", async () => {
    await click(container.querySelector<HTMLButtonElement>(".walk-admin__walk-link")!);
    closeGate();
    await click(buttons("Обновить прогулку")[0]);
    const cells = table(".walk-admin__chapters").querySelector("tr.admin-skeleton-row")!.children;
    expect(cells[0].tagName).toBe("TD");
    expect(cells[1].tagName).toBe("TH");
    await openGate();
  });
});

describe("пагинация прогулок", () => {
  it("переходит вперёд и назад по серверным страницам", async () => {
    total = 51;
    hasMore = true;
    await click(buttons("Обновить список")[0]);
    expect(container.querySelector('[aria-label="Страницы прогулок"]')?.textContent).toContain("Страница 1 из 2");

    walks = [{ ...walkSummary, id: "walk-2", title: "Вторая страница" }];
    hasMore = false;
    await click(buttons("Далее")[0]);
    expect(requestedPaths.at(-1)).toBe("/walks?limit=50&offset=50");
    expect(container.textContent).toContain("Вторая страница");
    expect(container.querySelector('[aria-label="Страницы прогулок"]')?.textContent).toContain("Страница 2 из 2");

    walks = [structuredClone(walkSummary)];
    hasMore = true;
    await click(buttons("Назад")[0]);
    expect(requestedPaths.at(-1)).toBe("/walks?limit=50&offset=0");
  });

  it("возвращается на предыдущую страницу, если текущая опустела", async () => {
    total = 51;
    hasMore = true;
    await click(buttons("Обновить список")[0]);
    walks = [];
    total = 50;
    hasMore = false;
    await click(buttons("Далее")[0]);
    expect(requestedPaths.slice(-2)).toEqual([
      "/walks?limit=50&offset=50",
      "/walks?limit=50&offset=0",
    ]);
    expect(container.querySelector('[aria-label="Страницы прогулок"]')?.textContent).toContain("Страница 1 из 1");
  });
});
