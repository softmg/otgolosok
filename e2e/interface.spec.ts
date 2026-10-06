import { expect, test, type Page } from "./support/test";
import { mockMapCatalog } from "./support/map-catalog";
import { MOSCOW_CENTER } from "../src/features/explore/map-jobs";

async function openLongStory(page: Page) {
  const text = "Корпус имеет сложную, отдалённо Т-образную форму, а главный фасад построен как трёхчастная композиция. ".repeat(5);
  await mockMapCatalog(page, [{ id: "osm:way:900000001", title: "Длинная история", address: "Москва, Дербеневская, 1", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon, paragraphs: [text, text, text], audioUrl: "/api/story-audio/long-story.mp3", durationSec: 120 }]);
  await page.goto("/");
  await page.locator('[title="Длинная история"]').click();
  const story = page.getByRole("region", { name: "Текст истории", exact: true });
  await expect(story).toBeVisible();
  return story;
}

for (const endpoint of ["Откуда", "Куда"]) {
  test(`точка карты сразу подставляется в ${endpoint}`, async ({ page }) => {
    let fail = true;
    const place = { address: "Москва, Арбат, 10", location: { lat: 55.75, lon: 37.6 } };
    await page.route("**/api/story-place?*", route => route.fulfill(fail
      ? { status: 404, json: { error: "Адрес не найден" } }
      : { json: place }));
    await page.goto("/?walk=create");
    await page.getByRole("button", { name: new RegExp(`^${endpoint}`) }).click();
    await page.getByRole("button", { name: "Выбрать на карте", exact: true }).click();
    await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
    await page.locator(`[data-region="map"]`).click({ position: { x: 150, y: 200 } });
    await expect(page.locator('[data-sheet="creation"] [role=alert]')).toBeVisible();
    await expect(page.locator('[data-sheet="creation"][data-state="picking"]')).toBeVisible();
    fail = false;
    await page.locator(`[data-region="map"]`).click({ position: { x: 160, y: 210 } });
    await expect(page.locator('[data-sheet="creation"][data-state="picking"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^${endpoint}`) })).toContainText(place.address);
    await expect(page.getByRole("button", { name: "Выбрать эту точку" })).toHaveCount(0);
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, walks: [], nextCursor: null, items: [], version: 1, cellSize: 1, cells: [] } }));
});

test("карта автоматически восстанавливается после обновления сервиса", async ({ page }) => {
  let maintenance = true;
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/service-status", route => route.fulfill({ status: maintenance ? 503 : 200, json: { maintenance } }));
  await mockMapCatalog(page, [{ id: "recovered-place", title: "Восстановленное место", address: "Москва", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon }], {
    intercept: (_path, route) => maintenance ? route.fulfill({ status: 503, json: { error: { code: "SERVICE_MAINTENANCE" } } }).then(() => true) : false,
  });
  const unavailableCatalog = page.waitForResponse(response => response.url().includes("/api/content/map-cells") && response.status() === 503);
  await page.goto("/");
  await expect(page.getByText("Сервис обновляется. Карта загрузится автоматически.")).toBeVisible();
  await unavailableCatalog;
  await expect(page.getByRole("button", { name: "Повторить загрузку мест" })).toHaveCount(0);
  const healthyStatus = page.waitForResponse(response => new URL(response.url()).pathname === "/service-status" && response.status() === 200, { timeout: 15_000 });
  maintenance = false;
  await healthyStatus;
  await expect(page.locator('[title="Восстановленное место"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

// Шапка карты высотой с кнопки карты, поэтому знак в ней меньше, чем на остальных страницах.
test("знак на карте меньше, чем на странице входа", async ({ page }) => {
  const sizes: string[] = [];
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    sizes.push(await page.locator(".brand-mark").first().evaluate(el => getComputedStyle(el).fontSize));
  }
  expect(sizes).toEqual(["22px", "28px"]);
});

test("история загружает следующую страницу аккаунтных прогулок", async ({ page }, info) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "test", name: "Анна", email: "test@example.test" } } }));
  await page.route("**/api/me/walks*", route => route.fulfill({ json: { walks: [{ id: route.request().url().includes("cursor=") ? "two" : "one", title: route.request().url().includes("cursor=") ? "Вторая прогулка" : "Первая прогулка", revision: 0 }], nextCursor: route.request().url().includes("cursor=") ? null : "next" } }));
  await page.goto("/history");
  await expect(page.getByText("Первая прогулка", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Показать ещё" }).click();
  await expect(page.getByText("Вторая прогулка", { exact: true })).toBeVisible();
  await page.screenshot({ path: info.outputPath("history-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath("history-desktop.png"), fullPage: true });
});

test("сбой сессии не выглядит как отсутствие прогулок", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ status: 503, json: {} }));
  await page.goto("/history");
  await expect(page.locator("main").getByRole("alert")).toContainText("вход");
});

test("вкладки истории переключаются кликом и клавишами, а URL следует за ними", async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, walks: [] } }));
  await page.goto("/history?tab=top");
  const mine = page.getByRole("tab", { name: "Мои прогулки", exact: true }), top = page.getByRole("tab", { name: "Топ прогулок", exact: true });
  await expect(top).toHaveAttribute("aria-selected", "true");
  await mine.click();
  await expect(mine).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#history-panel-mine")).toBeVisible();
  await expect(page).toHaveURL(/\/history\/?\?tab=mine$/);
  await mine.press("ArrowRight");
  await expect(top).toHaveAttribute("aria-selected", "true");
  await expect(top).toBeFocused();
  await expect(page.locator("#history-panel-top")).toBeVisible();
  await expect(page).toHaveURL(/\/history\/?\?tab=top$/);
});

test("создаёт A→Б на карте и восстанавливает его из истории", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const destination = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };
  await page.route("**/api/story-place?*", route => route.fulfill({ json: route.request().url().includes("20") ? destination : start }));
  await page.route("**/api/walk-plan", async route => {
    const request = route.request().postDataJSON();
    expect(request.destination).toEqual(destination);
    expect(request).not.toHaveProperty("stops");
    await route.fulfill({ json: { stops: [], geometry: [start.location, destination.location], walkingMinutes: 4, distanceM: 220, attribution: "OSM" } });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Прогулка", exact: true }).click();
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: false }).click();
  await page.getByRole("textbox", { name: "Откуда", exact: true }).fill(start.address);
  await page.getByRole("textbox").press("Enter");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: false }).click();
  await page.getByRole("textbox", { name: "Куда", exact: true }).fill(destination.address);
  await page.getByRole("textbox").press("Enter");
  await page.getByRole("button", { name: "Построить прогулку" }).click();
  // The built walk opens right away: the builder no longer repeats the route before the walk page.
  await expect(page).toHaveURL(/\/walk\?local=/);
  await expect(page.locator('[data-sheet="creation"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  // Start and finish are rings, not numbered stops.
  await expect(page.locator('.leaflet-marker-pane [data-marker="endpoint"]')).toHaveCount(2);
  await expect(page.locator('.leaflet-marker-pane [data-marker="pin"]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("built-walk.png") });
  await page.getByRole("link", { name: "Изменить маршрут", exact: true }).click();
  await expect(page.locator('[data-sheet="creation"]')).toContainText(destination.address);
  await expect(page.locator('.leaflet-marker-pane [data-marker="endpoint"]')).toHaveCount(2);
  await expect(page.locator('.leaflet-marker-pane [data-marker="pin"]')).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сохранить в аккаунте" })).toHaveCount(0);
  await expect(page.locator('[data-sheet="creation"] [role=status]')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("builder-with-route.png") });
  await expect(page.getByRole("button", { name: "Открыть прогулку", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть создание прогулки" }).click();
  await page.getByRole("link", { name: "История", exact: true }).click();
  await page.getByRole("link", { name: "Редактировать" }).click();
  await expect(page.locator('[data-sheet="creation"]')).toContainText(destination.address);
  await page.getByRole("button", { name: "Открыть прогулку", exact: true }).click();
  await expect(page.locator('[data-sheet="creation"]')).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Открыть мою прогулку" })).toHaveCount(0);
  const frame = page.locator('[data-region="map"]');
  await expect(frame).toBeVisible();
  expect(await frame.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThan(200);
  const overlay = frame.locator(".leaflet-route-pane svg");
  await expect(overlay).toBeVisible();
  await expect.poll(() => overlay.evaluate(el => Math.abs(el.getBoundingClientRect().width - Number(el.getAttribute("width"))))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("walk-page.png") });
  expect(errors).toEqual([]);
});

test("дом передаёт старт, возврат включён по умолчанию, Back закрывает панель", async ({ page }) => {
  await mockMapCatalog(page, [{ id: "osm:node:1002", title: "Дом для прогулки", address: "Москва, Дербеневская, 1", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon }]);
  await page.goto("/");
  await page.locator('[title="Дом для прогулки"]').click();
  // «Создать прогулку отсюда» — в развёрнутой карточке истории.
  await page.getByRole("button", { name: "Читать историю полностью" }).click();
  await page.getByRole("link", { name: "Создать прогулку отсюда" }).click();
  await expect(page.locator('[data-creation="endpoints"]')).toContainText("Москва, Дербеневская, 1");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени" }).click();
  await expect(page.getByRole("checkbox", { name: "Вернуться к началу" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Вернуться к началу" }).uncheck();
  await page.goBack();
  await expect(page.locator('[data-sheet="creation"]')).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole("button", { name: "Продолжить", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени" }).click();
  await expect(page.getByRole("checkbox", { name: "Вернуться к началу" })).toBeChecked();
  await page.getByRole("link", { name: "История", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка от Москва, Дербеневская, 1", exact: true })).toHaveCount(2);
});

test("восстанавливает исследование после перезагрузки без повторного заказа", async ({ page }) => {
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const request = { start, mode: "loop", minutes: 30 };
  const id = "11111111-1111-4111-8111-111111111111";
  const draft = { version: 1, title: "Исследование", start, mode: "loop", minutes: 30, stops: [], route: null, jobs: [], submitting: null, research: { request, id, stops: [], recoveryToken: id } };
  await page.addInitScript(value => { if (!localStorage.getItem("otgolosok:walk:v1")) localStorage.setItem("otgolosok:walk:v1", JSON.stringify(value)); }, draft);
  let posts = 0;
  await page.route("**/api/walk-research-jobs/**", route => {
    if (route.request().method() === "POST") posts++;
    return route.fulfill({ json: { id, request, stage: "queued", revision: 0, phase: "discovery", progress: { checked: 0, total: 0, accepted: 0 }, route: null, stories: [], error: null, canRetry: false } });
  });
  await page.goto("/?walk=create&resume=1");
  await expect(page.getByText("Ждём своей очереди", { exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Ждём своей очереди", { exact: true })).toBeVisible();
  expect(posts).toBe(0);
});

test("профиль сохраняет имя даже при отказе избранного", async ({ page }, info) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "test", name: "Анна", email: "test@example.test" } } }));
  await page.route("**/api/me/requests*", route => route.fulfill({ json: { requests: [] } }));
  await page.route("**/api/me/favorites*", route => route.fulfill({ status: 503, json: { error: { message: "Избранное временно недоступно" } } }));
  await page.route("**/api/me", route => route.fulfill({ json: { user: { id: "test", name: route.request().postDataJSON().name, email: "test@example.test" } } }));
  await page.goto("/account");
  await expect(page.getByLabel("Ваше имя")).toHaveCount(0);
  await expect(page.getByText("Личное пространство", { exact: true })).toHaveCount(0);
  const social = page.getByRole("region", { name: "Отголосок в соцсетях" });
  await expect(social.getByRole("link", { name: /Telegram/ })).toHaveAttribute("href", "https://t.me/otgolosok_online");
  await expect(social.getByRole("link", { name: /YouTube/ })).toHaveAttribute("href", "https://www.youtube.com/@otgolosok-online/shorts");
  await page.getByRole("button", { name: "Редактировать профиль", exact: true }).click();
  await page.getByLabel("Ваше имя").fill("Анна Новая");
  await page.getByRole("button", { name: "Сохранить изменения" }).click();
  await expect(page.getByRole("heading", { name: "Анна Новая" })).toBeVisible();
  await expect(page.getByRole("status")).toContainText("Имя сохранено");
  await page.screenshot({ path: info.outputPath("profile-mobile.png"), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: info.outputPath("profile-desktop.png"), fullPage: true });
});

test("локальный выход очищает приватный кеш даже при отказе сервера", async ({ page }) => {
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "test", name: "Анна", email: "test@example.test" } } }));
  await page.route("**/api/me/requests*", route => route.fulfill({ json: { requests: [] } }));
  await page.route("**/api/me/favorites*", route => route.fulfill({ json: { favorites: [] } }));
  await page.route("**/api/auth/sign-out", route => route.fulfill({ status: 503, json: {} }));
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Анна", exact: true })).toBeVisible();
  await page.evaluate(async () => {
    const cache = await caches.open("walk-packs-v1");
    await cache.put("/__offline/walks/test/private/pointer.json", new Response("private"));
    await cache.put("/__offline/walks/guest/public/pointer.json", new Response("public"));
  });
  await page.getByRole("button", { name: "Выйти", exact: true }).click();
  await page.getByRole("button", { name: "Подтвердить выход", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(async () => {
    const cache = await caches.open("walk-packs-v1");
    return { private: Boolean(await cache.match("/__offline/walks/test/private/pointer.json")), public: Boolean(await cache.match("/__offline/walks/guest/public/pointer.json")), signedOut: Boolean(localStorage.getItem("otgolosok:auth:offline-logout")) };
  })).toEqual({ private: false, public: true, signedOut: true });
});

test("правки точек аккаунтной прогулки сохраняются после перезагрузки", async ({ page }) => {
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const destination = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };
  const replacement = { address: "Москва, Арбат, 30", location: { lat: 55.754, lon: 37.6 } };
  const draft = { version: 1, title: "Маршрут в аккаунте", start, destination, mode: "open", minutes: 30, stops: [], route: { stops: [], geometry: [start.location, destination.location], walkingMinutes: 4, distanceM: 220, attribution: "OSM" }, jobs: [], submitting: null };
  await page.route("**/api/auth/session", route => route.fulfill({ json: { user: { id: "test", name: "Анна", email: "test@example.test" } } }));
  await page.route("**/api/me/walks/**", route => route.fulfill({ json: { walk: { id: "11111111-1111-4111-8111-111111111111", revision: 1, snapshot: draft } } }));
  await page.route("**/api/story-place?*", route => route.fulfill({ json: replacement }));
  await page.goto("/?walk=create&id=11111111-1111-4111-8111-111111111111&edit=1");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: true }).click();
  await page.getByRole("textbox", { name: "Куда", exact: true }).fill(replacement.address);
  await page.getByRole("textbox", { name: "Куда", exact: true }).press("Enter");
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText(replacement.address);
  await page.reload();
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText(replacement.address);
});

test("Escape закрывает панель и возвращает фокус в навигацию", async ({ page }) => {
  await page.goto("/");
  const opener = page.getByRole("link", { name: "Прогулка", exact: true });
  await opener.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Прогулка", exact: true })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-sheet="creation"]')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

for (const [width, height] of [[360, 800], [390, 844], [568, 400], [844, 390], [699, 800], [700, 800], [768, 1024], [1440, 900]]) {
  test(`панель и навигация не перекрываются ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.goto("/?walk=create");
    await expect(page.getByRole("button", { name: "Откуда", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "По времени" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Прогулка", exact: true })).toBeVisible();
    const panel = await page.locator('[data-sheet="creation"]').boundingBox();
    expect(panel!.height).toBeLessThanOrEqual(240);
    const nav = await page.getByRole("navigation", { name: "Основная навигация" }).boundingBox();
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(nav!.y);
    for (const item of await page.getByRole("navigation").locator("a,button").all()) {
      const box = await item.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
    await expect(page.locator('[data-sheet]:not([data-sheet="creation"])')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("creation.png") });
  });
}

for (const width of [390, 1440]) {
  test(`список выбора расположен у активного поля ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?walk=create");
    // The loading notice shares the dock with the sheet and moves it when it goes away.
    await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
    const start = page.getByRole("button", { name: "Откуда", exact: true });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Прогулка", exact: true })).toBeVisible();
    const startBox = await start.boundingBox();
    const menuBox = await page.locator("#creation-picker").boundingBox();
    const finishBox = await page.getByRole("button", { name: "Куда", exact: true }).boundingBox();
    expect(menuBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height - 1);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(finishBox!.y);
    expect((await page.locator('[data-sheet="creation"]').boundingBox())!.height).toBeLessThan(430);
    expect(await start.evaluate(el => getComputedStyle(el).outlineOffset)).toBe("-3px");
    await page.screenshot({ path: info.outputPath("start-options.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator("#creation-picker")).toHaveCount(0);
    await expect(start).toBeFocused();
  });
}

test("ручной адрес подтверждается кнопкой без каталога и сохраняется при ошибке", async ({ page }) => {
  let attempts = 0;
  await mockMapCatalog(page, []);
  await page.route("**/api/story-place?*", route => {
    attempts++;
    return route.fulfill(attempts === 1 ? { status: 404, json: { error: { message: "Уточните номер дома" } } } : { json: { address: "Москва, Дербеневская улица, 3", location: { lat: 55.7254969, lon: 37.6513112 } } });
  });
  await page.goto("/?walk=create");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Куда", exact: true });
  await input.fill("Дербеневская 3");
  await page.getByRole("button", { name: "Подтвердить адрес" }).click();
  await expect(page.locator('[data-sheet="creation"]').getByRole("alert")).toContainText("Уточните номер дома");
  await expect(input).toHaveValue("Дербеневская 3");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText("Москва, Дербеневская улица, 3");
  await expect(page.getByRole("button", { name: "Выбрать эту точку" })).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("после выбора старта предлагает готовые прогулки рядом и открывает выбранную", async ({ page }) => {
  const card = { walkingMinutes: 45, distanceM: 3200, stopCount: 6, rating: { average: 4.6, count: 12 }, finish: "Москва, Садовническая улица, 5" };
  const walks = [
    { ...card, kind: "catalog", id: "msk-kozhevniki-zindel-short", title: "Кожевники", startDistanceM: 350 },
    { ...card, kind: "shared", id: "22222222-2222-4222-8222-222222222222", title: "Арбат", startDistanceM: 0 },
    { ...card, kind: "own", id: "33333333-3333-4333-8333-333333333333", title: "Моя прогулка", rating: { average: null, count: 0 }, startDistanceM: 100 },
  ];
  const queries: string[] = [];
  await page.route("**/api/walks/nearby?*", route => { queries.push(new URL(route.request().url()).search); return route.fulfill({ json: { walks } }); });
  await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, Дербеневская улица, 3", location: { lat: 55.7254969, lon: 37.6513112 } } }));
  await page.goto("/?walk=create");
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: true }).click();
  await page.getByRole("textbox", { name: "Откуда", exact: true }).fill("Дербеневская 3");
  await page.getByRole("textbox", { name: "Откуда", exact: true }).press("Enter");
  const nearby = page.locator('[data-sheet="creation"] [data-sheet-part="body"] [data-creation="nearby"]');
  const summary = nearby.getByText("Прогулки рядом · 3", { exact: true });
  await expect(summary).toBeVisible();
  // Collapsed until clicked, so the sheet keeps its height.
  await expect(nearby.getByRole("link").first()).toBeHidden();
  await summary.click();
  await expect(nearby.getByRole("link")).toHaveCount(3);
  await expect(nearby.getByRole("link").first()).toBeVisible();
  expect(queries).toEqual(["?lat=55.72550&lon=37.65131"]);
  await expect(nearby.getByRole("link", { name: /Моя прогулка/ })).toContainText("Ваша");
  await expect(nearby.getByRole("link", { name: /Кожевники/ })).toContainText("старт в 350 м");
  await expect(nearby.getByRole("link", { name: /Кожевники/ })).toContainText("до Садовническая улица, 5");
  await nearby.getByRole("link", { name: /Кожевники/ }).click();
  await expect(page).toHaveURL(/\/walk\?catalog=msk-kozhevniki-zindel-short$/);
});

test("без старта при разрешённой геолокации предлагает прогулки близко к пользователю", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 55.7262, longitude: 37.6485, accuracy: 30 });
  const queries: string[] = [];
  await page.route("**/api/walks/nearby?*", route => {
    queries.push(new URL(route.request().url()).search);
    return route.fulfill({ json: { walks: [{ kind: "catalog", id: "msk-kozhevniki-zindel-short", title: "Кожевники", walkingMinutes: 45, distanceM: 3200, stopCount: 6,
      rating: { average: null, count: 0 }, startDistanceM: 350, finish: "Москва, Садовническая улица, 5" }] } });
  });
  await page.goto("/?walk=create");
  const nearby = page.locator('[data-sheet="creation"] [data-creation="nearby"]');
  await nearby.getByText("Близко к вам · 1", { exact: true }).click();
  await expect(nearby.getByRole("link", { name: /Кожевники/ })).toContainText("в 350 м от вас");
  expect(queries).toEqual(["?lat=55.72620&lon=37.64850"]);
});

test("время имеет мягкий акцент и сразу позволяет построить прогулку", async ({ page }) => {
  await page.goto("/?walk=create");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени", exact: true }).click();
  const duration = page.getByRole("button", { name: "60 мин", exact: true });
  await duration.click();
  await expect(duration).toHaveAttribute("aria-pressed", "true");
  expect(await duration.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(32, 62, 56, 0.12)");
  await expect(page.getByRole("button", { name: "Готово", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText("60 мин пешком");
});

test("карточка выбранного дома не оставляет пустую строку над адресом", async ({ page }, info) => {
  await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, 1-й Дербеневский переулок, 5", location: { lat: 55.725, lon: 37.65 } } }));
  await page.goto("/");
  await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
  await page.locator(`[data-region="map"]`).click({ position: { x: 180, y: 200 } });
  const title = page.getByRole("heading", { name: "Москва, 1-й Дербеневский переулок, 5", exact: true });
  await expect(title).toBeVisible();
  const card = await page.locator('[aria-labelledby="new-place-title"]').boundingBox();
  const heading = await title.boundingBox();
  const close = await page.getByRole("button", { name: "Закрыть выбранное место", exact: true }).boundingBox();
  expect(heading!.y - card!.y).toBeLessThanOrEqual(24);
  expect(close!.x).toBeGreaterThanOrEqual(heading!.x + heading!.width);
  await page.screenshot({ path: info.outputPath("place-card.png") });
  await page.getByRole("button", { name: "Закрыть выбранное место", exact: true }).click();
  await expect(title).toHaveCount(0);
});

const shortPortraits: [number, number, { top: number; bottom: number }?][] = [[375, 667], [360, 640], [390, 700], [375, 667, { top: 47, bottom: 34 }]];
for (const [width, height, insets] of shortPortraits) {
  test(`длинная история не заходит на кнопки карты ${width}×${height}${insets ? ` с вырезами ${insets.top}/${insets.bottom}` : ""}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    // Вырезы сдвигают и кнопки, и нижнюю панель: зазор между ними сохраняется.
    if (insets) await (await page.context().newCDPSession(page)).send("Emulation.setSafeAreaInsetsOverride", { insets });
    await openLongStory(page);
    // Свёрнутая карточка не прокручивается: длинный текст обрезан до начала, полностью он читается в развёрнутой.
    expect(await page.locator('[data-sheet="story"]').evaluate(el => el.scrollHeight - el.clientHeight)).toBeLessThanOrEqual(1);
    expect(await page.locator('[data-sheet="story"] [data-sheet-part="body"]').evaluate(el => getComputedStyle(el).overflowY)).toBe("hidden");
    const sheet = (await page.locator('[data-sheet="story"]').boundingBox())!;
    for (const control of [page.getByRole("button", { name: "Моё местоположение", exact: true }), page.getByRole("group", { name: "Масштаб карты" })]) {
      const box = (await control.boundingBox())!;
      expect(sheet.y - (box.y + box.height)).toBeGreaterThanOrEqual(8);
    }
    await page.screenshot({ path: info.outputPath("story-card-controls.png") });
  });
}

test("подпись карты размером 11 пикселей без подчёркивания прижата к верхнему краю", async ({ page }) => {
  await page.goto("/");
  const attribution = page.getByRole("link", { name: "OpenStreetMap", exact: true });
  expect((await attribution.boundingBox())!.y).toBeLessThanOrEqual(1);
  await expect(attribution).toBeVisible();
  expect(await attribution.evaluate(el => ({ size: getComputedStyle(el).fontSize, decoration: getComputedStyle(el).textDecorationLine }))).toEqual({ size: "11px", decoration: "none" });
  await expect(attribution).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
});

test("подпись карты сворачивается при касании карты и открывается кнопкой", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
  await page.locator('[data-region="map"]').dispatchEvent("pointerdown");
  await expect(page.getByRole("link", { name: "OpenStreetMap", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Источник данных карты" }).click();
  await expect(page.getByRole("link", { name: "OpenStreetMap", exact: true })).toBeFocused();
});

test("выбор на карте показывает понятный заголовок и контурную отмену", async ({ page }, info) => {
  await page.goto("/?walk=create");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать на карте", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Куда идём?", exact: true })).toBeVisible();
  const cancel = page.getByRole("button", { name: "Отменить", exact: true });
  const style = await cancel.evaluate(el => ({ background: getComputedStyle(el).backgroundColor, border: getComputedStyle(el).borderTopWidth }));
  expect(style).toEqual({ background: "rgba(0, 0, 0, 0)", border: "1px" });
  await page.screenshot({ path: info.outputPath("map-picking.png") });
  await cancel.click();
  await expect(page.getByRole("heading", { name: "Прогулка", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toBeVisible();
  await expect(page.locator('[data-sheet="creation"][data-state="picking"]')).toHaveCount(0);
});

for (const endpoint of ["Откуда", "Куда"]) {
  test(`крестик сбрасывает ввод ${endpoint} и сохраняет другое поле`, async ({ page }) => {
    await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, Арбат, 10", location: { lat: 55.75, lon: 37.6 } } }));
    await page.goto("/?walk=create");
    for (const label of ["Откуда", "Куда"]) {
      await page.getByRole("button", { name: label, exact: true }).click();
      await page.getByRole("button", { name: "Ввести адрес", exact: true }).click();
      await page.getByRole("textbox", { name: label, exact: true }).fill("Москва, Арбат, 10");
      await page.getByRole("textbox", { name: label, exact: true }).press("Enter");
    }
    await page.getByRole("button", { name: endpoint, exact: true }).click();
    await page.getByRole("button", { name: "Ввести адрес", exact: true }).click();
    await page.getByRole("textbox", { name: endpoint, exact: true }).fill("Несуществующий адрес");
    await page.getByRole("button", { name: `Отменить ввод: ${endpoint}`, exact: true }).click();
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.getByRole("button", { name: endpoint, exact: true })).toContainText(endpoint === "Откуда" ? "Выберите начало" : "Выберите место или время");
    await expect(page.getByRole("button", { name: endpoint === "Откуда" ? "Куда" : "Откуда", exact: true })).toContainText("Москва, Арбат, 10");
  });
}

test("клик карты после создания от дома задаёт финиш, а явный выбор меняет старт", async ({ page }) => {
  const start = "Москва, Дербеневская, 1";
  const finish = "Москва, Арбат, 10";
  await mockMapCatalog(page, [{ id: "osm:node:1003", title: "Стартовый дом", address: start, lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon }]);
  await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: finish, location: { lat: 55.75, lon: 37.6 } } }));
  await page.goto("/");
  await page.locator('[title="Стартовый дом"]').click();
  // «Создать прогулку отсюда» — в развёрнутой карточке истории.
  await page.getByRole("button", { name: "Читать историю полностью" }).click();
  await page.getByRole("link", { name: "Создать прогулку отсюда" }).click();
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(start);
  await page.locator(`[data-region="map"]`).click({ position: { x: 150, y: 200 } });
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText(finish);
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(start);
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать на карте", exact: true }).click();
  await page.locator(`[data-region="map"]`).click({ position: { x: 160, y: 210 } });
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(finish);
});

test("достопримечательности остаются компактными точками при создании прогулки", async ({ page }) => {
  await mockMapCatalog(page, [{ id: "landmark", title: "Тестовая достопримечательность", address: "Москва, Арбат, 10", lat: MOSCOW_CENTER.lat, lon: MOSCOW_CENTER.lon }]);
  await page.goto("/");
  const pin = page.locator('[title="Тестовая достопримечательность"]');
  await expect(pin).toBeVisible();
  await page.getByRole("link", { name: "Прогулка", exact: true }).click();
  await expect(pin).toBeVisible();
  await expect(pin).toHaveAttribute("data-marker", "dot");
  await expect.poll(async () => {
    const dot = await pin.locator("span").boundingBox();
    return dot !== null && dot.width >= 24 && dot.width <= 28;
  }).toBe(true);
  await page.getByRole("button", { name: "Закрыть создание прогулки" }).click();
  await expect(pin).not.toHaveClass(/explore-dot/);
});

test("прогулка из Александровского сада с четырьмя остановками открывается с треком", async ({ page }, info) => {
  const start = { address: "Александровский сад", location: { lat: 55.752, lon: 37.613 } };
  const stops = Array.from({ length: 4 }, (_, i) => ({ address: `Москва, остановка ${i + 1}`, location: { lat: 55.754 + i * 0.001, lon: 37.61 } }));
  const draft = { version: 1, title: "Из Александровского сада", start, mode: "loop", minutes: 60, stops, route: { stops, geometry: [start.location, ...stops.map(stop => stop.location), start.location], walkingMinutes: 30, distanceM: 2000, attribution: "OSM" }, jobs: [], submitting: null };
  await page.addInitScript(value => localStorage.setItem("otgolosok:walk:v1", JSON.stringify(value)), draft);
  await page.goto("/?walk=create&resume=1");
  await expect(page.locator(".leaflet-route-pane path[data-route]")).toBeVisible();
  await page.getByRole("button", { name: "Открыть прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: draft.title, exact: true })).toBeVisible();
  await expect(page.getByText("Некорректные данные прогулки.", { exact: true })).toHaveCount(0);
  const map = page.locator('[data-region="map"]');
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".leaflet-route-pane path[data-route]")).toBeVisible();
  const overlay = map.locator(".leaflet-route-pane svg");
  await expect.poll(() => overlay.evaluate(el => Math.abs(el.getBoundingClientRect().width - Number(el.getAttribute("width"))))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("alexander-garden-track.png") });
});

for (const [walkingMinutes, note] of [[18, true], [52, false]] as const) test(`прогулка по времени ${note ? "честно сообщает о нехватке мест" : "без пометки, если время заполнено"}`, async ({ page }, info) => {
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const stops = [{ address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.6 } }, { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } }];
  await page.route("**/api/story-place?*", route => route.fulfill({ json: start }));
  await page.route("**/api/walk-plan", async route => {
    const request = route.request().postDataJSON();
    expect(request).toMatchObject({ minutes: 60, mode: "loop" });
    expect(request).not.toHaveProperty("stops");
    expect(request).not.toHaveProperty("destination");
    await route.fulfill({ json: { stops, geometry: [start.location, ...stops.map(stop => stop.location), start.location], walkingMinutes, distanceM: walkingMinutes * 80, attribution: "OSM" } });
  });
  await page.goto("/");
  await page.getByRole("link", { name: "Прогулка", exact: true }).click();
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: false }).click();
  await page.getByRole("textbox", { name: "Откуда", exact: true }).fill(start.address);
  await page.getByRole("textbox").press("Enter");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени" }).click();
  await page.getByRole("button", { name: "60 мин" }).click();
  await page.getByRole("button", { name: "Построить прогулку" }).click();
  // The walk page keeps the builder's notes: the shortfall and the stops still without a story.
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  const shortfall = page.getByText(`Рядом нашлось мест только на ${walkingMinutes} мин из 60.`, { exact: false });
  await expect(shortfall).toHaveCount(note ? 1 : 0);
  await expect(page.getByText(`У ${stops.length} остановок пока нет истории.`, { exact: true })).toBeVisible();
  await expect(page.locator('.leaflet-marker-pane [data-marker="pin"]')).toHaveText(stops.map((_, i) => String(i + 1)));
  await page.screenshot({ path: info.outputPath("time-walk.png") });
  // In the builder a loop shows one ring at the start; stop numbers match the stop list.
  await page.getByRole("link", { name: "Изменить маршрут", exact: true }).click();
  await expect(page.getByText(`Остановки · ${stops.length}`, { exact: true })).toBeVisible();
  await expect(page.locator('.leaflet-marker-pane [data-marker="endpoint"]')).toHaveCount(1);
  await expect(page.locator('.leaflet-marker-pane [data-marker="pin"]')).toHaveText(stops.map((_, i) => String(i + 1)));
  await page.screenshot({ path: info.outputPath("time-builder.png") });
});

test("старт вне пешеходной сети объясняет, что выбрать, без предложения исследования", async ({ page }) => {
  const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
  const message = "Сюда не дойти пешком. Выберите начало на улице рядом.";
  await page.route("**/api/story-place?*", route => route.fulfill({ json: start }));
  await page.route("**/api/walk-plan", route => route.fulfill({ status: 404, json: { error: { code: "WALK_START_UNREACHABLE", message } } }));
  await page.goto("/");
  await page.getByRole("link", { name: "Прогулка", exact: true }).click();
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Ввести адрес", exact: false }).click();
  await page.getByRole("textbox", { name: "Откуда", exact: true }).fill(start.address);
  await page.getByRole("textbox").press("Enter");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени" }).click();
  await page.getByRole("button", { name: "30 мин" }).click();
  await page.getByRole("button", { name: "Построить прогулку" }).click();
  await expect(page.getByText(message, { exact: true })).toBeVisible();
  await expect(page.getByText("Рядом пока недостаточно готовых остановок", { exact: false })).toHaveCount(0);
});

for (const [width, height] of [[390, 844], [1280, 800], [1440, 900]]) {
  test(`выбранная на карте точка не прячется под панелью ${width}×${height}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    const place = { address: "Москва, Павелецкая площадь, 1А", location: { lat: 55.729754, lon: 37.639359 } };
    await page.route("**/api/story-place?*", route => route.fulfill({ json: place }));
    await page.goto("/?walk=create");
    await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
    const panel = page.locator('[data-sheet="creation"]');
    const before = (await panel.boundingBox())!;
    // Точка вне панели и навигации: слева сверху от центра карты.
    await page.mouse.click(Math.max(24, before.x - 40), before.y > 200 ? 160 : before.y + before.height + 40);
    await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(place.address);
    // Leaflet пересоздаёт отметки при обновлении слоя: меряем всё в одном кадре.
    const layout = () => page.evaluate(address => {
      const box = (element: Element | null) => element ? element.getBoundingClientRect().toJSON() as { x: number; y: number; width: number; height: number } : null;
      return { marker: box(document.querySelector(`.leaflet-marker-icon[title="Старт: ${address}"]`)), panel: box(document.querySelector('[data-sheet="creation"]')), nav: box(document.querySelector('nav[aria-label="Основная навигация"]')) };
    }, place.address);
    const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
    await expect.poll(async () => {
      const { marker, panel: covered, nav } = await layout();
      if (!marker || !covered || !nav) return "нет элементов";
      if (overlaps(marker, covered)) return "под панелью";
      if (overlaps(marker, nav)) return "под навигацией";
      return marker.x >= 0 && marker.y >= 0 && marker.x + marker.width <= width ? "видна" : "за краем";
    }).toBe("видна");
  });
}

// Chromium отдаёт эмулированную позицию сразу; точность задаёт, будет ли поиск рядом.
// Неточная точка не улучшается, поэтому итог приходит после окна уточнения (6 с).
for (const [accuracy, expected] of [[20, "В радиусе 200 м"], [150, "В радиусе 200 м"], [280, "В радиусе 300 м"], [800, "Положение приблизительное: точность около 800 м"]] as const) {
  test(`кнопка «Моё местоположение» при точности ${accuracy} м`, async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 55.7249, longitude: 37.6507, accuracy });
    await page.goto("/");
    await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
    await page.getByRole("button", { name: "Моё местоположение", exact: true }).click();
    await expect(page.getByText(expected)).toBeVisible({ timeout: 10_000 });
  });
}

test("кнопка «Моё местоположение» объясняет запрет геолокации", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("Загружаем карту…")).toHaveCount(0);
  await page.getByRole("button", { name: "Моё местоположение", exact: true }).click();
  await expect(page.getByText("Нет доступа к геолокации. Можно разрешить его в настройках или выбрать место на карте.")).toBeVisible();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1280, height: 800 }]) {
  test(`шапка карты в одну строку с кнопками карты на ${viewport.width}×${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockMapCatalog(page, []);
    await page.goto("/");
    const header = page.locator('[data-region="header"]');
    await expect(header.getByRole("link")).toContainText("Отголосок");
    await expect(page.getByRole("button", { name: "Найти адрес" })).toHaveCount(0);
    const head = (await header.boundingBox())!;
    for (const name of ["Моё местоположение", "Отдалить", "Приблизить"]) {
      const control = (await page.getByRole("button", { name, exact: true }).boundingBox())!;
      expect(Math.abs(control.y - head.y), name).toBeLessThanOrEqual(1);
      expect(Math.abs(control.height - head.height), name).toBeLessThanOrEqual(1);
      expect(control.x, `${name} правее шапки`).toBeGreaterThanOrEqual(head.x + head.width);
    }
    const link = (await header.getByRole("link").boundingBox())!;
    expect(head.width - link.width, "остров шапки по ширине логотипа").toBeLessThanOrEqual(34);
    const mark = header.locator(".brand-mark");
    expect(await mark.evaluate(element => element.scrollWidth <= element.parentElement!.clientWidth), "логотип не обрезан").toBe(true);
  });
}
