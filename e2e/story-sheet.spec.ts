import { expect, test, type Page } from "./support/test";
import { SAFE_AREA_CASES, VIEWPORTS } from "./support/layout";
import { mockGuestApi, openLongStory } from "./support/scenarios";
import { mockMapCatalog } from "./support/map-catalog";
import { MOSCOW_CENTER } from "../src/features/explore/map-jobs";

// Раскрываемая карточка истории на карте: свёрнутая — не прокручивается, развёрнутая — читается как страница.

const sheet = (page: Page) => page.locator('[data-sheet="story"]');
const handle = (page: Page) => page.locator('[data-sheet="story"] [data-sheet-part="handle"] button');
/** The collapsed card never scrolls: the sheet fits, and its body may clip the teaser but cannot be scrolled. */
async function expectNoScroll(page: Page) {
  expect(await sheet(page).evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
  expect(await sheet(page).locator('[data-sheet-part="body"]').evaluate(el => getComputedStyle(el).overflowY)).toBe("hidden");
}

/** Taps during a view transition reach the transition overlay, not the page: wait until the sheet has settled. */
async function settle(page: Page) {
  await page.waitForFunction(() => !document.documentElement.matches(":active-view-transition"));
}

type Box = { x: number; y: number; width: number; height: number } | null;
/** Sticky parts may land on a sub-pixel offset at a fractional scroll position; a pixel is not a visible shift. */
function expectSameBox(actual: Box, expected: Box) {
  expect(actual).not.toBeNull();
  for (const key of ["x", "y", "width", "height"] as const) expect(Math.abs(actual![key] - expected![key])).toBeLessThanOrEqual(1);
}

async function openStory(page: Page) {
  await mockGuestApi(page);
  await openLongStory(page);
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
}

async function swipe(page: Page, dx: number, dy: number) {
  await settle(page);
  const box = (await handle(page).boundingBox())!;
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 3 });
  await page.mouse.move(x + dx, y + dy, { steps: 3 });
  await page.mouse.up();
}

test("длинная история раскрывается на весь экран и сворачивается кнопкой «Назад» и Escape", async ({ page }, info) => {
  await openStory(page);
  const card = sheet(page);
  const close = page.getByRole("button", { name: "Закрыть карточку", exact: true });
  const player = card.getByRole("region", { name: "Плеер истории" });
  const footer = card.locator('[data-sheet-part="footer"]');

  // Свёрнутая карточка не прокручивается, подвал виден целиком.
  await expectNoScroll(page);
  const peek = (await card.boundingBox())!, footerBox = (await footer.boundingBox())!;
  expect(footerBox.y + footerBox.height).toBeLessThanOrEqual(peek.y + peek.height + 1);
  await page.screenshot({ path: info.outputPath("story-peek.png") });

  // Плеер — тот же элемент в обоих состояниях: раскрытие не останавливает запись.
  await page.locator('[data-sheet="story"] audio').evaluate(el => { (window as unknown as { storyAudio: Element }).storyAudio = el; });
  await settle(page);
  await handle(page).click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await expect(handle(page)).toHaveAccessibleName("Свернуть историю");
  await expect.poll(async () => card.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await expect(page.locator('[data-region="header"]')).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(0);
  await expect(card.getByRole("link", { name: "Создать прогулку отсюда" })).toBeVisible();

  // Прокручивается вся карточка; закрытие и плеер остаются на месте.
  const before = { close: await close.boundingBox(), player: await player.boundingBox() };
  expect(await card.evaluate(el => el.scrollHeight - el.clientHeight)).toBeGreaterThan(100);
  await card.evaluate(el => { el.scrollTop = el.scrollHeight; });
  await expect.poll(() => card.evaluate(el => el.scrollHeight - el.clientHeight - el.scrollTop)).toBeLessThanOrEqual(1);
  expectSameBox(await close.boundingBox(), before.close);
  expectSameBox(await player.boundingBox(), before.player);
  await page.screenshot({ path: info.outputPath("story-expanded-end.png") });

  // «Назад» сворачивает карточку, не уходя со страницы.
  await page.goBack();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
  expect(new URL(page.url()).pathname + new URL(page.url()).search).toBe("/");
  await expect(card).toBeVisible();
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
  expect(await page.locator('[data-sheet="story"] audio').evaluate(el => el === (window as unknown as { storyAudio: Element }).storyAudio)).toBe(true);

  // «Вперёд» раскрывает снова, Escape сворачивает.
  await page.goForward();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");

  // Закрытие развёрнутой карточки забирает её запись истории: «Назад» потом ничего не открывает.
  await settle(page);
  await handle(page).click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  await close.click();
  await expect(card).toHaveCount(0);
  await page.goBack();
  await expect(card).toHaveCount(0);
});

test("нажатие на начало текста раскрывает историю", async ({ page }) => {
  await openStory(page);
  await page.getByRole("region", { name: "Текст истории", exact: true }).locator("p").first().click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
});

/** Without a photo the grip has its own strip: its hit area ends above the title. */
async function expectHandleClearOfTitle(page: Page) {
  const grip = (await handle(page).boundingBox())!, title = (await page.locator("#selected-place-title").boundingBox())!;
  expect(grip.y + grip.height).toBeLessThanOrEqual(title.y + 1);
}

test("короткая история без фото: ручка не заходит на заголовок, плеер внизу, свободное место под текстом", async ({ page }) => {
  await mockGuestApi(page);
  await mockMapCatalog(page, [{ id: "short-story", title: "Короткая история", address: "Москва, Дербеневская, 3", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon,
    paragraphs: ["Первый абзац короткой истории.", "Второй абзац."], audioUrl: "/api/story-audio/short-story.mp3", durationSec: 30 }]);
  await page.goto("/");
  await page.locator('[title="Короткая история"]').dispatchEvent("click");
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
  await expectHandleClearOfTitle(page);
  await handle(page).click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  await expectHandleClearOfTitle(page);
  const layout = await sheet(page).evaluate(element => {
    const box = element.getBoundingClientRect(), footer = element.querySelector('[data-sheet-part="footer"]')!.getBoundingClientRect();
    const text = element.querySelector('[data-sheet-part="body"] p:last-of-type')!.getBoundingClientRect();
    return { footerGap: box.bottom - footer.bottom, room: footer.top - text.bottom, scroll: element.scrollHeight - element.clientHeight };
  });
  // The player sits at the bottom edge; the free room is between the text and the player.
  expect(Math.abs(layout.footerGap)).toBeLessThanOrEqual(1);
  expect(layout.room).toBeGreaterThan(100);
  expect(layout.scroll).toBeLessThanOrEqual(1);
});

test("свайп по ручке раскрывает и сворачивает карточку, горизонтальный — нет", async ({ page }) => {
  await openStory(page);
  await swipe(page, 60, 0);
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
  await swipe(page, 0, -80);
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await swipe(page, 0, 80);
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
});

test.describe("на сенсорном экране", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("свайп пальцем вверх раскрывает карточку", async ({ page }) => {
    await openStory(page);
    const box = (await handle(page).boundingBox())!;
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    const touch = await page.context().newCDPSession(page);
    await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let step = 1; step <= 4; step++) await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y - step * 20 }] });
    await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  });
});

test("карта после раскрытия и сворачивания стоит на месте", async ({ page }) => {
  await openStory(page);
  const marker = page.locator('[title="Длинная история"]');
  await page.waitForTimeout(500); // the map finishes centring on the marker
  const before = await marker.boundingBox();
  await settle(page);
  await handle(page).click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
  await settle(page);
  await handle(page).click();
  await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
  await page.waitForTimeout(500);
  expect(await marker.boundingBox()).toEqual(before);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 844, height: 390 }]) {
  test(`на широком экране ${viewport.width}×${viewport.height} развёрнутая карточка занимает свою колонку, карта затемнена`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openStory(page);
    await settle(page);
    await handle(page).click();
    await expect(handle(page)).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(0);
    const scrim = page.locator('[data-scrim]');
    await expect(scrim).toBeVisible();
    await settle(page);
    const card = (await sheet(page).boundingBox())!;
    // От верхней полосы подписи карты до нижнего отступа: вся высота колонки.
    expect(card.height).toBeGreaterThanOrEqual(viewport.height - 20 - 12 - 12 - 1);
    expect(card.width).toBeLessThan(viewport.width / 2 + 1);
    await page.screenshot({ path: info.outputPath("story-expanded-wide.png") });
    // Щелчок по затемнённой карте рядом с колонкой сворачивает карточку.
    const free = card.x + card.width / 2 > viewport.width / 2 ? { x: 20, y: viewport.height / 2 } : { x: viewport.width - 20, y: viewport.height / 2 };
    await settle(page);
    await page.mouse.click(free.x, free.y);
    await expect(handle(page)).toHaveAttribute("aria-expanded", "false");
    await expect(scrim).toHaveCount(0);
  });
}

for (const { name, viewport, safeArea } of [...VIEWPORTS.map(viewport => ({ name: `${viewport.width}×${viewport.height}`, viewport, safeArea: undefined })), ...SAFE_AREA_CASES]) {
  test(`свёрнутая длинная история ${name}: без прокрутки, заголовок и подвал видны`, async ({ page, browserName }) => {
    test.skip(safeArea !== undefined && browserName !== "chromium", "Вырезы эмулируются только в Chromium");
    await page.setViewportSize(viewport);
    if (safeArea) await (await page.context().newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets: safeArea });
    await mockGuestApi(page);
    await openLongStory(page, { visible: false });
    await expectNoScroll(page);
    const card = (await sheet(page).boundingBox())!;
    for (const part of [page.getByRole("heading", { name: "Длинная история", exact: true }), sheet(page).locator('[data-sheet-part="footer"]')]) {
      const box = (await part.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(card.y - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(Math.min(card.y + card.height, viewport.height) + 1);
    }
  });
}
