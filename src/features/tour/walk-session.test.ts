// @vitest-environment jsdom
import { act, createElement, createRef } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import routeData from "../../../public/data/routes/paveletskaya.json";
import { WalkSession } from "./walk-session";
import { WalkMap } from "./walk-map";
import { getWalkChapters } from "./walk-plan";
import type { Route } from "./types";

const mapInput = vi.hoisted(() => ({ items: [] as Array<{ id: string; location: { lat: number; lon: number } }> }));
vi.mock("../explore/explore-map", () => ({ ExploreMap: (props: typeof mapInput) => { mapInput.items = props.items; return null; } }));

const route = routeData as Route;
const title = "По бульварному кольцу от Кропоткинской до Тверской";
const chapters = getWalkChapters(route);

it.each([
  [title, false, false, title],
  ["", false, false, "Ваш маршрут"],
  ["   ", false, false, "Ваш маршрут"],
  [title, true, false, chapters[0].title],
  [title, false, true, "Прогулка завершена"],
])("отображает заголовок прогулки %s в состоянии active=%s completed=%s", (savedTitle, active, completed, expected) => {
  const markup = renderToStaticMarkup(createElement(WalkSession, {
    route: { ...route, title: savedTitle }, chapters, index: 0, active, completed,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
  }));
  const document = new DOMParser().parseFromString(markup, "text/html");
  expect(document.querySelector("h1")?.textContent).toBe(expected);
});

it.each(["session", "map"])("%s ставит маркеры в точки прослушивания, сохраняя координаты объектов", component => {
  const listeningPoint = { lat: 55.751, lon: 37.602 };
  const selected = [
    { ...chapters[0], trigger_location: listeningPoint },
    { ...chapters[1], trigger_location: undefined },
  ];
  const originalLocations = selected.map(chapter => ({ ...chapter.location }));
  expect(listeningPoint).not.toEqual(originalLocations[0]);
  if (component === "session") {
    renderToStaticMarkup(createElement(WalkSession, {
      route, chapters: selected, index: 0, active: false, completed: false,
      user: null, positionFailed: false, resume: false,
      titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
      onStart: () => {}, onSelect: () => {}, onStop: () => {},
      player: null, story: null, settings: null, audioError: "",
    }));
  } else {
    renderToStaticMarkup(createElement(WalkMap, { chapters: selected, index: 0, path: route.walk?.path, user: null, distanceToNextM: null, onSelect: () => {} }));
  }
  expect(mapInput.items.find(item => item.id === selected[0].id)?.location).toEqual(listeningPoint);
  expect(mapInput.items.find(item => item.id === selected[1].id)?.location).toEqual(originalLocations[1]);
  expect(selected.map(chapter => chapter.location)).toEqual(originalLocations);
});

function sessionDocument(props: { active?: boolean; completed?: boolean; ratingLabel?: string; hasReview?: boolean; ratingCount?: number | null; reviews?: string | null }) {
  const markup = renderToStaticMarkup(createElement(WalkSession, {
    route, chapters, index: 0, active: props.active ?? false, completed: props.completed ?? false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
    ratingLabel: props.ratingLabel, hasReview: props.hasReview, ratingCount: props.ratingCount, reviews: props.reviews,
  }));
  return new DOMParser().parseFromString(markup, "text/html");
}
const buttonTexts = (document: Document) => [...document.querySelectorAll("button")].map(button => button.textContent);

async function mountSession(props: { active?: boolean; completed?: boolean; ratingLabel?: string; ratingCount?: number | null; reviewable?: boolean }) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRate = vi.fn();
  await act(async () => root.render(createElement(WalkSession, {
    route, chapters, index: 0, active: props.active ?? false, completed: props.completed ?? false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: createElement("p", null, "настройки"), audioError: "",
    ratingLabel: props.ratingLabel, ratingCount: props.ratingCount,
    reviews: props.reviewable === false ? null : createElement("p", { "data-testid": "reviews" }, "список"), onRate,
  })));
  const find = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text);
  const click = (element: HTMLElement) => act(async () => element.click());
  const unmount = async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); };
  return { container, find, click, onRate, unmount };
}

it.each([
  [{ ratingLabel: "★ 4,6 · 12 оценок" }, true],
  [{ ratingLabel: "" }, false],
  [{ ratingLabel: "★ 4,6 · 12 оценок", active: true }, false],
  [{ ratingLabel: "★ 4,6 · 12 оценок", completed: true }, false],
])("показывает итог оценок в строке описания только до старта: %o", (props, shown) => {
  const meta = sessionDocument(props).querySelector(".walk-session-meta")?.textContent ?? "";
  expect(meta.includes("★ 4,6 · 12 оценок")).toBe(shown);
  if (shown) expect(meta).toMatch(/мин · .* км · ★ 4,6 · 12 оценок$/);
});

it.each([
  [{ reviews: "список" }, true],
  [{ reviews: null }, false],
  [{ reviews: "список", active: true }, false],
])("кнопка «Отзывы» есть только у прогулки с отзывами до старта: %o", (props, shown) => {
  expect(buttonTexts(sessionDocument(props)).includes("Отзывы")).toBe(shown);
});

it.each([
  [{ ratingCount: 0 }, "Оставить отзыв"],
  [{ ratingCount: 0, hasReview: true }, "Изменить отзыв"],
  [{ ratingCount: 3 }, "Отзывы"],
  [{ ratingCount: null }, "Отзывы"],
])("кнопка отзывов до старта без оценок зовёт оставить отзыв: %o", (props, label) => {
  const tools = sessionDocument({ reviews: "список", ...props }).querySelector(".walk-session-tools")!;
  expect([...tools.querySelectorAll("button")].at(-1)?.textContent).toBe(label);
});

it.each([
  [{}, "Оставить отзыв"],
  [{ hasReview: true }, "Изменить отзыв"],
])("после завершения главная кнопка — отзыв, «На карту» второстепенная: %o", (props, label) => {
  const document = sessionDocument({ completed: true, reviews: "список", ...props });
  const actions = document.querySelector(".walk-session-actions")!;
  expect(actions.querySelector(".walk-session-primary")?.textContent).toBe(label);
  expect(actions.querySelector(".walk-session-secondary")?.textContent).toBe("На карту");
});

it("после завершения прогулки без отзывов главная кнопка — «На карту»", () => {
  const document = sessionDocument({ completed: true, reviews: null });
  expect(document.querySelector(".walk-session-primary")?.textContent).toBe("На карту");
  expect(document.querySelector(".walk-session-secondary")).toBeNull();
  expect(buttonTexts(document)).not.toContain("Оставить отзыв");
});

it("форма отзыва не встраивается в панель: все кнопки оценки открывают отдельное окно", async () => {
  const finished = await mountSession({ completed: true });
  await finished.click(finished.find("Оставить отзыв")!);
  expect(finished.onRate).toHaveBeenCalledTimes(1);
  expect(finished.container.querySelector("form, textarea")).toBeNull();
  await finished.unmount();

  const empty = await mountSession({ ratingCount: 0 });
  await empty.click(empty.find("Оставить отзыв")!);
  expect(empty.onRate).toHaveBeenCalledTimes(1);
  expect(empty.container.querySelector(".walk-session-drawer")).toBeNull();
  await empty.unmount();
});

it.each([[true, true], [false, false]])("«Оценить прогулку» в настройках у прогулки с отзывами=%s открывает окно и закрывает настройки", async (reviewable, shown) => {
  const session = await mountSession({ active: true, reviewable });
  await session.click(session.container.querySelector<HTMLButtonElement>("[aria-label='Настройки прогулки']")!);
  expect(Boolean(session.find("Оценить прогулку"))).toBe(shown);
  if (shown) {
    await session.click(session.find("Оценить прогулку")!);
    expect(session.onRate).toHaveBeenCalledTimes(1);
    expect(session.container.querySelector(".walk-session-drawer")).toBeNull();
  }
  await session.unmount();
});

it("итог оценок в описании — кнопка, открывающая и закрывающая список отзывов", async () => {
  const session = await mountSession({ ratingLabel: "★ 4,3 · 4 оценки", ratingCount: 4 });
  const rating = session.container.querySelector<HTMLButtonElement>(".walk-session-meta button")!;
  expect(rating.textContent).toBe("★ 4,3 · 4 оценки");
  await session.click(rating);
  expect(session.container.querySelector("[data-testid=reviews]")?.textContent).toBe("список");
  expect(rating.getAttribute("aria-expanded")).toBe("true");
  await session.click(rating);
  expect(session.container.querySelector("[data-testid=reviews]")).toBeNull();
  expect(session.onRate).not.toHaveBeenCalled();
  await session.unmount();
});
