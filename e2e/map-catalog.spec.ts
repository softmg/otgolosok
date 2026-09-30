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
  await expect(page.locator(".around-catalog-status")).toHaveCount(0);
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("Рассказ о месте 1438.");
  expect(errors).toEqual([]);
});

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
