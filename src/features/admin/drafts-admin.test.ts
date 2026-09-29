// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DraftsAdmin } from "./drafts-admin";
import type { AdminApi, AdminRun, ContentDraft, ContentDraftPage, ContentPlace, Draft } from "./model";

const draft = (index: number): ContentDraft => ({
  placeId: `osm:node:${index}`, name: `Место ${index}`, address: index === 1 ? "Москва, Арбат, 1" : null, location: { lat: 55.75 + index / 1000, lon: 37.61 },
  text: { id: `t${index}`, title: `Заголовок ${index}`, paragraphs: [`Первый абзац ${index}.`, `Второй абзац ${index}.`], verification: "automatic", createdAt: "2026-09-28T17:00:00Z" },
});

const story = (index: number): Draft => ({
  title: `Заголовок ${index}`,
  paragraphs: [{ text: `Первый абзац ${index}.`, factIds: ["f1"] }, { text: `Второй абзац ${index}.`, factIds: ["f2"] }],
});
const place = (index: number): ContentPlace => ({
  id: `osm:node:${index}`, name: `Место ${index}`, address: null, location: { lat: 55.75, lon: 37.61 },
  text: { id: `t${index}`, profile: "default", story: story(index), draft: story(index), verification: "automatic", audio: null, createdAt: "2026-09-28T17:00:00Z" },
});

let container: HTMLDivElement, root: Root, requests: string[], total: number, approved: { path: string; body: unknown }[], dirty: boolean[];
const api: AdminApi = async <T,>(path: string, _signal: AbortSignal, body?: unknown) => {
  requests.push(path);
  if (path.endsWith("/approve")) { approved.push({ path, body }); total -= 1; return { place: place(1) } as T; }
  if (path.startsWith("/content/places/")) return { place: place(Number(path.split(":").at(-1))) } as T;
  const offset = Number(new URLSearchParams(path.split("?")[1]).get("offset"));
  const items = Array.from({ length: Math.max(0, Math.min(50, total - offset)) }, (_, index) => draft(offset + index + 1 + approved.length));
  return { total, hasMore: offset + items.length < total, items } satisfies ContentDraftPage as T;
};
const run: AdminRun = async (_label, action) => { await action(new AbortController().signal); };

async function mount() {
  root = createRoot(container);
  await act(async () => { root.render(createElement(DraftsAdmin, { api, run, busy: "", onDirtyChange: value => { dirty.push(value); } })); });
}
/** React tracks the DOM value itself, so tests set it through the native setter before dispatching input. */
function edit(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const button = (label: string) => [...container.querySelectorAll("button")].find(item => item.textContent === label || item.getAttribute("aria-label") === label)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  requests = []; total = 2; approved = []; dirty = [];
  Element.prototype.scrollIntoView = vi.fn();
  container = document.createElement("div");
  document.body.append(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe("вкладка черновиков", () => {
  it("показывает черновики с координатами и копирует точку с абзацами", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await mount();
    expect(requests).toEqual(["/content/drafts?limit=50&offset=0"]);
    expect(container.textContent).toContain("Москва, Арбат, 1 · 55.751, 37.61");
    expect(container.textContent).toContain("Показано 1–2 из 2 черновиков.");
    await act(async () => { button("Копировать черновик: Место 1").click(); });
    expect(writeText).toHaveBeenCalledWith("Место: Место 1\nАдрес: Москва, Арбат, 1\nКоординаты: 55.751, 37.61\nOSM: osm:node:1\nЗаголовок: Заголовок 1\n\nАбзац 1: Первый абзац 1.\nАбзац 2: Второй абзац 1.");
    expect(container.textContent).toContain("Скопировано: Место 1.");
  });

  it("сообщает, если браузер не дал доступ к буферу обмена", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: async () => { throw new Error("denied"); } } });
    await mount();
    await act(async () => { button("Копировать черновик: Место 2").click(); });
    expect(container.textContent).toContain("Не удалось скопировать");
  });

  it("листает страницы и показывает пустой список", async () => {
    total = 60;
    await mount();
    await act(async () => { button("Далее").click(); });
    expect(requests.at(-1)).toBe("/content/drafts?limit=50&offset=50");
    expect(container.querySelectorAll("tbody tr")).toHaveLength(10);
    await act(async () => { root.unmount(); });
    total = 0;
    await mount();
    expect(container.textContent).toContain("Черновиков нет.");
  });

  it("открывает черновик формой по абзацам и утверждает правленый текст", async () => {
    await mount();
    await act(async () => { button("Открыть черновик: Место 1").click(); });
    expect(requests.at(-1)).toBe("/content/places/osm:node:1");
    expect(container.querySelector("#draft-place-title")?.textContent).toBe("Место 1");
    expect(document.activeElement?.id).toBe("draft-place-title");
    const second = container.querySelector<HTMLTextAreaElement>("#content-paragraph-1")!;
    expect(second.value).toBe("Второй абзац 1.");
    await act(async () => { edit(second, "Исправленный абзац."); });
    expect(container.textContent).toContain("есть несохранённые правки");
    expect(dirty.at(-1)).toBe(true);
    await act(async () => { button("Утвердить текст").click(); });
    expect(approved).toEqual([{ path: "/content/places/osm:node:1/approve", body: { story: {
      title: "Заголовок 1", paragraphs: [{ text: "Первый абзац 1.", factIds: ["f1"] }, { text: "Исправленный абзац.", factIds: ["f2"] }],
    } } }]);
    expect(container.querySelector("#draft-place-title")).toBeNull();
    expect(requests.at(-1)).toBe("/content/drafts?limit=50&offset=0");
    expect(container.textContent).toContain("Текст утверждён: Место 1.");
    expect(container.textContent).not.toContain("Копировать черновик: Место 1");
    expect(button("Копировать черновик: Место 2")).toBeDefined();
    expect(dirty.at(-1)).toBe(false);
  });

  it("не даёт утвердить текст с пустым абзацем", async () => {
    await mount();
    await act(async () => { button("Открыть черновик: Место 2").click(); });
    await act(async () => { edit(container.querySelector<HTMLTextAreaElement>("#content-paragraph-0")!, "   "); });
    expect(button("Утвердить текст").disabled).toBe(true);
  });

  it("спрашивает перед закрытием правленого черновика и оставляет его при отказе", async () => {
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    await mount();
    await act(async () => { button("Открыть черновик: Место 1").click(); });
    await act(async () => { edit(container.querySelector<HTMLInputElement>("#content-title")!, "Новый заголовок"); });
    await act(async () => { button("Закрыть").click(); });
    expect(confirm).toHaveBeenCalledOnce();
    expect(container.querySelector<HTMLInputElement>("#content-title")?.value).toBe("Новый заголовок");
    confirm.mockReturnValue(true);
    await act(async () => { button("Закрыть").click(); });
    expect(container.querySelector("#draft-place-title")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Открыть черновик: Место 1");
  });
});
