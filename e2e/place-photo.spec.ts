import { expect, test, type Page } from "./support/test";
import { mockMapCatalog } from "./support/map-catalog";
import photos from "../content/place-images.json" with { type: "json" };
import { MOSCOW_CENTER } from "../src/features/explore/map-jobs";

const photo = photos["osm:way:35814561"];
const title = "Кинотеатр «Художественный»";

async function openPlace(page: Page, id = "osm:way:35814561") {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, items: [], walks: [] } }));
  await mockMapCatalog(page, [{ id, title, address: "Москва, Арбатская площадь, 14", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon,
    paragraphs: ["История кинотеатра. ".repeat(120)], audioUrl: "/api/story-audio/example.mp3", durationSec: 68 }]);
  await page.goto("/");
  await page.getByTitle(title, { exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

test("превью открывает фото с автором, удерживает фокус и возвращает его после Escape", async ({ page }) => {
  const fullRequests: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === photo.src) fullRequests.push(request.url()); });
  await openPlace(page);
  const trigger = page.getByRole("button", { name: `Открыть фото: ${title}` });
  await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", 250);
  expect(fullRequests).toHaveLength(0);
  const audio = await page.locator('[data-sheet="story"] audio').elementHandle();
  await trigger.click();
  const viewer = page.getByRole("dialog", { name: title, exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
  await expect(viewer).toContainText(photo.author);
  await expect(viewer.getByRole("link", { name: photo.license, exact: true })).toHaveAttribute("href", photo.licenseUrl);
  await expect(page.getByRole("button", { name: "Закрыть фото" })).toBeFocused();
  for (let index = 0; index < 2; index++) {
    await page.keyboard.press("Tab");
    expect(await viewer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  }
  // Native modal focus may enter browser chrome, but the background card remains inert.
  await trigger.evaluate(button => button.focus());
  expect(await viewer.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  expect(await audio?.evaluate(element => element.isConnected)).toBe(true);
});

test("карточка без фотографии не резервирует место под картинку", async ({ page }) => {
  await openPlace(page, "osm:node:999999999");
  await expect(page.getByRole("button", { name: /^Открыть фото:/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("История кинотеатра.");
});

test("ошибка превью возвращает полную ширину заголовка и сохраняет рассказ", async ({ page }) => {
  await page.route(`**${photo.thumbnail}`, route => route.fulfill({ status: 404, body: "" }));
  await openPlace(page);
  await expect(page.getByRole("button", { name: /^Открыть фото:/ })).toHaveCount(0);
  await expect(page.locator('[data-photo-heading]')).toHaveCount(0);
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
});

test("после сбоя крупное фото можно загрузить повторно", async ({ page }) => {
  let unavailable = true;
  await page.route(`**${photo.src}`, route => unavailable ? route.fulfill({ status: 503, body: "" }) : route.continue());
  await openPlace(page);
  await page.getByRole("button", { name: `Открыть фото: ${title}` }).click();
  const viewer = page.getByRole("dialog", { name: title, exact: true });
  await expect(viewer.getByRole("status")).toContainText("Фотография не загрузилась");
  unavailable = false;
  await viewer.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
  await expect(viewer.getByRole("status")).toHaveCount(0);
  await viewer.getByRole("button", { name: "Закрыть фото" }).click();
  await expect(viewer).not.toBeVisible();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
  test(`фото и заголовок помещаются в экран ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openPlace(page);
    const trigger = page.getByRole("button", { name: `Открыть фото: ${title}` });
    await expect(trigger).toBeVisible();
    expect(await trigger.evaluate(button => {
      const photoBounds = button.getBoundingClientRect();
      const scrollBounds = button.closest('[data-sheet-part="body"]')!.getBoundingClientRect();
      return photoBounds.top >= scrollBounds.top && photoBounds.bottom <= scrollBounds.bottom && photoBounds.height >= 44;
    })).toBe(true);
    expect(await page.locator("#selected-place-title").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("preview.png") });
    await trigger.click();
    const viewer = page.getByRole("dialog", { name: title, exact: true });
    await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
    await expect(viewer.getByRole("button", { name: "Закрыть фото" })).toBeInViewport();
    expect(await viewer.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath("photo.png") });
    await page.mouse.click(2, 2);
    await expect(viewer).not.toBeVisible();
  });
}
