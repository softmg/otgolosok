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

function sessionDocument(props: { active?: boolean; completed?: boolean; ratingLabel?: string; canRate?: boolean; reviews?: ((intent: "read" | "rate") => string) | null }) {
  const markup = renderToStaticMarkup(createElement(WalkSession, {
    route, chapters, index: 0, active: props.active ?? false, completed: props.completed ?? false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
    ratingLabel: props.ratingLabel, canRate: props.canRate, reviews: props.reviews,
  }));
  return new DOMParser().parseFromString(markup, "text/html");
}
const buttonTexts = (document: Document) => [...document.querySelectorAll("button")].map(button => button.textContent);

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
  [{ reviews: (intent: "read" | "rate") => intent }, true],
  [{ reviews: null }, false],
  [{ reviews: (intent: "read" | "rate") => intent, active: true }, false],
])("кнопка «Отзывы» есть только у прогулки с отзывами до старта: %o", (props, shown) => {
  expect(buttonTexts(sessionDocument(props)).includes("Отзывы")).toBe(shown);
});

it("после завершения показывает форму отзыва над кнопкой «На карту»", () => {
  const document = sessionDocument({ completed: true, canRate: true, reviews: intent => `reviews:${intent}` });
  const block = document.querySelector(".walk-session-review");
  expect(block?.textContent).toBe("reviews:rate");
  expect(block?.compareDocumentPosition(document.querySelector(".walk-session-actions")!)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(sessionDocument({ completed: true, reviews: null }).querySelector(".walk-session-review")).toBeNull();
});

it.each([[true, true], [false, false]])("«Оценить прогулку» в настройках при canRate=%s открывает форму", async (canRate, shown) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const reviews = vi.fn((intent: "read" | "rate") => createElement("p", { "data-testid": "reviews" }, intent));
  await act(async () => root.render(createElement(WalkSession, {
    route, chapters, index: 0, active: true, completed: false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: createElement("p", null, "настройки"), audioError: "", canRate, reviews,
  })));
  const find = (text: string) => [...container.querySelectorAll("button")].find(button => button.textContent === text);
  await act(async () => container.querySelector<HTMLButtonElement>("[aria-label='Настройки прогулки']")!.click());
  expect(Boolean(find("Оценить прогулку"))).toBe(shown);
  if (shown) {
    await act(async () => find("Оценить прогулку")!.click());
    expect(container.querySelector("[data-testid=reviews]")?.textContent).toBe("rate");
  }
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
