// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NearbySheet, PlaceSheet, StorySheet } from "./around-sheets";
import { jobPin } from "./around-screen";
import type { NearbyRecommendation } from "./nearby-stories";
import { isExpandableStory } from "./story-pin";
import type { GenerationJob } from "../generator/types";

const story: NearbyRecommendation = {
  id: "story-1", title: "Дом Смирнова", address: "ул. Пятницкая, 1", location: { lat: 55.74, lon: 37.63 },
  durationSec: 120, sourceCount: 2, factCount: 3, distanceM: 80, reason: "Ближе всего",
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { case: "истории найдены", status: "ready" as const, recommendations: [story] },
  { case: "историй нет", status: "ready" as const, recommendations: [] },
  { case: "идёт загрузка", status: "loading" as const, recommendations: [] },
  { case: "ошибка загрузки", status: "error" as const, recommendations: [] },
])("окно «Готовые истории рядом» закрывается крестиком: $case", async ({ status, recommendations }) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onClose = vi.fn();
  await act(async () => root.render(createElement(NearbySheet, {
    status, radius: 200, recommendations, onRadius: () => {}, onSelect: () => {}, onClose,
  })));
  const close = container.querySelector<HTMLButtonElement>("[data-sheet-part='header'] button[aria-label='Закрыть истории рядом']");
  expect(close).not.toBeNull();
  await act(async () => close!.click());
  expect(onClose).toHaveBeenCalledTimes(1);
  await act(async () => root.unmount());
});

it.each([
  { case: "точка без дома", address: null, error: "", walkHref: "/?walk=create&lat=55.75", title: "Не знаем, что здесь", actions: ["Создать прогулку отсюда"] },
  { case: "дом найден", address: "ул. Пятницкая, 1", error: "", walkHref: "/?walk=create", title: "ул. Пятницкая, 1", actions: ["История этого дома", "Создать прогулку отсюда"] },
  { case: "адрес не определился", address: null, error: "Не удалось определить адрес.", walkHref: null, title: "О чём расскажет этот дом?", actions: [] },
])("карточка выбранной точки: $case", async ({ address, error, walkHref, title, actions }) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PlaceSheet, {
    address, busy: false, error, walkHref, onPrepare: () => {}, onClose: () => {}, onWalk: () => {},
  })));
  expect(container.querySelector("#new-place-title")?.textContent).toBe(title);
  expect([...container.querySelectorAll("[data-sheet-part='footer'] :is(a, button)")].map(control => control.textContent?.trim())).toEqual(actions);
  expect(container.querySelector("a[href^='/create']")).toBeNull();
  await act(async () => root.unmount());
});

it("«История этого дома» запускает подготовку на карте и блокируется, пока адрес отправляется", async () => {
  const container = document.createElement("div");
  const root = createRoot(container);
  const onPrepare = vi.fn();
  const render = (preparing: boolean, prepareError = "") => root.render(createElement(PlaceSheet, {
    address: "ул. Пятницкая, 1", busy: false, error: "", preparing, prepareError, walkHref: null, onPrepare, onClose: () => {}, onWalk: () => {},
  }));
  await act(async () => render(false));
  const button = () => container.querySelector<HTMLButtonElement>("[data-sheet-part='footer'] button")!;
  await act(async () => button().click());
  expect(onPrepare).toHaveBeenCalledTimes(1);
  await act(async () => render(true));
  expect(button().disabled).toBe(true);
  expect(button().textContent).toContain("Отправляем адрес");
  await act(async () => render(false, "Лимит историй на сегодня исчерпан."));
  expect(container.querySelector("[role='alert']")?.textContent).toBe("Лимит историй на сегодня исчерпан.");
  await act(async () => root.unmount());
});

const point = { id: "11111111-1111-4111-8111-111111111111", address: "Москва, Арбат, 10", location: { lat: 55.75, lon: 37.59 } };
const job = (patch: Partial<GenerationJob>): GenerationJob => ({
  id: point.id, address: point.address, stage: "researching", revision: 1, createdAt: "", updatedAt: "", elapsedSec: 30,
  canRetry: false, error: null, story: null, audio: null, ...patch,
});
const readyStory = {
  title: "Дом на Арбате", address: point.address, wordCount: 300, verification: "automatic" as const,
  paragraphs: [{ text: "Первый абзац.", factIds: [] }, { text: "Второй абзац.", factIds: [] }],
  sources: [{ id: "s1", title: "Архив", url: "https://example.org/a", publisher: "Мосгорархив" }], facts: [],
};

async function renderStory(pin: ReturnType<typeof jobPin>, onRetry = vi.fn()) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(StorySheet, {
    story: pin, walkHref: null, onStart: () => {}, onClose: () => {}, onWalk: () => {}, onRetry,
  })));
  return { container, unmount: () => act(async () => root.unmount()) };
}

it.each([
  { case: "состояние ещё не загружено", value: undefined, status: "Загружаем состояние истории" },
  { case: "идёт подготовка", value: job({ stage: "voicing" }), status: "Озвучиваем" },
])("карточка заказанной истории показывает этап: $case", async ({ value, status }) => {
  const { container, unmount } = await renderStory(jobPin(point, value));
  expect(container.querySelector("[role='status']")?.textContent).toContain(status);
  expect(container.querySelector("[data-sheet-part='footer'] :is(a, button)")).toBeNull();
  await unmount();
});

it("готовая заказанная история показывает текст, источники и запись прямо на карте", async () => {
  const { container, unmount } = await renderStory(jobPin(point, job({
    stage: "ready", story: readyStory, audio: { url: "/api/story-audio/a.mp3", sha256: "a", bytes: 1, durationSec: 300, synthetic: true },
  })));
  expect(container.querySelector("#selected-place-title")?.textContent).toBe("Дом на Арбате");
  expect([...container.querySelectorAll("p")].map(p => p.textContent)).toEqual(expect.arrayContaining(["Первый абзац.", "Второй абзац."]));
  expect(container.querySelector("a[href='https://example.org/a']")?.textContent).toBe("Архив");
  expect(container.textContent).toContain("редактор ещё не проверял");
  expect(container.querySelector("audio")?.getAttribute("src")).toBe("/api/story-audio/a.mp3");
  expect(container.querySelector("a[href^='/create']")).toBeNull();
  await unmount();
});

it.each([
  { case: "текст не подготовлен", value: job({ stage: "failed", canRetry: true, error: { code: "INTERRUPTED", message: "Подготовка прервалась." } }), label: "Повторить подготовку" },
  { case: "не удалась озвучка", value: job({ stage: "failed", canRetry: true, story: readyStory, error: { code: "TTS", message: "Озвучка не удалась." } }), label: "Повторить озвучку" },
])("прерванную историю можно повторить с карты: $case", async ({ value, label }) => {
  const onRetry = vi.fn();
  const { container, unmount } = await renderStory(jobPin(point, value), onRetry);
  expect(container.textContent).toContain(value.error!.message);
  const retry = container.querySelector<HTMLButtonElement>("[data-sheet-part='footer'] button")!;
  expect(retry.textContent).toContain(label);
  await act(async () => retry.click());
  expect(onRetry).toHaveBeenCalledTimes(1);
  await unmount();
});

const place = { ...point, title: "Дом на Арбате" };

it.each([
  { case: "место из каталога", pin: { ...place, placeId: "place-1" }, expandable: true },
  { case: "готовая заказанная история с текстом", pin: { ...place, jobId: point.id, paragraphs: ["Текст."] }, expandable: true },
  { case: "история ещё готовится", pin: { ...place, jobId: point.id, pending: true }, expandable: false },
  { case: "часть прогулки", pin: { ...place, chapter: 0, paragraphs: ["Текст."] }, expandable: false },
  { case: "часть прогулки по месту каталога", pin: { ...place, chapter: 1, placeId: "place-1" }, expandable: false },
])("раскрывается ли карточка: $case", ({ pin, expandable }) => {
  expect(isExpandableStory(pin)).toBe(expandable);
});

async function renderReading(pin: ReturnType<typeof jobPin>, expanded: boolean, onExpand = vi.fn(), onCollapse = vi.fn()) {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(StorySheet, {
    story: pin, walkHref: "/?walk=create", onStart: () => {}, onClose: () => {}, onWalk: () => {}, expanded, onExpand, onCollapse,
  })));
  const handle = container.querySelector<HTMLButtonElement>("[data-sheet-part='handle'] button");
  return { container, handle, unmount: () => act(async () => root.unmount()) };
}

const readyPin = () => jobPin(point, job({ stage: "ready", story: readyStory, audio: { url: "/api/story-audio/a.mp3", sha256: "a", bytes: 1, durationSec: 300, synthetic: true } }));
const texts = (container: HTMLElement) => [...container.querySelectorAll("[data-sheet-part='body'] p")].map(p => p.textContent);

it("свёрнутая история показывает только начало текста, а нажатие на него раскрывает её", async () => {
  const onExpand = vi.fn();
  const { container, handle, unmount } = await renderReading(readyPin(), false, onExpand);
  expect(handle?.getAttribute("aria-expanded")).toBe("false");
  expect(handle?.getAttribute("aria-label")).toBe("Читать историю полностью");
  expect(texts(container)).toEqual(["Первый абзац."]);
  expect(container.querySelector("[role='region'][aria-label='Текст истории']")).not.toBeNull();
  expect(container.textContent).not.toContain("Создать прогулку отсюда");
  expect(container.textContent).not.toContain("Источники");
  expect(container.querySelector("[data-sheet-part='header'] #selected-place-title")).not.toBeNull();
  // The peek names the place only; the address is for the expanded card.
  expect(container.textContent).not.toContain(point.address);
  expect(container.querySelector("[data-sheet-part='corner'] button[aria-label='Закрыть карточку']")).not.toBeNull();
  expect(container.querySelector("[data-sheet-part='footer'] audio")).not.toBeNull();
  await act(async () => container.querySelector<HTMLElement>("[data-sheet-part='body'] p")!.click());
  await act(async () => container.querySelector<HTMLElement>("#selected-place-title")!.click());
  expect(onExpand).toHaveBeenCalledTimes(2);
  await unmount();
});

it("раскрытая история показывает весь текст, источники и ссылку на прогулку; ручка её сворачивает", async () => {
  const onExpand = vi.fn(), onCollapse = vi.fn();
  const { container, handle, unmount } = await renderReading(readyPin(), true, onExpand, onCollapse);
  expect(handle?.getAttribute("aria-expanded")).toBe("true");
  expect(handle?.getAttribute("aria-label")).toBe("Свернуть историю");
  expect(texts(container)).toEqual(expect.arrayContaining(["Первый абзац.", "Второй абзац."]));
  expect(container.textContent).toContain("Источники");
  expect(container.textContent).toContain("Создать прогулку отсюда");
  expect(container.querySelector("[data-sheet-part='body'] #selected-place-title")).not.toBeNull();
  expect(container.querySelector("[data-sheet-part='body']")?.textContent).toContain(point.address);
  await act(async () => container.querySelector<HTMLElement>("[data-sheet-part='body'] p")!.click());
  expect(onExpand).not.toHaveBeenCalled();
  await act(async () => handle!.click());
  expect(onCollapse).toHaveBeenCalledTimes(1);
  await unmount();
});

it("«Повторить» в свёрнутой карточке места загружает текст снова, а не раскрывает карточку", async () => {
  const fetch = vi.fn(async () => new Response("{}", { status: 400 }));
  vi.stubGlobal("fetch", fetch);
  const onExpand = vi.fn();
  const { container, unmount } = await renderReading({ ...place, id: "place:retry", placeId: "retry-place" }, false, onExpand);
  await act(async () => { await vi.waitFor(() => expect(container.querySelector("[role='alert']")).not.toBeNull()); });
  const calls = fetch.mock.calls.length;
  await act(async () => container.querySelector<HTMLButtonElement>("[role='alert'] button")!.click());
  expect(onExpand).not.toHaveBeenCalled();
  expect(fetch.mock.calls.length).toBeGreaterThan(calls);
  await unmount();
});

it("история, которая ещё готовится, остаётся обычной карточкой без ручки", async () => {
  const { container, handle, unmount } = await renderReading(jobPin(point, job({ stage: "voicing" })), false);
  expect(handle).toBeNull();
  expect(container.querySelector("section")?.hasAttribute("data-expandable")).toBe(false);
  expect(container.querySelector("[data-sheet-part='header'] button[aria-label='Закрыть карточку']")).not.toBeNull();
  await unmount();
});
