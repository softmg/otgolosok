// @vitest-environment jsdom

import { act, createElement, createRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ATTRIBUTION_COLLAPSE_MS, MapAttribution } from "./map-attribution";

let root: Root;
let container: HTMLDivElement;
let map: HTMLDivElement;

beforeEach(async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  map = document.createElement("div");
  container = document.createElement("div");
  document.body.append(map, container);
  root = createRoot(container);
  const surface = createRef<HTMLElement>() as { current: HTMLElement | null };
  surface.current = map;
  await act(async () => { root.render(createElement(MapAttribution, { surface })); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  map.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const link = () => container.querySelector("a");
const info = () => container.querySelector<HTMLButtonElement>('button[aria-label="Источник данных карты"]');

it("сначала показывает ссылку на лицензию OpenStreetMap без знака ©", () => {
  expect(link()?.textContent).toBe("OpenStreetMap");
  expect(link()?.getAttribute("href")).toBe("https://www.openstreetmap.org/copyright");
});

it("сворачивается в кнопку ровно через пять секунд", async () => {
  await act(async () => { vi.advanceTimersByTime(ATTRIBUTION_COLLAPSE_MS - 1); });
  expect(link()).not.toBeNull();
  await act(async () => { vi.advanceTimersByTime(1); });
  expect(link()).toBeNull();
  expect(info()).not.toBeNull();
});

it.each(["pointerdown", "wheel", "keydown"])("сворачивается сразу при %s на карте", async event => {
  await act(async () => { map.dispatchEvent(new Event(event)); });
  expect(info()).not.toBeNull();
});

it("кнопка снова открывает ссылку и переводит на неё фокус", async () => {
  await act(async () => { vi.advanceTimersByTime(ATTRIBUTION_COLLAPSE_MS); });
  await act(async () => { info()!.click(); });
  expect(document.activeElement).toBe(link());
});

it("не сворачивается по таймеру, пока ссылку читают с клавиатуры", async () => {
  link()!.focus();
  await act(async () => { vi.advanceTimersByTime(ATTRIBUTION_COLLAPSE_MS * 2); });
  expect(link()).not.toBeNull();
});
