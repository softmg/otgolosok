// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NearbySheet, PlaceSheet } from "./around-sheets";
import type { NearbyRecommendation } from "./nearby-stories";

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
  { case: "точка без дома", address: null, error: "", walkHref: "/?walk=create&lat=55.75", title: "Не знаем, что здесь", actions: [["Создать прогулку отсюда", "/?walk=create&lat=55.75"]] },
  { case: "дом найден", address: "ул. Пятницкая, 1", error: "", walkHref: "/?walk=create", title: "ул. Пятницкая, 1", actions: [["История этого дома", "/create?x=1"], ["Создать прогулку отсюда", "/?walk=create"]] },
  { case: "адрес не определился", address: null, error: "Не удалось определить адрес.", walkHref: null, title: "О чём расскажет этот дом?", actions: [["Ввести адрес вручную", "/create?x=1"]] },
])("карточка выбранной точки: $case", async ({ address, error, walkHref, title, actions }) => {
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(createElement(PlaceSheet, {
    address, busy: false, error, createHref: "/create?x=1", walkHref, onClose: () => {}, onWalk: () => {},
  })));
  expect(container.querySelector("#new-place-title")?.textContent).toBe(title);
  expect([...container.querySelectorAll("[data-sheet-part='footer'] a")].map(link => [link.textContent?.trim(), link.getAttribute("href")])).toEqual(actions);
  expect(container.textContent).not.toContain("нет точного номера дома");
  await act(async () => root.unmount());
});
