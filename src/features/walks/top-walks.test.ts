// @vitest-environment jsdom

import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTopWalkMeta, storyCountLabel, validateTopWalks } from "./top-model";
import { TopWalks } from "./top-walks";

const TOKEN = "22222222-2222-4222-8222-222222222222";
const catalog = { kind: "catalog", id: "msk-walk", title: "Кожевники", walkingMinutes: 45, distanceM: 3200, stopCount: 6, rating: { average: 4.6, count: 12 } };
const shared = { kind: "shared", id: TOKEN, title: "Арбат", walkingMinutes: 30, distanceM: 1250, stopCount: 1, rating: { average: null, count: 0 } };

describe("модель топа", () => {
  it("принимает корректный ответ", () => {
    expect(validateTopWalks({ walks: [catalog, shared] })).toEqual([catalog, shared]);
  });

  it.each([
    ["не объект", null],
    ["нет списка", { walks: {} }],
    ["неизвестный вид", { walks: [{ ...catalog, kind: "account" }] }],
    ["некорректный слаг", { walks: [{ ...catalog, id: "Bad Slug" }] }],
    ["слаг вместо токена", { walks: [{ ...shared, id: "msk-walk" }] }],
    ["пустое название", { walks: [{ ...catalog, title: " " }] }],
    ["нулевая длина", { walks: [{ ...catalog, distanceM: 0 }] }],
    ["дробное число историй", { walks: [{ ...catalog, stopCount: 1.5 }] }],
    ["средняя без оценок", { walks: [{ ...shared, rating: { average: 4, count: 0 } }] }],
    ["оценка вне шкалы", { walks: [{ ...catalog, rating: { average: 6, count: 1 } }] }],
  ])("отклоняет: %s", (_name, value) => {
    expect(() => validateTopWalks(value)).toThrow(TypeError);
  });

  it.each([[1, "1 история"], [2, "2 истории"], [5, "5 историй"], [11, "11 историй"], [21, "21 история"], [22, "22 истории"]])("%i → %s", (count, label) => {
    expect(storyCountLabel(count)).toBe(label);
  });

  it("собирает строку времени, длины и историй", () => {
    expect(formatTopWalkMeta(catalog)).toBe("45 мин · 3,2 км · 6 историй");
  });
});

describe("список топа", () => {
  let root: Root;
  let container: HTMLDivElement;
  const fetcher = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetcher);
    fetcher.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
    vi.unstubAllGlobals();
  });
  const render = async () => { await act(async () => { root.render(createElement(TopWalks)); }); await act(async () => {}); };
  const ok = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

  it("показывает место, ссылку, рейтинг и описание маршрута", async () => {
    fetcher.mockResolvedValue(ok({ walks: [catalog, shared] }));
    await render();
    expect(fetcher).toHaveBeenCalledWith("/api/top-walks", expect.objectContaining({ credentials: "same-origin" }));
    const items = [...container.querySelectorAll("ol > li")];
    expect(items.map(item => item.querySelector("span")?.textContent)).toEqual(["1", "2"]);
    expect(items.map(item => item.querySelector("a")?.getAttribute("href"))).toEqual(["/walk?catalog=msk-walk", `/walk?share=${TOKEN}`]);
    expect(items[0].textContent).toContain("★ 4,6 · 12 оценок");
    expect(items[1].textContent).toContain("Пока без оценок");
    expect(items[1].textContent).toContain("30 мин · 1,3 км · 1 история");
  });

  it("пустой топ зовёт открыть свою прогулку", async () => {
    fetcher.mockResolvedValue(ok({ walks: [] }));
    await render();
    expect(container.textContent).toBe("В топе пока пусто. Откройте свою прогулку всем — после проверки она появится здесь.");
  });

  it("повреждённый ответ — ошибка с повтором, который загружает топ заново", async () => {
    fetcher.mockResolvedValueOnce(ok({ walks: [{ kind: "catalog" }] })).mockResolvedValueOnce(ok({ walks: [catalog] }));
    await render();
    const alert = container.querySelector("[role=alert]");
    expect(alert?.textContent).toContain("Сервис вернул повреждённую прогулку.");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await act(async () => { alert!.querySelector("button")!.click(); });
    await act(async () => {});
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
  });
});
