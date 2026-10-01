// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { WalkCard } from "./walk-loader";

const auth = vi.hoisted(() => ({
  user: null as null | { id: string; name: string },
  walks: [] as WalkCard[],
  requests: [] as Array<{ path: string; init?: RequestInit }>,
  respond: null as null | ((path: string, init?: RequestInit) => unknown),
}));
vi.mock("../auth/client", () => ({
  getSession: async () => auth.user,
  accountApi: async (path: string, init?: RequestInit) => {
    auth.requests.push({ path, init });
    if (auth.respond && init?.method) return auth.respond(path, init);
    return { walks: auth.walks, nextCursor: null };
  },
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams(location.search) }));
vi.mock("./top-walks", () => ({ TopWalks: () => createElement("p", { "data-testid": "top" }, "ТОП") }));

const { WalkLibrary, selectedTab } = await import("./walk-library");
const { accessLabel } = await import("./access-dialog");

let root: Root;
let container: HTMLDivElement;

async function render() {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => { root.render(createElement(WalkLibrary)); });
}

const accountWalk = (patch: Partial<WalkCard & { draft: boolean }> = {}): WalkCard & { draft: boolean } => ({
  id: "11111111-1111-4111-8111-111111111111", title: "Арбат", revision: 3, kind: "account", visibility: "private", shareToken: null, listingStatus: null, draft: false, updatedAt: "2026-10-01T00:00:00.000Z", ...patch,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  history.replaceState(null, "", "/history");
  auth.user = null; auth.walks = []; auth.requests = []; auth.respond = null;
  // jsdom has no modal dialogs.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) { this.setAttribute("open", ""); };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) { this.removeAttribute("open"); };
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const tab = (name: string) => [...container.querySelectorAll<HTMLButtonElement>("[role=tab]")].find(item => item.textContent === name)!;

describe("пустая история прогулок", () => {
  it("разделяет предложения пробелом, чтобы перенос строки можно было скрыть на узком экране", async () => {
    history.replaceState(null, "", "/history?tab=mine");
    await render();
    const empty = container.querySelector(".history-empty p");
    expect(empty?.querySelector("br")).not.toBeNull();
    // На ширине до 699px CSS прячет <br>, поэтому пробел должен быть в самом тексте.
    expect(empty?.textContent).toContain("начало маршрута. Сохранённые прогулки");
  });
});

describe("вкладки «Мои прогулки» и «Топ прогулок»", () => {
  it.each([
    [null, true, 0, null], [null, false, 0, "top"], [null, false, 2, "mine"],
    ["top", true, 0, "top"], ["top", false, 5, "top"], ["mine", false, 0, "mine"], ["other", false, 1, "mine"],
  ] as const)("tab=%s, загрузка=%s, своих=%s → %s", (param, loading, count, expected) => {
    expect(selectedTab(param, loading, count)).toBe(expected);
  });

  it("без своих прогулок открывает топ", async () => {
    await render();
    expect(tab("Топ прогулок").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("#history-panel-mine")?.hasAttribute("hidden")).toBe(true);
    expect(container.querySelector("[data-testid=top]")).not.toBeNull();
  });

  it("со своими прогулками открывает «Мои», а топ не загружает", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk()];
    await render();
    expect(tab("Мои прогулки").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector("[data-testid=top]")).toBeNull();
  });

  it("уважает ?tab=top даже при своих прогулках", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk()];
    history.replaceState(null, "", "/history?tab=top");
    await render();
    expect(tab("Топ прогулок").getAttribute("aria-selected")).toBe("true");
  });

  it("переключение вкладки меняет адрес без перехода", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk()];
    await render();
    await act(async () => { tab("Мои прогулки").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })); });
    expect(location.search).toBe("?tab=top");
  });
});

describe("доступ к прогулке", () => {
  it.each([
    [{ visibility: "private", listingStatus: null }, "Только я"],
    [{ visibility: "shared", listingStatus: null }, "По ссылке"],
    [{ visibility: "public", listingStatus: "pending" }, "Всем · на проверке"],
    [{ visibility: "public", listingStatus: "approved" }, "Всем · в топе"],
    [{ visibility: "public", listingStatus: "hidden" }, "Всем · скрыта редакцией из топа"],
  ] as const)("%o → «%s»", (card, label) => { expect(accessLabel(card)).toBe(label); });

  it("сохраняет «Доступно всем», копирует ссылку и обновляет карточку", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk()];
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    auth.respond = () => ({ walk: accountWalk({ revision: 4, visibility: "public", listingStatus: "pending", shareToken: "22222222-2222-4222-8222-222222222222" }) });
    await render();
    expect(container.textContent).toContain("Доступ: Только я");
    const open = [...container.querySelectorAll("button")].find(item => item.textContent === "Доступ")!;
    await act(async () => { open.click(); });
    const dialog = container.querySelector("dialog")!;
    expect(dialog.hasAttribute("open")).toBe(true);
    const everyone = dialog.querySelector<HTMLInputElement>("input[value=public]")!;
    await act(async () => { everyone.click(); });
    await act(async () => { dialog.querySelector<HTMLButtonElement>("button[type=submit]")!.click(); });
    const write = auth.requests.find(request => request.init?.method === "PUT")!;
    expect(write.path).toBe("/api/me/walks/11111111-1111-4111-8111-111111111111/sharing");
    expect(JSON.parse(String(write.init?.body))).toEqual({ revision: 3, visibility: "public" });
    expect(writeText).toHaveBeenCalledWith(`${location.origin}/walk?share=22222222-2222-4222-8222-222222222222`);
    expect(container.textContent).toContain("Ссылка скопирована. Прогулка появится в топе после проверки.");
    expect(container.textContent).toContain("Доступ: Всем · на проверке");
    expect(dialog.hasAttribute("open")).toBe(false);
  });

  it("не даёт открыть всем черновик и объясняет почему", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk({ draft: true })];
    await render();
    await act(async () => { [...container.querySelectorAll("button")].find(item => item.textContent === "Доступ")!.click(); });
    const everyone = container.querySelector<HTMLInputElement>("dialog input[value=public]")!;
    expect(everyone.disabled).toBe(true);
    expect(document.getElementById(everyone.getAttribute("aria-describedby")!)?.textContent).toBe("Сначала постройте маршрут.");
  });

  it("показывает конфликт версий внутри окна", async () => {
    auth.user = { id: "anna", name: "Анна" }; auth.walks = [accountWalk()];
    auth.respond = () => { throw Object.assign(new Error("Задание уже изменилось."), { status: 409, code: "CONFLICT" }); };
    await render();
    await act(async () => { [...container.querySelectorAll("button")].find(item => item.textContent === "Доступ")!.click(); });
    await act(async () => { container.querySelector<HTMLInputElement>("dialog input[value=shared]")!.click(); });
    await act(async () => { container.querySelector<HTMLButtonElement>("dialog button[type=submit]")!.click(); });
    expect(container.querySelector("dialog [role=alert]")?.textContent).toBe("Прогулка изменилась на другом устройстве. Обновите страницу и повторите.");
  });
});
