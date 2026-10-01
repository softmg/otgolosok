// @vitest-environment jsdom

import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewTarget } from "../reviews/model";

const session = vi.hoisted(() => ({ user: null as null | { id: string; name: string } }));
vi.mock("../auth/client", () => ({
  getSession: async () => session.user,
  csrfHeaders: () => ({ "X-CSRF-Token": "csrf-token" }),
}));

const { launchesPath, reportWalkLaunch, useLaunchReport } = await import("./launches");

const TOKEN = "22222222-2222-4222-8222-222222222222";
const fetcher = vi.fn();
const sent = () => fetcher.mock.calls.map(([url, init]: [string, RequestInit]) => ({ url, method: init.method, headers: init.headers as Record<string, string>, body: init.body }));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("fetch", fetcher);
  fetcher.mockReset().mockImplementation(async () => new Response(JSON.stringify({ counted: true }), { status: 200 }));
  session.user = null;
  localStorage.clear();
});
afterEach(() => { vi.unstubAllGlobals(); });

describe("отчёт о запуске прогулки", () => {
  it.each([
    [{ kind: "catalog", id: "msk-walk" }, "/api/story-walks/msk-walk/launches"],
    [{ kind: "share", token: TOKEN }, `/api/story-walks/shared/${TOKEN}/launches`],
    [{ kind: "account", id: TOKEN }, null],
    [null, null],
  ] as Array<[ReviewTarget | null, string | null]>)("%o → %s", (target, path) => {
    expect(launchesPath(target)).toBe(path);
  });

  it("гость отправляет пустое тело с ключом устройства", async () => {
    await expect(reportWalkLaunch({ kind: "share", token: TOKEN }, new AbortController().signal)).resolves.toBe(true);
    const [request] = sent();
    expect(request.url).toBe(`/api/story-walks/shared/${TOKEN}/launches`);
    expect(request.method).toBe("POST");
    expect(request.body).toBe("{}");
    expect(request.headers["X-Review-Key"]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(request.headers["X-CSRF-Token"]).toBeUndefined();
  });

  it("пользователь отправляет CSRF, а не ключ устройства", async () => {
    session.user = { id: "anna", name: "Анна" };
    await reportWalkLaunch({ kind: "catalog", id: "msk-walk" }, new AbortController().signal);
    expect(sent()[0].headers).toEqual({ "X-CSRF-Token": "csrf-token", "Content-Type": "application/json" });
  });

  it("без хранилища для ключа ничего не отправляет", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    await expect(reportWalkLaunch({ kind: "catalog", id: "msk-walk" }, new AbortController().signal)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });

  it("свою и локальную прогулку не считает", async () => {
    await expect(reportWalkLaunch({ kind: "account", id: TOKEN }, new AbortController().signal)).resolves.toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("один отчёт на открытую прогулку", () => {
  function mount(target: ReviewTarget | null, presses: number) {
    const container = document.createElement("div");
    const root = createRoot(container);
    function Harness() {
      const report = useLaunchReport(target);
      useEffect(() => { for (let index = 0; index < presses; index += 1) report(); }, [report]);
      return null;
    }
    return { root, render: () => act(async () => { root.render(createElement(Harness)); }) };
  }

  it("повторный старт и продолжение не отправляют второй запрос, а сбой не всплывает", async () => {
    fetcher.mockImplementation(async () => new Response("{}", { status: 400 }));
    const { root, render } = mount({ kind: "catalog", id: "msk-walk" }, 3);
    await render();
    await act(async () => {});
    expect(sent().map(request => request.url)).toEqual(["/api/story-walks/msk-walk/launches"]);
    await act(async () => { root.unmount(); });
  });

  it("для своей прогулки запрос не уходит", async () => {
    const { root, render } = mount({ kind: "account", id: TOKEN }, 1);
    await render();
    await act(async () => {});
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => { root.unmount(); });
  });

  it("закрытие прогулки отменяет запрос", async () => {
    let aborted = false;
    fetcher.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => { aborted = true; reject(new DOMException("Aborted", "AbortError")); });
    }));
    const { root, render } = mount({ kind: "share", token: TOKEN }, 1);
    await render();
    await act(async () => {});
    await act(async () => { root.unmount(); });
    expect(aborted).toBe(true);
  });
});
