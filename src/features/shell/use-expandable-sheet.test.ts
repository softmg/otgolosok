// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useExpandableSheet, type ExpandableSheet } from "./use-expandable-sheet";

let root: Root;
let sheet: ExpandableSheet;

function Probe({ id, report }: { id: string | undefined; report: (value: ExpandableSheet) => void }) {
  const value = useExpandableSheet(id);
  useEffect(() => report(value));
  return null;
}

async function render(id: string | undefined) {
  await act(async () => { root.render(createElement(Probe, { id, report: value => { sheet = value; } })); });
}

async function popTo(state: unknown) {
  history.replaceState(state, "");
  await act(async () => { dispatchEvent(new PopStateEvent("popstate", { state })); });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query }));
  history.replaceState({ __NA: true }, "", "/?x=1");
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

it("раскрытие добавляет запись истории с ключом карточки и не меняет адрес", async () => {
  await render("story-1");
  const before = history.length;
  await act(async () => { sheet.expand(); });
  expect(sheet.expanded).toBe(true);
  expect(history.length).toBe(before + 1);
  expect(history.state).toMatchObject({ otgolosokSheet: "story-1" });
  expect(location.pathname + location.search).toBe("/?x=1");
});

it("«Назад» сворачивает карточку, «Вперёд» раскрывает снова", async () => {
  await render("story-1");
  await act(async () => { sheet.expand(); });
  await popTo({ __NA: true });
  expect(sheet.expanded).toBe(false);
  await popTo({ __NA: true, otgolosokSheet: "story-1" });
  expect(sheet.expanded).toBe(true);
});

it("сворачивание уходит назад по истории, только если текущая запись — запись карточки", async () => {
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  await render("story-1");
  await act(async () => { sheet.expand(); });
  await act(async () => { sheet.collapse(); });
  expect(back).toHaveBeenCalledTimes(1);
  expect(sheet.expanded).toBe(true); // popstate from the real Back collapses it

  history.replaceState({ __NA: true }, "");
  await act(async () => { sheet.collapse(); });
  expect(back).toHaveBeenCalledTimes(1);
  expect(sheet.expanded).toBe(false);
});

it.each([
  { case: "перед закрытием карточки", options: undefined, backs: 1 },
  { case: "перед переходом по ссылке", options: { keepHistoryEntry: true }, backs: 0 },
])("dismiss сразу сворачивает: $case", async ({ options, backs }) => {
  const back = vi.spyOn(history, "back").mockImplementation(() => {});
  await render("story-1");
  await act(async () => { sheet.expand(); });
  await act(async () => { sheet.dismiss(options); });
  expect(sheet.expanded).toBe(false);
  expect(back).toHaveBeenCalledTimes(backs);
});

it("другая история и возврат к прежней начинаются свёрнутыми", async () => {
  await render("story-1");
  await act(async () => { sheet.expand(); });
  history.replaceState({ __NA: true }, "");
  await render("story-2");
  expect(sheet.expanded).toBe(false);
  await render("story-1");
  expect(sheet.expanded).toBe(false);
});

it("история, показанная на своей раскрытой записи, открывается раскрытой", async () => {
  await render(undefined);
  history.replaceState({ __NA: true, otgolosokSheet: "story-1" }, "");
  await render("story-1");
  expect(sheet.expanded).toBe(true);
});

it("перезагрузка на раскрытой записи начинается со свёрнутой карточки и убирает ключ", async () => {
  history.replaceState({ __NA: true, otgolosokSheet: "story-1" }, "");
  await render("story-1");
  expect(sheet.expanded).toBe(false);
  expect(history.state).toEqual({ __NA: true });
});

it("Escape сворачивает, но не из открытого окна просмотра фото", async () => {
  vi.spyOn(history, "back").mockImplementation(() => {});
  history.replaceState({ __NA: true }, "");
  await render("story-1");
  await act(async () => { sheet.expand(); });
  history.replaceState({ __NA: true }, ""); // collapse locally, without waiting for a popstate

  const dialog = document.createElement("dialog");
  dialog.setAttribute("open", "");
  const inside = document.createElement("button");
  dialog.append(inside);
  document.body.append(dialog);
  await act(async () => { inside.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(sheet.expanded).toBe(true);

  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(sheet.expanded).toBe(false);
});
