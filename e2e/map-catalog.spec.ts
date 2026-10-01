import { expect, test, type Page } from "./support/test";
import { MOSCOW_CENTER } from "../src/features/explore/map-jobs";
import { mockMapCatalog, type CatalogFixture } from "./support/map-catalog";

const places: CatalogFixture[] = Array.from({ length: 1438 }, (_, index) => ({
  id: `osm:node:${index + 1}`, title: `Каталог: ${index + 1}`, address: "Москва",
  ...(index === 1437 ? { ...MOSCOW_CENTER } : { lat: MOSCOW_CENTER.lat + 0.0044, lon: MOSCOW_CENTER.lon - 0.0068 + (index % 50) * 0.000005 }),
  paragraphs: [`Рассказ о месте ${index + 1}.`],
}));
const MANIFEST = "/api/content/map-cells";
const MOSCOW_CELL = "/api/content/map-cells/55/37";

async function representedPlaces(page: Page) {
  return page.locator(".leaflet-marker-pane").evaluate(pane =>
    [...pane.querySelectorAll<HTMLElement>("[data-cluster-count]")].reduce((total, node) => total + Number(node.dataset.clusterCount), 0)
    + pane.querySelectorAll('[data-marker="pin"][title^="Каталог:"]').length);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("otgolosok:explore:geo-prompt-dismissed", "1"));
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
});

test("карта показывает все 1438 мест одной ячейки двумя запросами и загружает текст по клику", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const requests = await mockMapCatalog(page, places);
  await page.goto("/");
  await expect.poll(() => representedPlaces(page)).toBe(1438);
  expect(await page.locator(".leaflet-marker-icon").count()).toBeLessThan(30);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  expect(requests).toEqual([MANIFEST, MOSCOW_CELL]);
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("Рассказ о месте 1438.");
  expect(requests).toEqual([MANIFEST, MOSCOW_CELL, "/api/content/places/osm:node:1438"]);
  expect(errors).toEqual([]);
});

test("пустой каталог не добавляет пять встроенных точек и не запрашивает ячейки", async ({ page }) => {
  const requests = await mockMapCatalog(page, []);
  await page.goto("/");
  await expect(page.getByRole("region", { name: /^Карта историй/ })).toBeVisible();
  await expect.poll(() => requests).toEqual([MANIFEST]);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  await expect(page.locator(".leaflet-marker-icon")).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) for (const path of ["/", "/?walk=create"]) {
  test(`статус виден до ответа ячейки ${viewport.width}×${viewport.height} ${path}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await mockMapCatalog(page, places.slice(0, 101), { intercept: async requested => { if (requested === MOSCOW_CELL) await held; } });
    try {
      await page.goto(path);
      const status = page.locator('[data-region="catalog-status"] [role="status"]');
      await expect(status).toHaveText("Загружаем места…");
      await expect(status).toBeInViewport();
      await expect(page.getByRole("progressbar", { name: "Загрузка мест на карте" })).not.toHaveAttribute("value");
      await page.screenshot({ path: info.outputPath("catalog-loading.png") });
      release();
      await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
      await expect.poll(() => representedPlaces(page)).toBe(101);
    } finally { release(); }
  });
}

test("после сбоя ячейки повтор загружает её точки", async ({ page }) => {
  let unavailable = true;
  await mockMapCatalog(page, places.slice(0, 101), {
    intercept: (requested, route) => requested === MOSCOW_CELL && unavailable ? route.fulfill({ status: 503, json: {} }).then(() => true) : false,
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Не все места загрузились." })).toBeVisible();
  unavailable = false;
  await page.getByRole("button", { name: "Повторить загрузку мест" }).click();
  await expect.poll(() => representedPlaces(page)).toBe(101);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
});

for (const coincident of [false, true]) {
  test(coincident ? "совпадающие места раскрываются веером и доступны по отдельности" : "группа раскрывается с клавиатуры и снова объединяется при отдалении", async ({ page }, info) => {
    const sample = places.slice(0, 2).map((place, index) => ({ ...place, lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon + (coincident ? 0 : index * 0.0004 - 0.0002) }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await mockMapCatalog(page, sample);
    await page.goto("/");
    const group = page.getByRole("button", { name: "Мест: 2. Нажмите, чтобы раскрыть группу" });
    await expect(group).toBeVisible();
    await expect(page.locator('[data-marker="pin"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("cluster.png") });
    await group.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-marker="pin"][title^="Каталог:"]')).toHaveCount(2);
    await expect(page.locator('[data-sheet="story"], [data-sheet="place"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("expanded.png") });
    if (!coincident) {
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Отдалить", exact: true }).click();
      await expect(group).toBeVisible();
      await expect.poll(() => representedPlaces(page)).toBe(2);
      await group.click();
      await expect(page.locator('[data-marker="pin"][title^="Каталог:"]')).toHaveCount(2);
    }
    await page.getByTitle("Каталог: 2", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Каталог: 2", exact: true })).toBeVisible();
    await expect(page.getByTitle("Каталог: 2", { exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`отдаление до всего города не повторяет запросы внутри ячейки ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const requests = await mockMapCatalog(page, [places[1437], { ...places[1], lat: 55.9, lon: 37.3 }]);
    await page.goto("/");
    await expect(page.getByTitle("Каталог: 1438", { exact: true })).toBeVisible();
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "Отдалить", exact: true }).click();
    // Viewport reports are debounced (160 ms): give the last one time to arrive before checking that nothing was requested.
    await page.waitForTimeout(1_000);
    await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
    expect(requests).toEqual([MANIFEST, MOSCOW_CELL]);
  });
}

test("перемещение карты сохраняет выбранную карточку без новых запросов", async ({ page }) => {
  const requests = await mockMapCatalog(page, [places[1437]]);
  await page.goto("/");
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  const box = (await page.locator(".leaflet-container").boundingBox())!;
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(box.x + box.width * 0.85, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15, box.y + 180, { steps: 15 });
    await page.mouse.up();
  }
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  expect(requests.filter(path => path.startsWith("/api/content/map-cells"))).toEqual([MANIFEST, MOSCOW_CELL]);
});

test("после перезагрузки без сети к индексу точки показываются из Cache Storage", async ({ page }) => {
  let offline = false;
  await mockMapCatalog(page, places.slice(0, 101), {
    intercept: (requested, route) => offline && requested.startsWith("/api/content/map-cells") ? route.abort("internetdisconnected").then(() => true) : false,
  });
  await page.goto("/");
  await expect.poll(() => representedPlaces(page)).toBe(101);
  await expect.poll(() => page.evaluate(async () => (await (await caches.open("map-cells-v1")).keys()).length)).toBe(2);
  offline = true;
  await page.reload();
  await expect.poll(() => representedPlaces(page)).toBe(101);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
});
