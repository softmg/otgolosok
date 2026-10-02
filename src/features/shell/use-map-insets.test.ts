// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MapInsets } from "./map-insets";
import { useMapInsets } from "./use-map-insets";

let root: Root;
let insets: MapInsets;
let resize: (() => void) | undefined;
/** jsdom has no layout: the test decides where the free cell is. */
let freeBottom = 600;

const cell = (part: string) => { const element = document.createElement("div"); element.dataset.part = part; return { current: element }; };
const map = cell("map"), free = cell("free");

function Probe({ frozen, report }: { frozen: boolean; report: (value: MapInsets) => void }) {
  const value = useMapInsets(map, free, frozen);
  useEffect(() => report(value));
  return null;
}

const render = (frozen: boolean) => act(async () => { root.render(createElement(Probe, { frozen, report: value => { insets = value; } })); });

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  resize = undefined;
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() { resize = undefined; }
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const free = this.dataset.part === "free";
    return { top: free ? 60 : 0, left: 0, right: 400, bottom: free ? freeBottom : 800 } as DOMRect;
  });
  freeBottom = 600;
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("пока карточка раскрыта, отступы карты не меняются, а после — измеряются один раз заново", async () => {
  await render(false);
  expect(insets).toEqual({ top: 60, right: 0, bottom: 200, left: 0 });

  await render(true);
  freeBottom = 100; // the free cell is hidden under the sheet
  await act(async () => { resize?.(); dispatchEvent(new Event("resize")); });
  expect(resize).toBeUndefined();
  expect(insets).toEqual({ top: 60, right: 0, bottom: 200, left: 0 });

  freeBottom = 500; // a real resize happened meanwhile
  await render(false);
  expect(insets).toEqual({ top: 60, right: 0, bottom: 300, left: 0 });
});
