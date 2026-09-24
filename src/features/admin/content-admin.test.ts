// @vitest-environment jsdom

import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentAdmin } from "./content-admin";
import { contentStatusStates, type AdminApi, type AdminRun, type ContentBatch, type ContentBatchItem, type ContentPlace, type ContentWorker } from "./model";

const story = { title: "История дома", paragraphs: [{ text: "Текст истории", factIds: [] }] };
const places: ContentPlace[] = [
  { id: "osm:node:1", name: "Первое место", address: null, location: { lat: 55, lon: 37 },
    text: { id: "text-1", profile: "story-v1", story, draft: story, verification: "editorial", audio: null, createdAt: "2026-09-22" } },
  { id: "osm:node:2", name: "Место без текста", address: null, location: { lat: 55, lon: 37 }, text: null },
];

const batch: ContentBatch = {
  id: "11111111-1111-4111-8111-111111111111", name: "OSM снимок", state: "running", mode: "text-only",
  textProfile: "story-v1", ttsProfile: null, createdAt: "2026-09-18T13:16:44Z", updatedAt: "2026-09-18T13:16:44Z",
  counts: { total: 3, queued: 0, working: 0, ready: 1, failed: 2 },
};
const batchItems: ContentBatchItem[] = [
  { placeId: "osm:node:1", name: "1 корпус", address: null, state: "review_required", error: { code: "ADDRESS_UNCLEAR", message: "Источники не позволяют однозначно определить дом." } },
  { placeId: "osm:node:2", name: "8й корпус", address: null, state: "review_required", error: { code: "REVIEW_REQUIRED", message: "REVIEW_REQUIRED" } },
  { placeId: "osm:node:3", name: "Готовое место", address: null, state: "ready", error: null },
];

let root: Root;
let container: HTMLDivElement;
let failDetail: boolean;
/** Holds every response open so a test can look at the tables mid-request. */
let gate: { promise: Promise<void>; open: () => void } | null;
let scrolled: Element[];
let itemQueries: URLSearchParams[];
let items: ContentBatchItem[];
let transport: "worker" | "http";
let configuredWorkers: ContentWorker[];
const onDirtyChange = vi.fn();

/** Mirrors the server: items are narrowed by status and error, while the code list follows the status filter alone. */
function itemsPage(query: URLSearchParams) {
  const status = query.get("status") ?? "all";
  const error = query.get("error") ?? "all";
  const states = status === "all" ? null : contentStatusStates[status as keyof typeof contentStatusStates];
  const inBucket = items.filter(item => !states || states.includes(item.state));
  const matching = inBucket.filter(item => error === "all"
    || (error === "none" ? !item.error : item.error?.code === error));
  const counts = new Map<string | null, number>();
  for (const item of inBucket) counts.set(item.error?.code ?? null, (counts.get(item.error?.code ?? null) ?? 0) + 1);
  return {
    items: matching, total: matching.length, hasMore: false,
    errors: [...counts].map(([code, count]) => ({ code, count })),
  };
}

const api: AdminApi = async <T,>(path: string): Promise<T> => {
  if (gate) await gate.promise;
  if (path.endsWith("/approve")) {
    const place = structuredClone(places[0]);
    if (place.text) place.text.verification = "editorial";
    return { place } as T;
  }
  if (path.startsWith("/content/places/")) {
    if (failDetail) throw new Error("Не удалось загрузить место");
    return { place: structuredClone(places.find(place => path.endsWith(place.id))) } as T;
  }
  if (path.startsWith("/content/places?")) return { places: places.map(place => ({ ...place, textStatus: place.text ? "approved" : "none", audio: null })), total: 2, hasMore: false } as T;
  if (path.endsWith("/retry")) {
    const retried = items.find(item => path.includes(item.placeId))!;
    retried.state = "queued"; retried.error = null;
    return {} as T;
  }
  if (path.startsWith(`/content/batches/${batch.id}/items?`)) {
    const query = new URLSearchParams(path.split("?")[1]);
    itemQueries.push(query);
    return itemsPage(query) as T;
  }
  const responses: Record<string, unknown> = {
    "/content/batches": { batches: [batch] },
    "/content/stats": { places: 2, texts: 1, audio: 0 },
    "/content/workers": { transport, workers: configuredWorkers, heartbeats: [] },
    "/content/audio": { audioJobs: [] },
  };
  if (!(path in responses)) throw new Error(`Неожиданный запрос: ${path}`);
  return responses[path] as T;
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
    createElement(ContentAdmin, { api, run, busy, onDirtyChange }));
}

function buttons(label: string) {
  return [...container.querySelectorAll("button")].filter(button => button.textContent === label);
}

async function click(button: HTMLButtonElement) {
  await act(async () => { button.focus(); button.click(); });
}

async function choose(id: string, value: string) {
  const select = container.querySelector<HTMLSelectElement>(`#${id}`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function itemNames() {
  const section = container.querySelector('[aria-labelledby="content-items-title"]')!;
  return [...section.querySelectorAll("tbody th")].map(cell => cell.firstChild?.textContent);
}

function errorCells() {
  const section = container.querySelector('[aria-labelledby="content-items-title"]')!;
  return [...section.querySelectorAll("tbody tr")].map(row => row.children[2].textContent);
}

function errorOptions() {
  return [...container.querySelectorAll<HTMLOptionElement>("#content-item-error option")].map(option => option.textContent);
}

function editorHeading() {
  return container.querySelector("article h3");
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  failDetail = false;
  gate = null;
  scrolled = [];
  itemQueries = [];
  items = structuredClone(batchItems);
  transport = "worker";
  configuredWorkers = [];
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true, value: function (this: Element) { scrolled.push(this); },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(Harness)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  vi.unstubAllGlobals();
  onDirtyChange.mockClear();
});

describe("подключение TTS", () => {
  it("не показывает предупреждение о воркере до загрузки данных", async () => {
    await act(async () => { root.unmount(); });
    let release!: () => void;
    const promise = new Promise<void>(resolve => { release = resolve; });
    gate = { promise, open: release };
    root = createRoot(container);
    act(() => { root.render(createElement(Harness)); });

    expect(container.textContent).toContain("Загружаем статистику каталога");
    expect(container.textContent).not.toContain("Нет online-воркера TTS");

    gate = null;
    await act(async () => { release(); await promise; });
    expect(container.textContent).toContain("Нет online-воркера TTS");
  });

  it("в HTTP-режиме не предлагает выпускать недействующий ключ воркера", async () => {
    transport = "http";
    await click(buttons("Обновить")[0]);
    await click(buttons("Открыть")[0]);
    expect(container.textContent).not.toContain("нет online-воркера TTS");
    const workersSection = container.querySelector('[aria-labelledby="content-workers-title"]')!;
    expect(workersSection.textContent).toContain("Озвучка обрабатывается сервером TTS");
    expect(workersSection.textContent).not.toContain("Выпустить ключ");
    expect(workersSection.textContent).not.toContain("Ключи воркеров ещё не выпускались");
  });

  it("в режиме внешнего воркера объясняет очередь, если воркер не подключён", async () => {
    await click(buttons("Открыть")[0]);
    expect(container.textContent).toContain("нет online-воркера TTS");
    expect(buttons("Выпустить ключ")).toHaveLength(1);
  });
});

describe("переход из каталога к редактору места", () => {
  it("открывает текст, прокручивает к заголовку и переводит на него фокус", async () => {
    await click(buttons("Открыть")[0]);
    expect(container.querySelector<HTMLInputElement>("#content-title")?.value).toBe(story.title);
    expect(editorHeading()?.textContent).toBe(places[0].name);
    expect(document.activeElement).toBe(editorHeading());
    expect(scrolled.at(-1)).toBe(editorHeading());
  });

  it("переходит к уже открытому месту при повторном нажатии", async () => {
    const opener = buttons("Открыть")[0];
    await click(opener);
    scrolled = [];
    await click(opener);
    expect(document.activeElement).toBe(editorHeading());
    expect(scrolled).toEqual([editorHeading()]);
  });

  it("показывает другое место без текста и возвращает к его строке после закрытия", async () => {
    await click(buttons("Открыть")[0]);
    const opener = buttons("Открыть")[1];
    await click(opener);
    expect(editorHeading()?.textContent).toBe(places[1].name);
    expect(container.querySelector("article")?.textContent).toContain("текст ещё не создан");
    expect(document.activeElement).toBe(editorHeading());
    await click(buttons("Закрыть")[0]);
    expect(container.querySelector("article")).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(scrolled.at(-1)).toBe(opener);
  });

  it("при ошибке загрузки сохраняет текущий редактор и не запускает переход", async () => {
    await click(buttons("Открыть")[0]);
    failDetail = true;
    scrolled = [];
    const opener = buttons("Открыть")[1];
    await click(opener);
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Не удалось загрузить место");
    expect(editorHeading()?.textContent).toBe(places[0].name);
    expect(document.activeElement).toBe(opener);
    expect(scrolled).toEqual([]);
  });

  it("отмена потери правок сохраняет текст и не меняет место", async () => {
    await click(buttons("Открыть")[0]);
    const input = container.querySelector<HTMLInputElement>("#content-title")!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Моя правка");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    vi.spyOn(window, "confirm").mockReturnValue(false);
    scrolled = [];
    await click(buttons("Открыть")[1]);
    await click(buttons("Закрыть")[0]);
    expect(editorHeading()?.textContent).toBe(places[0].name);
    expect(input.value).toBe("Моя правка");
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    expect(scrolled).toEqual([]);
  });

  it("после утверждения закрывает редактор, показывает успех и возвращает к строке места", async () => {
    const opener = buttons("Открыть")[0];
    await click(opener);
    scrolled = [];

    await click(buttons("Утвердить текст")[0]);

    expect(container.querySelector("article")).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe("Текст утверждён; нужная озвучка поставлена в очередь.");
    expect(document.activeElement?.textContent).toBe("Открыть");
    expect(scrolled.at(-1)).toBe(document.activeElement);
  });
});

describe("фильтр заданий партии по ошибке", () => {
  async function openBatch() {
    await click(buttons("Все задания")[0]);
  }

  it("предлагает коды ошибок партии с количеством заданий", async () => {
    await openBatch();
    expect(itemQueries.at(-1)?.get("error")).toBe("all");
    expect(errorOptions()).toEqual(["Любая ошибка", "ADDRESS_UNCLEAR (1)", "REVIEW_REQUIRED (1)", "Без ошибки (1)"]);
    expect(itemNames()).toEqual(["1 корпус", "8й корпус", "Готовое место"]);
  });

  it("показывает сообщение вместе с кодом, а у старых заданий — только код", async () => {
    await openBatch();
    expect(errorCells()).toEqual(["Источники не позволяют однозначно определить дом.ADDRESS_UNCLEAR", "REVIEW_REQUIRED", "—"]);
  });

  it("оставляет в списке только задания с выбранным кодом", async () => {
    await openBatch();
    await choose("content-item-error", "ADDRESS_UNCLEAR");
    const query = itemQueries.at(-1)!;
    expect(query.get("error")).toBe("ADDRESS_UNCLEAR");
    expect(query.get("offset")).toBe("0");
    expect(itemNames()).toEqual(["1 корпус"]);
    expect(container.querySelector('[aria-labelledby="content-items-title"]')?.textContent).toContain("Показано 1–1 из 1");
  });

  it("отбирает задания без ошибки", async () => {
    await openBatch();
    await choose("content-item-error", "none");
    expect(itemNames()).toEqual(["Готовое место"]);
  });

  it("сбрасывает фильтр ошибки при смене статуса, потому что коды считаются внутри статуса", async () => {
    await openBatch();
    await choose("content-item-error", "ADDRESS_UNCLEAR");
    await choose("content-item-status", "ready");
    const query = itemQueries.at(-1)!;
    expect(query.get("status")).toBe("ready");
    expect(query.get("error")).toBe("all");
    expect(container.querySelector<HTMLSelectElement>("#content-item-error")?.value).toBe("all");
    expect(errorOptions()).toEqual(["Любая ошибка", "Без ошибки (1)"]);
    expect(itemNames()).toEqual(["Готовое место"]);
  });

  it("сохраняет фильтр после повтора задания и держит выбранный код в списке", async () => {
    await openBatch();
    await choose("content-item-error", "ADDRESS_UNCLEAR");
    await click(buttons("Повторить")[0]);
    expect(itemQueries.at(-1)?.get("error")).toBe("ADDRESS_UNCLEAR");
    expect(itemNames()).toEqual([]);
    expect(container.querySelector('[aria-labelledby="content-items-title"]')?.textContent)
      .toContain("Заданий с выбранными фильтрами в партии нет.");
    expect(errorOptions()).toContain("ADDRESS_UNCLEAR (0)");
    expect(container.querySelector<HTMLSelectElement>("#content-item-error")?.value).toBe("ADDRESS_UNCLEAR");
  });
});

describe("прелоадеры таблиц", () => {
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

  function section(title: string) {
    return container.querySelector(`[aria-labelledby="${title}"]`)!;
  }

  function skeletons(title: string) {
    return section(title).querySelectorAll("tr.admin-skeleton-row").length;
  }

  function rows(title: string) {
    return section(title).querySelectorAll("tbody tr:not(.admin-skeleton-row)").length;
  }

  it("заменяет строки партий и воркеров скелетоном на время обновления", async () => {
    closeGate();
    await click(buttons("Обновить")[0]);
    expect(skeletons("content-batches-title")).toBeGreaterThan(0);
    expect(rows("content-batches-title")).toBe(0);
    expect(skeletons("content-workers-title")).toBeGreaterThan(0);
    await openGate();
    expect(skeletons("content-batches-title")).toBe(0);
    expect(rows("content-batches-title")).toBe(1);
  });

  it("не показывает «ключи воркеров ещё не выпускались», пока список грузится", async () => {
    expect(section("content-workers-title").textContent).toContain("Ключи воркеров ещё не выпускались.");
    closeGate();
    await click(buttons("Обновить")[0]);
    expect(section("content-workers-title").textContent).not.toContain("Ключи воркеров ещё не выпускались.");
    await openGate();
    expect(section("content-workers-title").textContent).toContain("Ключи воркеров ещё не выпускались.");
  });

  it("показывает скелетон каталога вместо устаревших мест во время поиска", async () => {
    closeGate();
    await click(buttons("Найти")[0]);
    expect(skeletons("content-catalog-title")).toBeGreaterThan(0);
    expect(rows("content-catalog-title")).toBe(0);
    expect(section("content-catalog-title").textContent).toContain("Загружаем места…");
    await openGate();
    expect(skeletons("content-catalog-title")).toBe(0);
    expect(rows("content-catalog-title")).toBe(places.length);
  });

  it("показывает скелетон заданий при открытии партии и убирает его вместе с ответом", async () => {
    closeGate();
    await click(buttons("Все задания")[0]);
    expect(skeletons("content-items-title")).toBeGreaterThan(0);
    expect(section("content-items-title").textContent).toContain("Загружаем задания…");
    expect(section("content-items-title").textContent).not.toContain("Заданий с выбранными фильтрами в партии нет.");
    await openGate();
    expect(skeletons("content-items-title")).toBe(0);
    expect(itemNames()).toEqual(["1 корпус", "8й корпус", "Готовое место"]);
  });
});
