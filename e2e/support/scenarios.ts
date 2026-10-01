import { expect, type Page } from "@playwright/test";
import { mockMapCatalog } from "./map-catalog";
import { draftToWalkDocument, routeToWalkView } from "../../src/features/walks/adapters";
import routeData from "../../public/data/routes/paveletskaya.json" with { type: "json" };
import type { Route } from "../../src/features/tour/types";
import type { LayoutOptions } from "./layout";
import { MOSCOW_CENTER } from "../../src/features/explore/map-jobs";

export const walkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
export const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
export const stops = [3, 5].map((n, i) => ({ address: `Москва, Арбат, ${n}`, location: { lat: 55.751 + i * .001, lon: 37.601 } }));
const user = { id: "test", name: "Анна", email: "test@example.test" };

const catalog = routeData as Route;
/** One stop with a long story and audio: the walk panel at its tallest. */
export const longStop = routeToWalkView({ ...catalog, walk: { ...catalog.walk!, steps: catalog.walk!.steps.slice(-1) } });

/** Mocks every API with an empty guest answer; specific routes registered later take precedence. */
export async function mockGuestApi(page: Page) {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, walks: [], nextCursor: null, items: [], version: 1, cellSize: 1, cells: [] } }));
}

export async function openLongStory(page: Page, { visible = true } = {}) {
  const text = "Корпус имеет сложную, отдалённо Т-образную форму, а главный фасад построен как трёхчастная композиция. ".repeat(5);
  await mockMapCatalog(page, [{ id: "long-story", title: "Длинная история", address: "Москва, Дербеневская, 1", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon, paragraphs: [text, text, text], audioUrl: "/api/story-audio/long-story.mp3", durationSec: 120 }]);
  await page.goto("/");
  // On a short landscape screen the pin can sit under the geolocation card; this helper only opens the state.
  await page.locator('[title="Длинная история"]').dispatchEvent("click");
  const story = page.getByRole("region", { name: "Текст истории", exact: true });
  // The layout matrix opens the story on screens where the text may be squeezed out: it checks that itself.
  if (visible) await expect(story).toBeVisible(); else await expect(story).toBeAttached();
  return story;
}

/** Stores a local walk Арбат → two stops and opens its session. */
export async function openLocalWalk(page: Page, empty = false) {
  const selected = empty ? [] : stops;
  const document = draftToWalkDocument({ version: 1, title: "Арбат", start, destination: stops[1], mode: "open", minutes: 30,
    stops: selected, route: { stops: selected, geometry: [start.location, ...stops.map(s => s.location)], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, walkId);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id: walkId, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.goto(`/walk?local=${walkId}`);
}

async function openLongCatalogWalk(page: Page) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 55.7232, longitude: 37.653, accuracy: 12 });
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: longStop }));
  await page.goto("/walk?catalog=paveletskaya");
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
}

async function startLongWalk(page: Page) {
  await openLongCatalogWalk(page);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Моё местоположение", exact: true })).toBeVisible();
}

async function mapReady(page: Page) {
  await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
}

export type ScreenState = { screen: string; state: string; options: LayoutOptions; open: (page: Page) => Promise<void>; chromiumOnly?: string };

const creationDraft = {
  version: 1, title: "Из Александровского сада", start: { address: "Александровский сад", location: { lat: 55.752, lon: 37.613 } }, mode: "loop", minutes: 60,
  stops: Array.from({ length: 4 }, (_, i) => ({ address: `Москва, остановка ${i + 1}`, location: { lat: 55.754 + i * 0.001, lon: 37.61 } })),
  jobs: [], submitting: null,
};

/** Every screen and state of the layout-invariants matrix. */
export const SCREEN_STATES: ScreenState[] = [
  { screen: "карта", state: "приглашение", options: { map: true }, open: async page => {
    await mockGuestApi(page); await page.goto("/");
    await expect(page.getByRole("heading", { name: "Смотрите истории рядом с вами", exact: true })).toBeVisible(); await mapReady(page);
  } },
  { screen: "карта", state: "подсказка", options: { map: true }, open: async page => {
    await mockGuestApi(page); await page.goto("/");
    await page.getByRole("button", { name: "Закрыть карточку", exact: true }).click();
    await expect(page.getByText("Какой дом вам интересен?")).toBeVisible(); await mapReady(page);
  } },
  { screen: "карта", state: "длинная история", options: { map: true, focus: "marker" }, open: async page => {
    await mockGuestApi(page); await openLongStory(page, { visible: false }); await mapReady(page);
  } },
  { screen: "карта", state: "выбранный дом", options: { map: true, focus: "marker" }, open: async page => {
    await mockGuestApi(page);
    await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, 1-й Дербеневский переулок, 5", location: { lat: 55.725, lon: 37.65 } } }));
    await page.goto("/"); await mapReady(page);
    await page.getByRole("button", { name: "Закрыть карточку", exact: true }).click();
    await page.getByRole("button", { name: "Закрыть подсказку", exact: true }).click();
    const size = page.viewportSize()!;
    await page.mouse.click(Math.round(size.width * 0.3), Math.round(size.height * 0.45));
    await expect(page.getByRole("heading", { name: "Москва, 1-й Дербеневский переулок, 5", exact: true })).toBeVisible();
  } },
  { screen: "карта", state: "рядом", options: { map: true }, open: async page => {
    await mockGuestApi(page);
    await page.context().grantPermissions(["geolocation"]);
    await page.context().setGeolocation({ latitude: 55.7249, longitude: 37.6507, accuracy: 20 });
    await page.goto("/"); await mapReady(page);
    await page.getByRole("button", { name: "Моё местоположение", exact: true }).click();
    await expect(page.getByRole("heading", { name: /^В радиусе/ })).toBeVisible({ timeout: 10_000 });
  } },
  { screen: "карта", state: "поиск", options: { map: true }, open: async page => {
    await mockGuestApi(page); await page.goto("/"); await mapReady(page);
    await page.getByRole("button", { name: "Найти адрес", exact: true }).click();
    await expect(page.getByLabel("Какой дом вас интересует?")).toBeFocused();
  } },
  { screen: "создание", state: "форма", options: { map: true }, open: async page => {
    await mockGuestApi(page); await page.goto("/?walk=create");
    await expect(page.getByRole("button", { name: "Откуда", exact: true })).toBeVisible(); await mapReady(page);
  } },
  { screen: "создание", state: "выбор на карте", options: { map: true }, open: async page => {
    await mockGuestApi(page); await page.goto("/?walk=create");
    await page.getByRole("button", { name: "Куда", exact: true }).click();
    await page.getByRole("button", { name: "Выбрать на карте", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Куда идём?", exact: true })).toBeVisible(); await mapReady(page);
  } },
  { screen: "создание", state: "маршрут", options: { map: true, focus: "route" }, open: async page => {
    await mockGuestApi(page);
    const route = { stops: creationDraft.stops, geometry: [creationDraft.start.location, ...creationDraft.stops.map(stop => stop.location), creationDraft.start.location], walkingMinutes: 30, distanceM: 2000, attribution: "OSM" };
    await page.addInitScript(value => localStorage.setItem("otgolosok:walk:v1", JSON.stringify(value)), { ...creationDraft, route });
    await page.goto("/?walk=create&resume=1");
    await expect(page.getByRole("heading", { name: "Ваш маршрут", exact: true })).toBeVisible(); await mapReady(page);
  } },
  { screen: "прогулка", state: "до старта", options: { map: true, focus: "route" }, open: async page => {
    await openLongCatalogWalk(page); await mapReady(page);
  } },
  { screen: "прогулка", state: "остановка", options: { map: true }, open: async page => {
    await startLongWalk(page); await mapReady(page);
  } },
  { screen: "прогулка", state: "текст истории", options: { map: true }, open: async page => {
    await startLongWalk(page);
    await page.getByRole("button", { name: "Читать историю", exact: true }).click(); await mapReady(page);
  } },
  { screen: "прогулка", state: "список остановок", options: { map: true }, open: async page => {
    await openLocalWalk(page);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await page.getByRole("button", { name: /^Остановки ·/ }).click(); await mapReady(page);
  } },
  { screen: "прогулка", state: "настройки", options: { map: true }, open: async page => {
    await startLongWalk(page);
    await page.getByRole("button", { name: "Настройки прогулки", exact: true }).click();
    await expect(page.getByLabel("Скорость аудио")).toBeVisible(); await mapReady(page);
  } },
  { screen: "прогулка", state: "завершена", options: { map: true }, open: async page => {
    await openLocalWalk(page, true);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible(); await mapReady(page);
  } },
  { screen: "прогулка", state: "офлайн-копия", options: { map: true }, chromiumOnly: "в WebKit Playwright прерванный запрос не приводит к офлайн-копии", open: async page => {
    let online = true;
    await page.route("**/api/**", route => {
      if (!new URL(route.request().url()).pathname.startsWith("/api/story-walks/paveletskaya")) return route.fulfill({ json: { user: null } });
      return online ? route.fulfill({ json: longStop }) : route.abort("internetdisconnected");
    });
    await page.goto("/walk?catalog=paveletskaya");
    await page.getByRole("button", { name: "Настройки прогулки" }).click();
    await page.getByRole("button", { name: "Сохранить прогулку без сети" }).first().click();
    await expect(page.getByText(/^Офлайн-копия сохранена/).first()).toBeVisible();
    online = false;
    await page.reload();
    await expect(page.getByText(/^Офлайн-копия от /)).toBeVisible();
  } },
  { screen: "история", state: "список", options: { content: true }, open: async page => {
    await page.route("**/api/**", route => route.fulfill({ json: { user, walks: [], nextCursor: null } }));
    await page.route("**/api/me/walks*", route => route.fulfill({ json: { walks: Array.from({ length: 8 }, (_, i) => ({ id: `w${i}`, title: `Прогулка ${i + 1}`, revision: 0 })), nextCursor: "next" } }));
    await page.goto("/history");
    await expect(page.getByRole("button", { name: "Показать ещё" })).toBeVisible();
  } },
  { screen: "профиль", state: "профиль", options: { content: true }, open: async page => {
    await page.route("**/api/**", route => route.fulfill({ json: { user, requests: [], favorites: [], nextCursor: null } }));
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: user.name, exact: true })).toBeVisible();
  } },
  { screen: "вход", state: "форма", options: { content: true }, open: async page => {
    await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
    await page.goto("/login");
    await expect(page.getByRole("heading", { name: "Вход", exact: true })).toBeVisible();
  } },
];
