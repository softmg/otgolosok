import { expect, test } from "@playwright/test";

const places = Array.from({ length: 1438 }, (_, index) => ({
  id: `osm:node:${index + 1}`, name: `Каталог: ${index + 1}`, address: "Москва",
  location: index === 1437 ? { lat: 55.7249, lon: 37.6507 } : { lat: 55.76, lon: 37.6 + index * 0.00001 },
  story: { title: `Каталог: ${index + 1}`, paragraphs: [{ text: `Рассказ о месте ${index + 1}.` }] },
  audio: null,
}));

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("otgolosok:explore:geo-prompt-dismissed", "1"));
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
});

test("карта показывает все 1438 мест и открывает карточку с последней страницы", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/content/places?*", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return route.fulfill({ json: { places: places.slice(offset, offset + 100), total: places.length, hasMore: offset + 100 < places.length } });
  });
  await page.goto("/");
  await expect(page.locator('.leaflet-marker-icon[title^="Каталог:"]')).toHaveCount(1438);
  await expect(page.locator(".leaflet-marker-icon")).toHaveCount(1438);
  await expect(page.locator(".around-catalog-status")).toHaveCount(0);
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("Рассказ о месте 1438.");
  expect(errors).toEqual([]);
});

test("пустой каталог не добавляет пять встроенных точек", async ({ page }) => {
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [], total: 0, hasMore: false } }));
  await page.goto("/");
  await expect(page.locator(".around-catalog-status")).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^Карта историй/ })).toBeVisible();
  await expect(page.locator(".leaflet-marker-icon")).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`статус виден до первого ответа и до конца загрузки ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    let firstPage!: () => void;
    let lastPage!: () => void;
    const first = new Promise<void>(resolve => { firstPage = resolve; });
    const last = new Promise<void>(resolve => { lastPage = resolve; });
    await page.route("**/api/content/places?*", async route => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
      await (offset === 0 ? first : last);
      await route.fulfill({ json: { places: places.slice(offset, Math.min(offset + 100, 101)), total: 101, hasMore: offset === 0 } });
    });
    try {
      await page.goto("/");
      const status = page.locator('.around-catalog-status [role="status"]');
      await expect(status).toHaveText("Загружаем места…");
      await expect(status).toBeInViewport();
      await expect(page.getByRole("progressbar", { name: "Загрузка мест на карте" })).not.toHaveAttribute("value");
      firstPage();
      await expect(status).toHaveText("Загружаем места: 100 из 101…");
      await expect(page.getByRole("progressbar")).toHaveAttribute("value", "100");
      await page.screenshot({ path: info.outputPath("catalog-loading.png") });
      lastPage();
      await expect(page.locator(".around-catalog-status")).toHaveCount(0);
      await expect(page.locator(".leaflet-marker-icon")).toHaveCount(101);
    } finally { firstPage(); lastPage(); }
  });
}

test("после сбоя второй страницы точки остаются, повтор загружает весь каталог", async ({ page }) => {
  let unavailable = true;
  const sample = places.slice(0, 101);
  await page.route("**/api/content/places?*", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    if (offset === 100 && unavailable) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { places: sample.slice(offset, offset + 100), total: sample.length, hasMore: offset + 100 < sample.length } });
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Не все места загрузились." })).toBeVisible();
  await expect(page.locator('.leaflet-marker-icon[title^="Каталог:"]')).toHaveCount(100);
  unavailable = false;
  await page.getByRole("button", { name: "Повторить загрузку мест" }).click();
  await expect(page.locator('.leaflet-marker-icon[title^="Каталог:"]')).toHaveCount(101);
  await expect(page.locator(".around-catalog-status")).toHaveCount(0);
});
