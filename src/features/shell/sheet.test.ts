// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Sheet } from "./sheet";

let root: Root;
let container: HTMLDivElement;
let resize: () => void;
/** jsdom has no layout: the test decides how tall the body content is. */
let contentHeight = 100;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback; } observe() {} disconnect() {} });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(200);
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(() => contentHeight);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render() {
  await act(async () => {
    root.render(createElement(Sheet, { label: "История места", header: "Заголовок", footer: createElement("button", null, "Слушать"), bodyLabel: "Текст истории" }, "Текст"));
  });
  return {
    sheet: container.querySelector("section")!,
    body: container.querySelector<HTMLElement>('[data-sheet-part="body"]')!,
  };
}

it("делит панель на шапку, тело и подвал и называет её", async () => {
  const { sheet, body } = await render();
  expect(sheet.getAttribute("aria-label")).toBe("История места");
  expect([...sheet.children].map(part => part.getAttribute("data-sheet-part"))).toEqual(["header", "body", "footer"]);
  expect(body.getAttribute("role")).toBe("region");
  expect(body.getAttribute("aria-label")).toBe("Текст истории");
});

it("тело без прокрутки не занимает место в порядке Tab", async () => {
  contentHeight = 100;
  const { body } = await render();
  expect(body.hasAttribute("tabindex")).toBe(false);
});

it("прокручиваемое тело можно листать с клавиатуры, и это меняется вместе с содержимым", async () => {
  contentHeight = 500;
  const { body } = await render();
  expect(body.tabIndex).toBe(0);
  contentHeight = 150;
  await act(async () => { resize(); });
  expect(body.hasAttribute("tabindex")).toBe(false);
});

it("кнопки поверх карточки стоят в одной строке сверху, а раскрываемость видна по атрибутам", async () => {
  const draw = (expanded: boolean) => act(async () => {
    root.render(createElement(Sheet, { id: "story", label: "История", corner: createElement("button", null, "×"),
      handle: createElement("button", null, "Ручка"), expanded, header: "Заголовок", bodyLabel: "Текст истории" }, "Текст"));
  });
  await draw(false);
  const sheet = container.querySelector("section")!;
  expect(sheet.id).toBe("story");
  expect([...sheet.children].map(part => part.getAttribute("data-sheet-part"))).toEqual(["chrome", "header", "body"]);
  expect([...sheet.firstElementChild!.children].map(part => part.getAttribute("data-sheet-part"))).toEqual(["handle", "corner"]);
  expect(sheet.hasAttribute("data-expandable")).toBe(true);
  expect(sheet.hasAttribute("data-expanded")).toBe(false);
  await draw(true);
  expect(sheet.hasAttribute("data-expanded")).toBe(true);
});

it("тело раскрываемой карточки не встаёт в порядок Tab, даже если текст обрезан", async () => {
  contentHeight = 500;
  await act(async () => {
    root.render(createElement(Sheet, { label: "История", handle: createElement("button", null, "Ручка"), bodyLabel: "Текст истории" }, "Текст"));
  });
  expect(container.querySelector('[data-sheet-part="body"]')!.hasAttribute("tabindex")).toBe(false);
});

it("без ручки карточка не раскрывается, даже если её просят", async () => {
  await act(async () => { root.render(createElement(Sheet, { label: "История", expanded: true }, "Текст")); });
  const sheet = container.querySelector("section")!;
  expect(sheet.hasAttribute("data-expandable")).toBe(false);
  expect(sheet.hasAttribute("data-expanded")).toBe(false);
});
