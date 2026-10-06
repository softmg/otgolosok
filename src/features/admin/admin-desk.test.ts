// @vitest-environment jsdom

import { act, createElement, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Summary } from "./model";
import type { PromoItem, PromoQueue } from "./promo-queue-model";

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
  window.history.replaceState(null, "", "/admin");
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

describe("маршрутизация очереди промо через кабинет", () => {
  const walk = {
    id: "walk-1", title: "Проверочная прогулка", shareToken: "share-1", revision: 1,
    createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z",
    visibility: "public", listingStatus: "approved", author: null, mode: "open",
    stopCount: 4, walkingMinutes: 30, distanceM: 2000, snapshotError: null, launches: 0, promo: null,
  };
  const item: PromoItem = {
    id: "11111111-1111-4111-8111-111111111111", walkId: walk.id, title: walk.title,
    shareToken: walk.shareToken, visibility: "public", position: 1, status: "queued",
    slotAt: "2026-10-06T16:00:00Z", runId: null, youtubeUrl: null, telegramUrl: null,
    error: null, revision: 0, createdAt: walk.createdAt, updatedAt: walk.updatedAt,
  };

  function server(initial: PromoQueue = { items: [], history: [] }) {
    const state = structuredClone(initial);
    vi.stubGlobal("fetch", async (input: string, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      let data: unknown;
      if (path.startsWith("/api/story-admin/walks/shared?") && method === "GET") {
        data = { walks: [{ ...walk, promo: state.items.length ? { status: "queued", slotAt: item.slotAt, youtubeUrl: null } : null }], total: 1, offset: 0, hasMore: false, pending: 0 };
      } else if (path === "/api/story-admin/promo-queue" && method === "GET") {
        data = structuredClone(state);
      } else if (path === "/api/story-admin/promo-queue" && method === "POST" && body?.walkId === walk.id) {
        state.items.push(structuredClone(item));
        data = { item };
      } else if (path === `/api/story-admin/promo-queue/${item.id}/remove` && method === "POST" && body?.revision === item.revision) {
        state.items = [];
        data = { ok: true };
      } else if (path === `/api/story-admin/promo-queue/${item.id}/up` && method === "POST" && body?.revision === item.revision) {
        const index = state.items.findIndex(value => value.id === item.id);
        [state.items[index - 1], state.items[index]] = [state.items[index], state.items[index - 1]];
        data = { ok: true };
      } else if (path === `/api/story-admin/promo-queue/${item.id}/requeue` && method === "POST" && body?.revision === item.revision) {
        state.history = [];
        state.items.push(structuredClone(item));
        data = { ok: true };
      } else {
        return new Response(null, { status: 404 });
      }
      return Response.json(data);
    });
    return state;
  }

  it("ставит прогулку в очередь и показывает обновлённый статус вместо 404", async () => {
    const state = server();
    await click(buttons("Прогулки")[0]);
    await click(buttons("В очередь промо")[0]);
    expect(container.textContent).toContain(`«${walk.title}» в очереди промо.`);
    expect(buttons("В очередь промо")).toHaveLength(0);
    expect(state.items.map(value => value.walkId)).toEqual([walk.id]);
    expect(container.textContent).not.toContain("Запись не найдена");
  });

  it("загружает очередь и удаляет выпуск через собственный API, не jobs", async () => {
    const state = server({ items: [item], history: [] });
    await click(buttons("Прогулки")[0]);
    await click(buttons("Очередь промо")[0]);
    expect(container.querySelector('[aria-labelledby="promo-queue-title"]')?.textContent).toContain(walk.title);
    await click(buttons("Убрать")[0]);
    expect(state.items).toEqual([]);
    expect(container.textContent).toContain("Очередь пуста.");
    expect(container.textContent).toContain(`«${walk.title}» убрана из очереди.`);
  });

  it("поднимает выпуск выше через API очереди", async () => {
    const first = { ...item, id: "22222222-2222-4222-8222-222222222222", title: "Первая прогулка" };
    const state = server({ items: [first, { ...item, position: 2 }], history: [] });
    await click(buttons("Прогулки")[0]);
    await click(buttons("Очередь промо")[0]);
    await click(buttons("Выше")[0]);
    expect(state.items.map(value => value.id)).toEqual([item.id, first.id]);
    expect(container.textContent).toContain(`«${walk.title}» поднята выше.`);
    expect([...container.querySelectorAll('[aria-labelledby="promo-queue-title"] tbody th[scope="row"]')].map(cell => cell.textContent)).toEqual([walk.title, first.title]);
  });

  it("возвращает неудавшийся выпуск из истории в очередь", async () => {
    const state = server({ items: [], history: [{ ...item, status: "failed", error: "IMAGE_CONTRACT" }] });
    await click(buttons("Прогулки")[0]);
    await click(buttons("Очередь промо")[0]);
    await click(buttons("Вернуть в очередь")[0]);
    expect(state.history).toEqual([]);
    expect(state.items.map(value => value.id)).toEqual([item.id]);
    expect(container.textContent).toContain(`«${walk.title}» снова в очереди.`);
    expect(buttons("Вернуть в очередь")).toHaveLength(0);
  });
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
