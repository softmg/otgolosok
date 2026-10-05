import { test, expect, type Page, type Locator } from "./support/test";
import { draftToWalkDocument } from "../src/features/walks/adapters";
import type { FoodPlace } from "../src/features/food/types";

const id = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const geometry = [0, 1, 2, 3, 4].map(i => ({ lat: 55.74 + i * .001, lon: 37.61 }));
const start = { address: "Начало прогулки", location: geometry[0] };
const destination = { address: "Финиш прогулки", location: geometry[4] };
const stops = geometry.slice(1, 4).map((location, i) => ({ address: `Остановка ${i + 1}`, location }));
const places: FoodPlace[] = ["Кофе у старта", "Пекарня по пути", "Кафе у сквера", "Ресторан у финиша"].map((name, i) => ({
  id: `osm:node:${i + 1}`, kind: (["coffee", "bakery", "cafe", "restaurant"] as const)[i], name,
  lat: 55.7405 + i * .001, lon: 37.6102, address: "Москва, Тестовая улица, 1", openingHours: i === 0 ? "24/7; PH off" : null,
  cuisine: "coffee_shop", website: "https://example.com/menu", phone: "+7 (999) 123-45-67",
}));
const etag = "a".repeat(32);
const manifest = { version: 1, cellSize: .05, sourceEditedAt: "2026-10-02T10:00:00Z", attribution: "© участники OpenStreetMap", cells: [{ lat: 1114, lon: 752, count: places.length, etag }] };

async function open(page: Page, options: { empty?: boolean; unavailable?: boolean; missingGeometry?: boolean; cellError?: "network" | "500"; manifestError?: boolean; timed?: boolean } = {}) {
  const document = draftToWalkDocument({ version: 1, title: "Прогулка с заведениями", start, destination, mode: "open", minutes: 30,
    stops, route: options.missingGeometry ? null : { stops, geometry, distanceM: 445, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  let failing = Boolean(options.cellError || options.manifestError), attempts = 0;
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/food/**", async route => {
    const isManifest = new URL(route.request().url()).pathname === "/api/food/cells";
    if (options.unavailable) { await route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }); return; }
    if (failing && (isManifest ? options.manifestError : options.cellError)) {
      attempts += 1;
      if (options.cellError === "network" && !isManifest) await route.abort("failed");
      else await route.fulfill({ status: 500, json: { error: "FAILED" } });
      return;
    }
    await route.fulfill({ headers: { ETag: `"${etag}"` }, json: isManifest ? manifest : { lat: 1114, lon: 752, places: options.empty ? [] : options.timed ? places.map((p, i) => i ? p : { ...p, openingHours: "Mo-Su 09:00-22:00" }) : places } });
  });
  await page.goto(`/walk?local=${id}`);
  await page.addStyleTag({ content: "nextjs-portal { display: none; }" });
  await expect(page.getByRole("heading", { name: document.title, exact: true })).toBeVisible();
  return { recover: () => { failing = false; }, attempts: () => attempts };
}
const foodButton = (page: Page) => page.getByRole("button", { name: "Поесть рядом", exact: true });
const drawer = (page: Page) => page.getByRole("region", { name: "Заведения вдоль маршрута" });
// Anchored: the «+» beside a venue names it too («Добавить «…» в прогулку»).
const row = (page: Page, name: string) => drawer(page).getByRole("button", { name: new RegExp(`^${name}`) });

async function insideWindow(locator: Locator, width: number, height: number) {
  await expect(locator).toBeInViewport({ ratio: 1 });
  const rect = await locator.boundingBox();
  expect(rect).not.toBeNull();
  expect(rect!.x).toBeGreaterThanOrEqual(0);
  expect(rect!.y).toBeGreaterThanOrEqual(0);
  expect(rect!.x + rect!.width).toBeLessThanOrEqual(width + 1);
  expect(rect!.y + rect!.height).toBeLessThanOrEqual(height + 1);
}

for (const [width, height] of [[390, 844], [1440, 900], [568, 400], [320, 568]]) {
  test(`список, карточка и футер в прогулке ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await open(page);
    const pins = page.locator('[data-marker="food"]');
    await expect(pins).toHaveCount(0);
    await foodButton(page).click();
    await expect(row(page, places[0].name)).toBeVisible();
    await expect(drawer(page).getByRole("heading", { name: "У остановки 1" })).toBeVisible();
    await expect(pins).toHaveCount(4);
    await insideWindow(page.locator(".walk-session-panel"), width, height);
    await insideWindow(page.locator('[data-sheet-part="footer"]'), width, height);
    await insideWindow(foodButton(page), width, height);
    expect(await page.locator(".walk-session-panel").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    const shot = (name: string) => width === 390 ? page.screenshot({ path: process.env.FOOD_SHOTS_DIR ? `${process.env.FOOD_SHOTS_DIR}/${name}.png` : info.outputPath(`${name}.png`) }) : Promise.resolve();
    await shot("food-before-start");
    await foodButton(page).click();
    await expect(pins).toHaveCount(0);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await foodButton(page).click();
    await expect(drawer(page).getByText(/^Позади/)).toBeVisible();
    await expect(row(page, places[0].name)).toBeHidden();
    await expect(row(page, places[3].name)).toBeVisible();
    await insideWindow(page.locator('[data-sheet-part="footer"]'), width, height);
    await expect(page.getByRole("button", { name: "Дальше", exact: true })).toBeInViewport({ ratio: 1 });
    await shot("food-during-walk");
    const activePath = await page.locator('[data-route-part="active"]').first().elementHandle();
    await row(page, places[3].name).click();
    const card = page.getByRole("region", { name: "Заведение", exact: true });
    await expect(card.getByRole("heading", { name: places[3].name })).toBeInViewport({ ratio: 1 });
    await expect(card.getByRole("button", { name: "Назад к списку" })).toBeInViewport({ ratio: 1 });
    await expect(card.getByText("Часы не указаны")).toBeVisible();
    await expect(card.getByRole("link", { name: "Сайт" })).toHaveAttribute("rel", "noopener noreferrer");
    await expect(card.getByRole("link", { name: "Сайт" })).toHaveAttribute("target", "_blank");
    await expect(card.getByRole("link", { name: "Позвонить" })).toHaveAttribute("href", "tel:+79991234567");
    await expect(card).toContainText("© участники OpenStreetMap");
    await expect(card).toContainText("2 октября 2026");
    expect(await activePath!.evaluate(path => path.isConnected)).toBe(true);
    await insideWindow(page.locator('[data-sheet-part="footer"]'), width, height);
    await shot("food-card");
    await card.getByRole("button", { name: "Назад к списку" }).click();
    await expect(drawer(page)).toBeVisible();
    await drawer(page).getByText(/^Позади/).click();
    await expect(row(page, places[0].name)).toBeVisible();
    await foodButton(page).click();
    await expect(pins).toHaveCount(0);
  });
}

test("стрелка назад стоит в футере перед «Поесть рядом»", async ({ page }) => {
  await open(page);
  const order = () => page.locator('[data-sheet-part="footer"] > *').evaluateAll(nodes => nodes.map(node => node.getAttribute("aria-label") ?? node.textContent?.trim()));
  await expect(foodButton(page)).toBeVisible();
  expect(await order()).toEqual(["Изменить маршрут", "Поесть рядом", "Начать прогулку"]);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("button", { name: "Предыдущая остановка", exact: true })).toBeVisible();
  expect(await order()).toEqual(["Предыдущая остановка", "Поесть рядом", "Дальше"]);
});

/** The footer as a user sees it: the main label on one line, round icons as tall as the action beside them, nothing past the edge. */
const footerShape = (page: Page) => page.locator('[data-sheet-part="footer"]').evaluate(footer => {
  const primary = footer.querySelector<HTMLElement>(".walk-session-primary")!;
  const label = document.createRange();
  label.selectNodeContents(primary.firstChild!);
  const box = (el: Element) => el.getBoundingClientRect();
  const icons = [...footer.children].filter(el => el !== primary).map(box);
  const action = box(primary), frame = box(footer);
  return {
    label: primary.textContent,
    lines: new Set([...label.getClientRects()].map(rect => Math.round(rect.top))).size,
    round: icons.every(rect => Math.abs(rect.width - rect.height) < 1),
    // Beside the icons the action is exactly as tall as they are; alone on its row it may not be taller either.
    stretched: icons.some(rect => Math.round(rect.height) !== Math.round(action.height)),
    inside: action.left >= frame.left - 0.5 && action.right <= frame.right + 0.5,
  };
});

// 393×852 — iPhone 16: there «Начать прогулку» and «К финишу» broke into two lines and stretched «Назад» into an oval.
for (const [width, height] of [[393, 852], [390, 844], [360, 640], [320, 568], [1440, 900]]) {
  test(`футер прогулки не переносит подпись и не растягивает значки ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await open(page);
    await expect(foodButton(page)).toBeVisible();
    const tidy = { lines: 1, round: true, stretched: false, inside: true };
    await expect.poll(() => footerShape(page)).toEqual({ label: "Начать прогулку", ...tidy });
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect.poll(() => footerShape(page)).toEqual({ label: "Дальше", ...tidy });
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect.poll(() => footerShape(page)).toEqual({ label: "К финишу", ...tidy });
  });
}

test("значок «Поесть рядом» — контурный, как стрелка назад", async ({ page }) => {
  await open(page);
  const look = (locator: Locator) => locator.locator("svg").evaluate(svg => {
    const style = getComputedStyle(svg);
    return { fill: style.fill, stroke: style.stroke, strokeWidth: style.strokeWidth, filled: [...svg.children].filter(node => !["none", "rgba(0, 0, 0, 0)"].includes(getComputedStyle(node).fill)).length };
  });
  const icon = await look(foodButton(page));
  expect(icon).toEqual(await look(page.getByRole("link", { name: "Изменить маршрут", exact: true })));
  expect(icon.filled).toBe(0);
});

test("метка открывает карточку с часами и возвратом к списку", async ({ page }) => {
  await open(page);
  await foodButton(page).click();
  const marker = page.locator('[data-marker="food"]').filter({ has: page.locator("svg") }).first();
  await expect(marker).toHaveAttribute("title", places[0].name);
  // A map marker may be behind the drawer; keyboard activation follows the same Leaflet click handler.
  await marker.focus();
  await page.keyboard.press("Enter");
  const card = page.getByRole("region", { name: "Заведение", exact: true });
  await expect(card.getByRole("heading", { name: places[0].name })).toBeVisible();
  await expect(card.getByText("Открыто круглосуточно")).toBeVisible();
  await expect(card.getByText("В праздники часы работы могут отличаться", { exact: true })).toBeVisible();
  await card.getByText("Часы работы по данным OpenStreetMap", { exact: true }).click();
  await expect(card.getByText("24/7; PH off", { exact: true })).toBeVisible();
  await card.getByRole("button", { name: "Назад к списку" }).click();
  await expect(drawer(page)).toBeVisible();
});

test("пустой список честно указывает радиус и источник", async ({ page }) => {
  await open(page, { empty: true });
  await foodButton(page).click();
  await expect(drawer(page).getByText("В 150 м от маршрута заведений нет по данным OpenStreetMap")).toBeVisible();
  await expect(page.locator('[data-marker="food"]')).toHaveCount(0);
  await expect(drawer(page)).toContainText("© участники OpenStreetMap");
});

for (const cellError of ["network", "500"] as const) {
  test(`ошибка ячейки ${cellError}: ограниченные повторы и восстановление`, async ({ page }) => {
    const api = await open(page, { cellError });
    await foodButton(page).click();
    await expect(drawer(page).getByText("Не удалось загрузить заведения")).toBeVisible({ timeout: 10_000 });
    expect(api.attempts()).toBe(3);
    await expect(drawer(page).getByText("В 150 м от маршрута заведений нет по данным OpenStreetMap")).toHaveCount(0);
    api.recover();
    await drawer(page).getByRole("button", { name: "Повторить" }).click();
    await expect(row(page, places[0].name)).toBeVisible();
    await expect(drawer(page).getByText("Не удалось загрузить заведения")).toHaveCount(0);
  });
}

for (const [width, height] of [[390, 844], [320, 568], [568, 320]]) {
  test(`ошибка манифеста: повтор и основное действие доступны ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const api = await open(page, { manifestError: true });
    await expect(page.getByText("Не удалось загрузить заведения", { exact: false })).toBeVisible({ timeout: 10_000 });
    await expect(foodButton(page)).toHaveCount(0);
    await insideWindow(page.locator('[data-sheet-part="footer"]'), width, height);
    await page.getByRole("button", { name: "Повторить", exact: true }).scrollIntoViewIfNeeded();
    await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeInViewport({ ratio: 1 });
    api.recover();
    await page.getByRole("button", { name: "Повторить", exact: true }).click();
    await expect(foodButton(page)).toBeVisible();
  });
}

test("часы обновляются на новой минуте и при повторном открытии списка", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-10-04T18:59:00Z") });
  await open(page, { timed: true });
  await foodButton(page).click();
  await expect(row(page, places[0].name)).toContainText("Открыто до 22:00");
  await page.clock.fastForward(60_000);
  await expect(row(page, places[0].name)).toContainText("Закрыто, откроется завтра в 9:00");
  await foodButton(page).click();
  await foodButton(page).click();
  await expect(row(page, places[0].name)).toContainText("Закрыто, откроется завтра в 9:00");
});

test("503 отключает заведения", async ({ page }) => {
  const response = page.waitForResponse("**/api/food/cells");
  await open(page, { unavailable: true });
  expect((await response).status()).toBe(503);
  await expect(foodButton(page)).toHaveCount(0);
  await expect(page.getByText("Не удалось загрузить заведения", { exact: false })).toHaveCount(0);
});

test("без геометрии функция отсутствует", async ({ page }) => {
  await open(page, { missingGeometry: true });
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeDisabled();
  await expect(foodButton(page)).toHaveCount(0);
});
