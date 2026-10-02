import { expect, test, type Page } from "./support/test";

const id = "11111111-1111-4111-8111-111111111111";
const place = { label: "Арбат, 10", address: "Москва, Арбат, 10", location: { lat: 55.7505, lon: 37.5935 } };
const job = (stage: string, patch: object = {}) => ({
  id, address: place.address, stage, revision: 1, createdAt: "2026-10-02T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z",
  elapsedSec: 12, canRetry: false, error: null, story: null, audio: null, ...patch,
});
const ready = job("ready", {
  story: {
    title: "Дом на Арбате", address: place.address, wordCount: 300, verification: "automatic",
    paragraphs: [{ text: "Дом построили в 1902 году по проекту местного архитектора.", factIds: [] }],
    sources: [{ id: "s1", title: "Архивная справка", url: "https://example.org/arbat", publisher: "Мосгорархив" }], facts: [],
  },
});

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, walks: [], nextCursor: null, items: [], version: 1, cellSize: 1, cells: [] } }));
  await page.route("**/api/story-place?*", route => route.fulfill({ json: place }));
});

async function pickHouse(page: Page) {
  await page.goto("/");
  await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
  await page.locator('[data-region="map"]').click({ position: { x: 180, y: 260 } });
  await expect(page.locator("#new-place-title")).toHaveText(place.address);
}

test("история выбранного дома готовится прямо на карте, без отдельной страницы", async ({ page }) => {
  let current: object = job("researching");
  const created: unknown[] = [];
  await page.route("**/api/story-jobs", route => { created.push(route.request().postDataJSON()); return route.fulfill({ json: job("researching") }); });
  await page.route(`**/api/story-jobs/${id}`, route => route.fulfill({ json: current }));
  await pickHouse(page);
  await expect(page.getByRole("link", { name: /вручную/ })).toHaveCount(0);
  await page.getByRole("button", { name: "История этого дома" }).click();

  const sheet = page.locator('[data-sheet="story"]');
  await expect(sheet.getByRole("status")).toContainText("Ищем источники");
  expect(created).toEqual([expect.objectContaining({ address: place.address })]);
  await expect(page).toHaveURL(/\/$/);

  current = ready;
  await expect(sheet.locator("#selected-place-title")).toHaveText("Дом на Арбате", { timeout: 10_000 });
  await expect(sheet).toContainText("Дом построили в 1902 году");
  await sheet.getByText("Источники", { exact: true }).click();
  await expect(sheet.getByRole("link", { name: "Архивная справка" })).toBeVisible();
  await expect(page.locator("a[href^='/create']")).toHaveCount(0);
});

test("без входа «История этого дома» ведёт на вход и возвращает на карту", async ({ page }) => {
  await page.route("**/api/story-jobs", route => route.fulfill({ status: 401, json: { error: { code: "UNAUTHORIZED", message: "Войдите, чтобы подготовить историю." } } }));
  await pickHouse(page);
  await page.getByRole("button", { name: "История этого дома" }).click();
  await expect(page).toHaveURL(/\/login\?returnTo=%2F/);
});

test("ссылка /?job= открывает заказанную историю на карте другого устройства", async ({ page }) => {
  const lookups: string[] = [];
  await page.route("**/api/story-place?*", route => { lookups.push(new URL(route.request().url()).searchParams.get("q") ?? ""); return route.fulfill({ json: place }); });
  await page.route(`**/api/story-jobs/${id}`, route => route.fulfill({ json: ready }));
  await page.goto(`/?job=${id}`);
  const sheet = page.locator('[data-sheet="story"]');
  await expect(sheet.locator("#selected-place-title")).toHaveText("Дом на Арбате");
  await expect(sheet).toContainText("Дом построили в 1902 году");
  expect(lookups).toEqual([place.address]);
  await expect(page).not.toHaveURL(/job=/);
});

test("повреждённая ссылка /?job= объясняет ошибку, а не открывает пустую карточку", async ({ page }) => {
  await page.goto("/?job=not-a-job");
  await expect(page.getByText("Ссылка на историю повреждена.")).toBeVisible();
  await expect(page.locator('[data-sheet="story"]')).toHaveCount(0);
});
