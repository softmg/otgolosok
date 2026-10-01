// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SharedWalkAdmin, WalkAdminSection } from "./shared-walk-admin";
import type { AdminApi, AdminRun } from "./model";

const walk = { id: "walk", title: "Арбат", shareToken: "public-token", revision: 2, visibility: "shared", listingStatus: null, author: { id: "anna", name: "Анна", email: "anna@example.test" },
  mode: "loop", stopCount: 4, walkingMinutes: 20, distanceM: 1200, snapshotError: null,
  createdAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T11:00:00Z" };
let root: Root, container: HTMLDivElement;
const request = vi.fn();
const api: AdminApi = async <T,>(path: string, _signal: AbortSignal, body?: unknown): Promise<T> => (body === undefined ? request(path) : request(path, body)) as Promise<T>;

function Harness() {
  const [busy, setBusy] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label);
    try { await action(new AbortController().signal); } catch { /* The component also offers retry. */ }
    finally { setBusy(""); }
  };
  return createElement(SharedWalkAdmin, { api, run, busy });
}
function button(text: string) { return [...container.querySelectorAll("button")].find(item => item.textContent === text)!; }
async function click(text: string) { await act(async () => button(text).click()); }
async function mount() { await act(async () => root.render(createElement(Harness))); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  request.mockResolvedValue({ walks: [walk], total: 26, offset: 0, hasMore: true, pending: 0 });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows author, route metadata and the public link, and confirms a successful copy", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
  await mount();
  expect(container.textContent).toContain("anna@example.test");
  expect(container.textContent).toContain("Точек: 4 · 1,2 км · 20 мин пешком");
  expect(container.querySelector("a")?.getAttribute("href")).toBe("/walk?share=public-token");
  await click("Скопировать ссылку");
  expect(writeText).toHaveBeenCalledWith(new URL("/walk?share=public-token", window.location.origin).href);
  expect(container.textContent).toContain("Ссылка на «Арбат» скопирована.");
});

it("offers a selectable URL when clipboard access fails", async () => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
  await mount(); await click("Скопировать ссылку");
  const input = container.querySelector<HTMLInputElement>("input[readonly]")!;
  expect(input.value).toBe(new URL("/walk?share=public-token", window.location.origin).href);
  await act(async () => input.focus());
  expect(input.selectionEnd).toBe(input.value.length);
  expect(container.textContent).toContain("Браузер не разрешил копирование");
});

it("loads the next page and accepts the server offset after a page disappears", async () => {
  await mount();
  request.mockResolvedValueOnce({ walks: [{ ...walk, title: "Последняя прогулка" }], total: 26, offset: 25, hasMore: false, pending: 0 });
  await click("Далее");
  expect(request.mock.lastCall?.[0]).toContain("offset=25");
  expect(container.textContent).toContain("Страница 2 из 2");
  expect(button("Далее").disabled).toBe(true);
  request.mockResolvedValueOnce({ walks: [walk], total: 25, offset: 0, hasMore: false, pending: 0 });
  await click("Обновить список");
  expect(container.textContent).toContain("Страница 1 из 1");
  expect(button("Назад").disabled).toBe(true);
});

it("keeps a failed load retryable and distinguishes an empty result", async () => {
  request.mockRejectedValueOnce(new Error("offline"));
  await mount();
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Не удалось загрузить список");
  request.mockResolvedValueOnce({ walks: [], total: 0, offset: 0, hasMore: false, pending: 0 });
  await click("Повторить");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain("Пока никто не открыл доступ");
  expect(button("Далее").disabled).toBe(true);
});

it("renders a damaged walk with an unknown author without invented route metrics", async () => {
  request.mockResolvedValueOnce({ walks: [{ ...walk, author: null, mode: null, stopCount: null, distanceM: null, walkingMinutes: null, snapshotError: "Повреждён" }], total: 1, offset: 0, hasMore: false, pending: 0 });
  await mount();
  expect(container.textContent).toContain("Автор неизвестен");
  expect(container.textContent).toContain("Снимок повреждён");
  expect(container.textContent).not.toContain("мин пешком");
});

const publicWalk = (listingStatus: "pending" | "approved" | "hidden") => ({ ...walk, id: `walk-${listingStatus}`, title: `Всем ${listingStatus}`, visibility: "public", listingStatus });

it("shows access in words and offers only the actions that change the top state", async () => {
  request.mockResolvedValue({ walks: [walk, publicWalk("pending"), publicWalk("approved"), publicWalk("hidden")], total: 4, offset: 0, hasMore: false, pending: 0 });
  await mount();
  const rows = [...container.querySelectorAll("tbody tr")];
  const actions = (row: Element) => [...row.querySelectorAll("button")].map(item => item.textContent);
  expect(rows.map(row => row.children[4].textContent)).toEqual(["По ссылке", "Всем · на проверке", "Всем · в топе", "Всем · скрыта из топа"]);
  expect(rows.map(actions)).toEqual([
    ["Скопировать ссылку"],
    ["Скопировать ссылку", "Одобрить для топа", "Скрыть из топа"],
    ["Скопировать ссылку", "Скрыть из топа"],
    ["Скопировать ссылку", "Одобрить для топа"],
  ]);
});

it("opens the moderation queue first while public walks await review", async () => {
  request.mockResolvedValueOnce({ walks: [walk], total: 3, offset: 0, hasMore: false, pending: 2 })
    .mockResolvedValueOnce({ walks: [publicWalk("pending")], total: 2, offset: 0, hasMore: false, pending: 2 });
  await mount();
  expect(request.mock.calls.map(([path]) => new URLSearchParams(String(path).split("?")[1]).get("listing"))).toEqual(["all", "pending"]);
  const selects = [...container.querySelectorAll("select")];
  expect(selects.find(item => item.previousSibling?.textContent === "Топ")?.value).toBe("pending");
});

it("filters by access and top state", async () => {
  await mount();
  const [, access, listing] = [...container.querySelectorAll("select")];
  await act(async () => {
    access.value = "public"; access.dispatchEvent(new Event("change", { bubbles: true }));
    listing.value = "hidden"; listing.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await click("Найти");
  const query = new URLSearchParams(String(request.mock.lastCall?.[0]).split("?")[1]);
  expect([query.get("access"), query.get("listing")]).toEqual(["public", "hidden"]);
});

it("approves with the revision the editor saw and reloads the page", async () => {
  request.mockResolvedValue({ walks: [publicWalk("pending")], total: 1, offset: 0, hasMore: false, pending: 1 });
  await mount();
  request.mockClear();
  request.mockImplementation(async (path: string) => path.endsWith("/listing") ? { walk: {} } : { walks: [publicWalk("approved")], total: 1, offset: 0, hasMore: false, pending: 0 });
  await click("Одобрить для топа");
  expect(request.mock.calls[0]).toEqual(["/walks/shared/walk-pending/listing", { action: "approve", revision: 2 }]);
  expect(request.mock.calls[1][0]).toMatch(/^\/walks\/shared\?/);
  expect(container.textContent).toContain("«Всем pending» в топе.");
});

it("explains a 409 and refreshes the list instead of failing", async () => {
  request.mockResolvedValue({ walks: [publicWalk("pending")], total: 1, offset: 0, hasMore: false, pending: 1 });
  await mount();
  request.mockImplementation(async (path: string) => {
    if (path.endsWith("/listing")) throw Object.assign(new Error("Conflict"), { status: 409 });
    return { walks: [publicWalk("pending")], total: 1, offset: 0, hasMore: false, pending: 1 };
  });
  await click("Скрыть из топа");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Прогулка изменилась — обновите список.");
});

it("shows the pending counter in the tab title", async () => {
  request.mockResolvedValue({ walks: [publicWalk("pending")], total: 3, offset: 0, hasMore: false, pending: 3 });
  const props = { api, busy: "", run: (async (_label, action) => { await action(new AbortController().signal); }) as AdminRun, openJob: () => {}, onDirtyChange: () => {} };
  await act(async () => root.render(createElement(WalkAdminSection, props)));
  await act(async () => {});
  expect(container.querySelector("nav button")?.textContent).toBe("Пользовательские · 3");
});
