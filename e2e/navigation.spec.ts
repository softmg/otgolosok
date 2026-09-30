import { expect, test, type Locator, type Page } from "@playwright/test";
import { draftToWalkDocument } from "../src/features/walks/adapters";

// Телефон с сенсорным экраном. Без hasTouch Chromium не выполняет условие pointer:coarse,
// и правило навигации для горизонтального телефона в тестах не действует.
test.use({ hasTouch: true, isMobile: true });

const user = { id: "test", name: "Анна", email: "test@example.test" };
const walkId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stop = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };
const walk = draftToWalkDocument({ version: 1, title: "Арбат", start, destination: stop, mode: "open", minutes: 30, stops: [stop],
  route: { stops: [stop], geometry: [start.location, stop.location], distanceM: 200, walkingMinutes: 3, attribution: "OSM" }, jobs: [], submitting: null }, walkId);

const screens: [string, string, (page: Page) => Locator][] = [
  ["прогулки", `/walk?local=${walkId}`, page => page.getByRole("button", { name: "Начать прогулку", exact: true })],
  ["истории", "/history", page => page.getByRole("heading", { name: "История прогулок", exact: true })],
  ["профиля", "/account", page => page.getByRole("heading", { name: user.name, exact: true })],
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id: walkId, document: walk });
  await page.route("**/api/**", route => route.fulfill({ json: { user, walks: [], requests: [], favorites: [], nextCursor: null } }));
});

// Поля от навигации до левого, правого и нижнего края окна и её оформление.
function navigationLook(page: Page) {
  return page.getByRole("navigation", { name: "Основная навигация" }).evaluate(el => {
    const box = el.getBoundingClientRect();
    const { border, borderRadius, boxShadow } = getComputedStyle(el);
    return { left: box.left, right: innerWidth - box.right, bottom: innerHeight - box.bottom, border, borderRadius, boxShadow };
  });
}

// Навигация — один островок в любом положении телефона: по центру, не шире 430 px, с теми же рамкой, скруглением и тенью.
for (const [name, path, ready] of screens) for (const [width, height] of [[667, 375], [844, 390], [932, 430]]) {
  test(`навигация на странице ${name} остаётся в окне при повороте телефона ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width: height, height: width });
    await page.goto(path);
    await expect(ready(page)).toBeVisible();
    const portrait = await navigationLook(page);
    await page.setViewportSize({ width, height });
    const landscape = await navigationLook(page);
    expect(landscape.left).toBeGreaterThanOrEqual(0);
    expect(landscape.right).toBeGreaterThanOrEqual(0);
    expect(Math.abs(landscape.left - landscape.right)).toBeLessThanOrEqual(1);
    expect(width - landscape.left - landscape.right).toBeLessThanOrEqual(430);
    expect({ ...landscape, left: 0, right: 0 }).toEqual({ ...portrait, left: 0, right: 0 });
    await page.screenshot({ path: info.outputPath("navigation-landscape.png") });
  });
}
