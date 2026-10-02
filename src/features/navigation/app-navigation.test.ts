// @vitest-environment jsdom

import { act, createElement, Fragment } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { navigationSection } from "./app-navigation-state";

const location = vi.hoisted(() => ({ pathname: "/" }));
vi.mock("next/navigation", () => ({ usePathname: () => location.pathname }));

import { AppNavigation } from "./app-navigation";
import { useHideNavigation } from "./navigation-visibility";

function Hider({ hidden }: { hidden: boolean }) {
  useHideNavigation(hidden);
  return null;
}

let root: Root;
let container: HTMLDivElement;

async function render(pathname: string, props: Parameters<typeof AppNavigation>[0] = {}) {
  location.pathname = pathname;
  await act(async () => { root.render(createElement(AppNavigation, props)); });
  return container.querySelector("nav");
}

const current = () => container.querySelector('[aria-current="page"]')?.textContent;
const item = (name: string) => [...container.querySelectorAll<HTMLElement>("nav a, nav button")].find(element => element.textContent === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  container.remove();
  vi.unstubAllGlobals();
});

describe("нижняя навигация приложения", () => {
  it.each([
    ["/", "nearby"],
    ["/walk", "walk"],
    ["/walk/", "walk"],
    ["/create", null],
    ["/account", "account"],
    ["/history", "history"],
  ] as const)("выделяет раздел %s", (pathname, expected) => {
    expect(navigationSection(pathname)).toBe(expected);
  });

  it.each(["/login", "/admin", "/update.html"])("не выделяет служебный маршрут %s", pathname => {
    expect(navigationSection(pathname)).toBeNull();
  });

  it.each([["/history", "История"], ["/account", "Профиль"], ["/walk", "Прогулка"]])("на странице %s отмечает «%s»", async (pathname, label) => {
    expect(await render(pathname)).not.toBeNull();
    expect(current()).toBe(label);
  });

  it.each(["/", "/login", "/admin"])("общая навигация не рисуется на %s: там её нет или её рисует карта", async pathname => {
    expect(await render(pathname)).toBeNull();
  });

  it("ведёт к созданию прогулки на карте и к истории", async () => {
    await render("/history");
    expect(item("Прогулка")?.getAttribute("href")).toBe("/?walk=create");
    expect(item("История")?.getAttribute("href")).toBe("/history");
    expect(item("Рядом")?.getAttribute("href")).toBe("/");
  });

  it("на карте «Рядом» — кнопка экрана, а активный раздел задаёт экран", async () => {
    const onNearby = vi.fn();
    await render("/", { embedded: true, active: "walk", onNearby });
    expect(current()).toBe("Прогулка");
    const nearby = item("Рядом")!;
    expect(nearby.tagName).toBe("BUTTON");
    await act(async () => { nearby.click(); });
    expect(onNearby).toHaveBeenCalledOnce();
  });
});

describe("скрытие навигации экраном", () => {
  async function show(hiders: boolean[], props: Parameters<typeof AppNavigation>[0] = {}) {
    await act(async () => {
      root.render(createElement(Fragment, null, ...hiders.map((hidden, key) => createElement(Hider, { key, hidden })), createElement(AppNavigation, props)));
    });
    return container.querySelector("nav");
  }

  it("пропадает, пока экран просит, и возвращается, когда он отпускает", async () => {
    location.pathname = "/walk";
    expect(await show([false])).not.toBeNull();
    expect(await show([true])).toBeNull();
    expect(await show([false])).not.toBeNull();
  });

  it("возвращается, когда экран, скрывший её, закрыт", async () => {
    location.pathname = "/walk";
    expect(await show([true])).toBeNull();
    expect(await show([])).not.toBeNull();
  });

  it("при двух экранах возвращается, только когда отпустили оба", async () => {
    location.pathname = "/walk";
    expect(await show([true, true])).toBeNull();
    expect(await show([false, true])).toBeNull();
    expect(await show([false, false])).not.toBeNull();
  });

  it("скрывает и навигацию, которую рисует карта", async () => {
    location.pathname = "/";
    expect(await show([true], { embedded: true, active: "nearby" })).toBeNull();
    expect(await show([false], { embedded: true, active: "nearby" })).not.toBeNull();
  });
});
