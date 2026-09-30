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
