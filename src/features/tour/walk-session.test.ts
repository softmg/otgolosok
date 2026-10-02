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
import type { OwnWalk } from "../walks/own-walk";

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

function sessionDocument(props: { active?: boolean; completed?: boolean; ratingLabel?: string; hasReview?: boolean; ratingCount?: number | null; reviews?: string | null; own?: OwnWalk | null }) {
  const markup = renderToStaticMarkup(createElement(WalkSession, {
    route, chapters, index: 0, active: props.active ?? false, completed: props.completed ?? false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
    ratingLabel: props.ratingLabel, hasReview: props.hasReview, ratingCount: props.ratingCount, reviews: props.reviews, own: props.own,
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

const own: OwnWalk = { editHref: "/?walk=create&local=walk-1&edit=1", notes: ["У 2 остановок пока нет истории."] };
// Own walks lead back to the builder only before the start; other walks never do.
it.each([
  ["своя до старта", own, false, false, true],
  ["своя во время прогулки", own, true, false, false],
  ["своя после завершения", own, false, true, false],
  ["чужая до старта", null, false, false, false],
])("%s: «Изменить маршрут» и подсказки показаны — %s", (_, ownWalk, active, completed, shown) => {
  const document = sessionDocument({ own: ownWalk, active, completed });
  const edit = [...document.querySelectorAll("a")].find(link => link.textContent === "Изменить маршрут");
  expect(edit?.getAttribute("href") ?? null).toBe(shown ? own.editHref : null);
  expect(document.body.textContent?.includes(own.notes[0])).toBe(shown);
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

it.each([
  { stage: "approach" as const, advance: "place" as const, audio: true, meta: "К остановке 2 из 4 · начнётся, когда подойдёте" },
  { stage: "approach" as const, advance: "manual" as const, audio: true, meta: "К остановке 2 из 4" },
  { stage: "approach" as const, advance: "sequence" as const, audio: true, meta: "К остановке 2 из 4" },
  { stage: "approach" as const, advance: "place" as const, audio: false, meta: "К остановке 2 из 4" },
  { stage: "stop" as const, advance: "place" as const, audio: true, meta: "Остановка 2 из 4" },
  { stage: "stop" as const, advance: "manual" as const, audio: true, meta: "Остановка 2 из 4" },
])("на пути к остановке и у неё: $stage, $advance, аудио $audio", ({ stage, advance, audio, meta }) => {
  const stops = chapters.map(chapter => ({ ...chapter, audio: audio ? chapter.audio : undefined }));
  expect(stops[1].audio === undefined).toBe(!audio);
  const markup = renderToStaticMarkup(createElement(WalkSession, {
    route, chapters: stops, index: 1, stage, advance, active: true, completed: false,
    user: null, positionFailed: false, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
  }));
  const document = new DOMParser().parseFromString(markup, "text/html");
  expect(document.querySelector(".walk-session-meta")?.textContent).toBe(meta);
});

async function mountPosition(denied: boolean) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const onRetryPosition = vi.fn();
  const render = (positionFailed: boolean, user: { lat: number; lon: number; accuracyM: number } | null) => act(async () => root.render(createElement(WalkSession, {
    route, chapters, index: 0, active: true, completed: false,
    user, positionFailed, positionDenied: denied && positionFailed, onRetryPosition, resume: false,
    titleRef: createRef<HTMLHeadingElement>(), startRef: createRef<HTMLButtonElement>(),
    onStart: () => {}, onSelect: () => {}, onStop: () => {},
    player: null, story: null, settings: null, audioError: "",
  })));
  await render(true, null);
  const button = () => [...container.querySelectorAll<HTMLButtonElement>(".walk-session-tools button")].find(item => item.textContent === "Геопозиции нет");
  const drawer = () => container.querySelector(".walk-session-drawer");
  const unmount = async () => { await act(async () => root.unmount()); container.remove(); vi.unstubAllGlobals(); };
  return { container, render, button, drawer, onRetryPosition, unmount };
}

it.each([
  [true, "Сайту запрещён доступ к геопозиции", true],
  [false, "Не удалось определить положение", false],
])("«Геопозиции нет» стоит рядом с «Остановками» и по нажатию снова запрашивает доступ (запрещён=%s)", async (denied, message, helpOpen) => {
  const session = await mountPosition(denied);
  const tools = [...session.container.querySelectorAll(".walk-session-tools button")].map(item => item.textContent);
  expect(tools.slice(0, 2)).toEqual([`Остановки · ${chapters.length}`, "Геопозиции нет"]);
  expect(session.container.textContent).not.toContain("Геопозиция недоступна");

  await act(async () => session.button()!.click());
  expect(session.onRetryPosition).toHaveBeenCalledTimes(1);
  expect(session.button()?.getAttribute("aria-expanded")).toBe("true");
  expect(session.drawer()?.textContent).toContain(message);
  expect(session.drawer()?.querySelector("details")?.open).toBe(helpOpen);

  // «Проверить снова» внутри подсказки тоже запрашивает положение заново.
  await act(async () => [...session.drawer()!.querySelectorAll("button")].find(item => item.textContent === "Проверить снова")!.click());
  expect(session.onRetryPosition).toHaveBeenCalledTimes(2);

  // Пока браузер ищет положение, панель остаётся открытой и говорит об этом.
  await session.render(false, null);
  expect(session.drawer()?.textContent).toBe("Определяем положение…");
  // Пришли координаты — подсказка и кнопка исчезают сами.
  await session.render(false, { lat: 55.75, lon: 37.6, accuracyM: 10 });
  expect(session.drawer()).toBeNull();
  expect(session.button()).toBeUndefined();
  await session.unmount();
});
