// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "./model";

vi.mock("../auth/client", () => ({
  getSession: async () => ({ id: "editor-1", email: "editor@example.test", name: "Редактор", role: "editor" }),
  signOut: async () => {},
  csrfHeaders: () => ({}),
}));

const { AdminDesk } = await import("./admin-desk");

const jobs: Summary[] = [
  { id: "11111111-1111-4111-8111-111111111111", address: "Пятницкая, 1", stage: "review_required", revision: 2,
    updatedAt: "2026-09-18T13:16:44Z", irrelevant: false, error: null },
  { id: "22222222-2222-4222-8222-222222222222", address: "Пятницкая, 3", stage: "ready", revision: 5,
    updatedAt: "2026-09-18T13:16:44Z", irrelevant: false, error: null },
];

let root: Root;
let container: HTMLDivElement;
/** Holds every response open so a test can look at the table mid-request. */
let gate: { promise: Promise<void>; open: () => void } | null;
let queue: Summary[];

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

function buttons(label: string) {
  return [...container.querySelectorAll("button")].filter(button => button.textContent === label);
}

async function click(button: HTMLButtonElement) {
  await act(async () => { button.click(); });
}

function queueTable() {
  return container.querySelector('[aria-labelledby="admin-addresses-title"]')!;
}

function skeletons() {
  return queueTable().querySelectorAll("tr.admin-skeleton-row").length;
}

function rows() {
  return queueTable().querySelectorAll("tbody tr:not(.admin-skeleton-row)").length;
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  gate = null;
  queue = structuredClone(jobs);
  vi.stubGlobal("fetch", async (input: string) => {
    if (gate) await gate.promise;
    if (!String(input).startsWith("/api/story-admin/jobs")) throw new Error(`Неожиданный запрос: ${input}`);
    return { ok: true, json: async () => ({ jobs: queue, hasMore: false }) } as Response;
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(AdminDesk)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("прелоадер очереди адресов", () => {
  it("заменяет строки очереди скелетоном на время обновления и возвращает их с ответом", async () => {
    expect(rows()).toBe(jobs.length);
    closeGate();
    await click(buttons("Обновить")[0]);
    expect(skeletons()).toBe(jobs.length);
    expect(rows()).toBe(0);
    expect(queueTable().textContent).toContain("Загружаем адреса…");
    await openGate();
    expect(skeletons()).toBe(0);
    expect(rows()).toBe(jobs.length);
    expect(queueTable().textContent).toContain("1–2");
  });

  it("не показывает «ничего не найдено», пока идёт поиск", async () => {
    queue = [];
    await click(buttons("Найти")[0]);
    expect(queueTable().textContent).toContain("По этим условиям ничего не найдено");
    closeGate();
    await click(buttons("Найти")[0]);
    expect(queueTable().textContent).not.toContain("По этим условиям ничего не найдено");
    await openGate();
    expect(queueTable().textContent).toContain("По этим условиям ничего не найдено");
  });
});


it("восстанавливает сессию после повторного запуска эффектов в StrictMode", async () => {
  await act(async () => root.unmount());
  root = createRoot(container);
  await act(async () => root.render(createElement(StrictMode, null, createElement(AdminDesk))));
  expect(container.textContent).not.toContain("Восстановление сессии…");
  expect(buttons("Прогулки")[0].disabled).toBe(false);
  expect(rows()).toBe(jobs.length);
});
