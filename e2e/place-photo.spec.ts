import { expect, test, type Page } from "./support/test";
import { mockMapCatalog, type CatalogFixture, type CatalogOptions } from "./support/map-catalog";
import photos from "../backend/place-images-editorial.json" with { type: "json" };
import { MOSCOW_CENTER } from "../src/features/explore/map-jobs";

const editorial = photos["osm:way:35814561"];
// The backend serves the editorial entry in the place detail exactly like a synced Wikimedia photo.
const photo = { thumbnail: editorial.thumbnail, src: editorial.src, width: editorial.width, height: editorial.height, alt: editorial.alt,
  author: editorial.author as string | null, sourceUrl: editorial.sourceUrl, license: editorial.license, licenseUrl: editorial.licenseUrl };
const title = "Кинотеатр «Художественный»";

async function openPlace(page: Page, id = "osm:way:35814561", overrides: Partial<CatalogFixture> = {},
  intercept?: CatalogOptions["intercept"]) {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, items: [], walks: [] } }));
  await mockMapCatalog(page, [{ id, title, address: "Москва, Арбатская площадь, 14", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon,
    paragraphs: ["История кинотеатра. ".repeat(120)], audioUrl: "/api/story-audio/example.mp3", durationSec: 68,
    ...(id === "osm:way:35814561" ? { photo } : {}), ...overrides }], { intercept });
  await page.goto("/");
  await page.getByTitle(title, { exact: true }).click();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
}

/** Holds the place detail until `release` is called, so the card stays in its loading state. */
function heldDetail() {
  let release = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; });
  return { release: () => release(), intercept: async (path: string) => { if (path.startsWith("/api/content/places/")) await gate; } };
}

test("фото сверху карточки открывается с автором, удерживает фокус и возвращает его после Escape", async ({ page }) => {
  await openPlace(page);
  const trigger = page.getByRole("button", { name: `Открыть фото: ${title}` });
  // The banner is the full copy, so it is sharp across the card and the viewer opens from cache.
  await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
  // As in map apps: the photo spans the card above the title.
  expect(await trigger.evaluate(button => {
    const banner = button.getBoundingClientRect(), sheet = button.closest('[data-sheet="story"]')!.getBoundingClientRect();
    const heading = document.getElementById("selected-place-title")!.getBoundingClientRect();
    return Math.abs(banner.top - sheet.top) <= 1 && sheet.width - banner.width <= 2 && banner.bottom <= heading.top;
  })).toBe(true);
  const audio = await page.locator('[data-sheet="story"] audio').elementHandle();
  await trigger.click();
  const viewer = page.getByRole("dialog", { name: title, exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
  await expect(viewer).toContainText(`Фото: ${editorial.author}.`);
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

test("место под фото держится, пока грузится рассказ, и фото встаёт в него без сдвига", async ({ page }) => {
  const held = heldDetail();
  await openPlace(page, undefined, {}, held.intercept);
  const placeholder = page.locator("[data-photo-placeholder]");
  await expect(placeholder).toBeVisible();
  await expect(page.getByRole("button", { name: /^Открыть фото:/ })).toHaveCount(0);
  const media = page.locator('[data-sheet="story"] [data-sheet-part="media"]');
  const before = await media.evaluate(element => element.getBoundingClientRect().height);
  expect(before).toBeGreaterThan(44);
  held.release();
  await expect(page.getByRole("button", { name: `Открыть фото: ${title}` })).toBeVisible();
  await expect(placeholder).toHaveCount(0);
  // Sub-pixel rounding of the flex layout is not a visible shift.
  expect(Math.abs(await media.evaluate(element => element.getBoundingClientRect().height) - before)).toBeLessThanOrEqual(1);
});

test("если фото исчезло после загрузки индекса, заглушка уходит вместе с загрузкой", async ({ page }) => {
  const held = heldDetail();
  await openPlace(page, "osm:node:999999998", { indexPhoto: true }, held.intercept);
  await expect(page.locator("[data-photo-placeholder]")).toBeVisible();
  held.release();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("История кинотеатра.");
  await expect(page.locator("[data-photo-placeholder], [data-photo-banner]")).toHaveCount(0);
  await expect(page.locator('[data-sheet="story"] [data-sheet-part="media"]')).toBeHidden();
});

test("подпись фото без автора называет только источник и лицензию", async ({ page }) => {
  await openPlace(page, undefined, { photo: { ...photo, author: null } });
  await page.getByRole("button", { name: `Открыть фото: ${title}` }).click();
  const viewer = page.getByRole("dialog", { name: title, exact: true });
  await expect(viewer.locator("p").filter({ hasText: /^Фото:/ })).toHaveText(`Фото: Wikimedia Commons · ${photo.license}`);
});

test("карточка без фотографии не резервирует место под картинку", async ({ page }) => {
  await openPlace(page, "osm:node:999999999");
  await expect(page.getByRole("button", { name: /^Открыть фото:/ })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("История кинотеатра.");
});

test("ошибка загрузки фото убирает его место и сохраняет рассказ", async ({ page }) => {
  await page.route(`**${photo.src}`, route => route.fulfill({ status: 404, body: "" }));
  await openPlace(page);
  await expect(page.getByRole("button", { name: /^Открыть фото:/ })).toHaveCount(0);
  await expect(page.locator('[data-sheet="story"] [data-sheet-part="media"]')).toBeHidden();
  await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("История кинотеатра.");
});

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
  test(`фото и заголовок помещаются в экран ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openPlace(page);
    const trigger = page.getByRole("button", { name: `Открыть фото: ${title}` });
    await expect(trigger).toBeVisible();
    expect(await trigger.evaluate(button => {
      const photoBounds = button.getBoundingClientRect();
      const sheetBounds = button.closest('[data-sheet="story"]')!.getBoundingClientRect();
      return photoBounds.top >= sheetBounds.top - 1 && photoBounds.bottom <= sheetBounds.bottom && photoBounds.height >= 44;
    })).toBe(true);
    await expect(page.locator("#selected-place-title")).toBeInViewport();
    await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", photo.width);
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
