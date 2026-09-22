// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../auth/client", () => ({ getSession: async () => null, accountApi: async () => ({ walks: [] }) }));
vi.mock("./walk-loader", () => ({ loadCatalogCards: async () => [] }));

const { WalkLibrary } = await import("./walk-library");

let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(WalkLibrary)); });
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("пустая история прогулок", () => {
  it("разделяет предложения пробелом, чтобы перенос строки можно было скрыть на узком экране", () => {
    const empty = container.querySelector(".history-empty p");
    expect(empty?.querySelector("br")).not.toBeNull();
    // На ширине до 699px CSS прячет <br>, поэтому пробел должен быть в самом тексте.
    expect(empty?.textContent).toContain("начало маршрута. Сохранённые прогулки");
  });
});
