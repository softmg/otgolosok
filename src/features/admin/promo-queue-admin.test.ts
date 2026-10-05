// @vitest-environment jsdom
import { act, createElement, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PromoQueueAdmin } from "./promo-queue-admin";
import { SharedWalkAdmin } from "./shared-walk-admin";
import { canEnqueue, promoText, slotLabel } from "./promo-queue-model";
import type { AdminApi, AdminRun } from "./model";

const item = (title: string, status: string, extra: Record<string, unknown> = {}) => ({
  id: `id-${title}`, walkId: `walk-${title}`, title, shareToken: `token-${title}`, visibility: "public", position: 1, status,
  slotAt: "2026-10-09T18:00:00.000Z", runId: null, youtubeUrl: null, telegramUrl: null, error: null, revision: 3,
  createdAt: "2026-10-05T10:00:00Z", updatedAt: "2026-10-05T10:00:00Z", ...extra,
});
const walk = (visibility: string, promo: unknown = null) => ({ id: "walk", title: "Арбат", shareToken: "t", revision: 2, visibility, listingStatus: visibility === "public" ? "approved" : null,
  author: null, mode: "loop", stopCount: 4, walkingMinutes: 20, distanceM: 1200, snapshotError: null, launches: 0,
  createdAt: "2026-09-30T10:00:00Z", updatedAt: "2026-09-30T11:00:00Z", promo });

let root: Root, container: HTMLDivElement;
const request = vi.fn();
const api: AdminApi = async <T,>(path: string, _signal: AbortSignal, body?: unknown): Promise<T> => (body === undefined ? request(path) : request(path, body)) as Promise<T>;
function Harness({ component }: { component: typeof PromoQueueAdmin | typeof SharedWalkAdmin }) {
  const [busy, setBusy] = useState("");
  const run: AdminRun = async (label, action) => {
    setBusy(label);
    try { await action(new AbortController().signal); } catch { /* retry is offered */ }
    finally { setBusy(""); }
  };
  return createElement(component, { api, run, busy });
}
const button = (text: string) => [...container.querySelectorAll("button")].find(entry => entry.textContent === text);
async function mount(component: typeof PromoQueueAdmin | typeof SharedWalkAdmin) { await act(async () => root.render(createElement(Harness, { component }))); }
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  request.mockReset();
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it.each([
  ["2026-10-09T18:00:00.000Z", "пт, 9 октября в 21:00 МСК"],
  ["2026-10-12T16:00:00.000Z", "пн, 12 октября в 19:00 МСК"],
])("shows slot %s in Moscow time", (slot, expected) => {
  expect(slotLabel(slot).replace(/\s+/g, " ")).toBe(expected);
});

it.each([
  [null, "Без промо", true],
  [{ status: "queued", slotAt: "2026-10-12T16:00:00.000Z", youtubeUrl: null }, "в очереди · пн, 12 октября в 19:00 МСК", false],
  [{ status: "published", slotAt: null, youtubeUrl: "https://www.youtube.com/shorts/x" }, "Опубликован", true],
] as const)("promo state %o reads as «%s»", (promo, text, enqueue) => {
  expect(promoText(promo).replace(/\s+/g, " ")).toBe(text);
  expect(canEnqueue(promo)).toBe(enqueue);
});

it("asks before queueing a link-only walk and sends nothing when declined", async () => {
  request.mockResolvedValue({ walks: [walk("shared")], total: 1, offset: 0, hasMore: false, pending: 0 });
  const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
  await mount(SharedWalkAdmin);
  expect(container.textContent).toContain("Без промо");
  await act(async () => button("В очередь промо")!.click());
  expect(confirm).toHaveBeenCalledWith(expect.stringContaining("станет публичной"));
  expect(request).not.toHaveBeenCalledWith("/promo-queue", expect.anything());
  confirm.mockReturnValue(true);
  request.mockResolvedValueOnce({ item: item("Арбат", "queued") });
  await act(async () => button("В очередь промо")!.click());
  expect(request).toHaveBeenCalledWith("/promo-queue", { walkId: "walk" });
  expect(container.textContent).toContain("«Арбат» в очереди промо.");
});

it("queues a public walk without asking and hides the button for an active item", async () => {
  request.mockResolvedValue({ walks: [walk("public")], total: 1, offset: 0, hasMore: false, pending: 0 });
  const confirm = vi.spyOn(window, "confirm");
  await mount(SharedWalkAdmin);
  request.mockResolvedValueOnce({ item: item("Арбат", "queued") })
    .mockResolvedValueOnce({ walks: [walk("public", { status: "queued", slotAt: "2026-10-12T16:00:00.000Z", youtubeUrl: null })], total: 1, offset: 0, hasMore: false, pending: 0 });
  await act(async () => button("В очередь промо")!.click());
  expect(confirm).not.toHaveBeenCalled();
  expect(button("В очередь промо")).toBeUndefined();
  expect(container.textContent).toContain("в очереди · пн, 12 октября");
});

it("passes the promo filter to the list request", async () => {
  request.mockResolvedValue({ walks: [], total: 0, offset: 0, hasMore: false, pending: 0 });
  await mount(SharedWalkAdmin);
  const select = [...container.querySelectorAll("label")].find(label => label.textContent?.startsWith("Промо"))!.querySelector("select")!;
  await act(async () => { select.value = "none"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => button("Найти")!.click());
  expect(String(request.mock.calls.at(-1)?.[0])).toContain("promo=none");
});

it("lists the queue with Moscow slots, moves an item up and reloads on a stale revision", async () => {
  request.mockResolvedValue({ items: [item("Арбат", "ready"), item("Бульвары", "queued"), item("Чистые пруды", "queued")], history: [item("Таганка", "failed", { error: "WALK_START" })] });
  await mount(PromoQueueAdmin);
  expect(container.textContent).toContain("готов к выходу");
  expect(container.textContent).toContain("Отменить или перенести — кнопками в боте");
  expect(container.textContent).toContain("WALK_START");
  // The first queued item cannot move up; the second can.
  expect(button("Выше")).toBeDefined();
  expect([...container.querySelectorAll("button")].filter(entry => entry.textContent === "Выше")).toHaveLength(1);
  request.mockRejectedValueOnce(Object.assign(new Error("stale"), { status: 409 }));
  await act(async () => button("Выше")!.click());
  expect(request).toHaveBeenCalledWith(`/promo-queue/${encodeURIComponent("id-Чистые пруды")}/up`, { revision: 3 });
  expect(container.textContent).toContain("Очередь изменилась — список обновлён.");
  await act(async () => button("Вернуть в очередь")!.click());
  expect(request).toHaveBeenCalledWith(`/promo-queue/${encodeURIComponent("id-Таганка")}/requeue`, { revision: 3 });
});
