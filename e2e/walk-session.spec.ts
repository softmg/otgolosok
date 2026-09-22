import { expect, test } from "@playwright/test";
import { draftToWalkDocument, routeToWalkView } from "../src/features/walks/adapters";
import routeData from "../public/data/routes/paveletskaya.json" with { type: "json" };
import type { Route } from "../src/features/tour/types";

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stops = [3, 5].map((n, i) => ({ address: `Москва, Арбат, ${n}`, location: { lat: 55.751 + i * .001, lon: 37.601 } }));

async function setup(page: import("@playwright/test").Page, empty = false) {
  const selected = empty ? [] : stops;
  const document = draftToWalkDocument({ version: 1, title: "Арбат", start, destination: stops[1], mode: "open", minutes: 30,
    stops: selected, route: { stops: selected, geometry: [start.location, ...stops.map(s => s.location)], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.goto(`/walk?local=${id}`);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 568, height: 400 }]) {
  test(`карта остаётся при старте и смене остановки ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await setup(page);
    const map = page.locator(".walk-session-map");
    await expect(map.locator(".leaflet-overlay-pane path")).toBeVisible();
    await expect(page.locator(".hero, .debug-panel, .walk-plan")).toHaveCount(0);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    await expect(map).toBeVisible();
    await expect(page.getByText("История ещё готовится", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Предыдущая остановка" }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    const boxes = await page.locator(".walk-session-panel").evaluate(el => {
      const panel = el.getBoundingClientRect();
      const nav = document.querySelector(".app-navigation")!.getBoundingClientRect();
      return { top: panel.top, bottom: panel.bottom, navTop: nav.top, right: panel.right, width: innerWidth };
    });
    expect(boxes.top).toBeGreaterThanOrEqual(0);
    expect(boxes.bottom).toBeLessThanOrEqual(boxes.navTop);
    expect(boxes.right).toBeLessThanOrEqual(boxes.width);
    await page.screenshot({ path: info.outputPath("walk-session.png") });
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
    await expect(map).toBeVisible();
  });
}

test("маршрут без историй можно пройти и завершить на карте", async ({ page }) => {
  await setup(page, true);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toHaveCount(0);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
});

test("аудио, текст и список остановок открываются внутри панели", async ({ page }, info) => {
  const view = routeToWalkView(routeData as Route);
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: view }));
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
  await page.getByRole("button", { name: "Читать историю" }).click();
  await expect(page.locator(".walk-session-drawer .story-text")).toBeVisible();
  await page.getByRole("button", { name: "Читать историю" }).click();
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByLabel("Переключение остановок").selectOption("manual");
  await page.getByLabel("Скорость аудио").selectOption("1.25");
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByRole("button", { name: /Остановки ·/ }).click();
  await page.locator(".walk-session-stops button").nth(1).click();
  await expect(page.getByRole("heading", { name: "Название с оврагом внутри", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).playbackRate)).toBe(1.25);
  await page.screenshot({ path: info.outputPath("audio-session.png") });
  await page.getByRole("link", { name: "Закрыть прогулку" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".walk-session")).toHaveCount(0);
});

test("отказ аудио не блокирует переход к следующей остановке", async ({ page }) => {
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.route("**/audio/**", route => route.abort());
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить запуск звука", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Название с оврагом внутри", exact: true })).toBeVisible();
});

test("геопозиция отличается от остановок и не дублирует маркер при обновлении", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 55.7505, longitude: 37.6005, accuracy: 12 });
  await setup(page);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  const position = page.locator(".explore-user-position");
  await expect(position).toBeVisible();
  await expect(position.locator("span")).toHaveCSS("background-color", "rgb(36, 107, 144)");
  await expect(page.locator(".leaflet-control-scale")).toHaveCount(0);
  await context.setGeolocation({ latitude: 55.7508, longitude: 37.6008, accuracy: 18 });
  await expect(position).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Моё местоположение", exact: true })).toBeVisible();
});
