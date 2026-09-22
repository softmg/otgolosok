import { expect, test } from "@playwright/test";

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
    await expect(page.locator(".map-loading")).toHaveCount(0);
    await page.locator(".explore-map").click({ position: { x: 150, y: 200 } });
    await expect(page.locator(".creation-panel [role=alert]")).toBeVisible();
    await expect(page.locator(".creation-panel.is-picking")).toBeVisible();
    fail = false;
    await page.locator(".explore-map").click({ position: { x: 160, y: 210 } });
    await expect(page.locator(".creation-panel.is-picking")).toHaveCount(0);
    await expect(page.getByRole("button", { name: new RegExp(`^${endpoint}`) })).toContainText(place.address);
    await expect(page.getByRole("button", { name: "Выбрать эту точку" })).toHaveCount(0);
  });
}

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", route => route.fulfill({ json: { user: null, walks: [], nextCursor: null, items: [] } }));
});

test("знак одинакового размера на карте и странице входа", async ({ page }) => {
  const sizes: string[] = [];
  for (const path of ["/", "/login"]) {
    await page.goto(path);
    sizes.push(await page.locator(".brand-mark").first().evaluate(el => getComputedStyle(el).fontSize));
  }
  expect(sizes).toEqual(["28px", "28px"]);
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
  await expect(page.getByRole("heading", { name: "Ваш маршрут" })).toBeVisible();
  await expect(page.locator(".creation-stops:empty")).toHaveCount(0);
  await expect(page.getByText("Пешеходный маршрут построен. Исторических остановок по пути пока нет.")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Сохранить в аккаунте" })).toHaveCount(0);
  await expect(page.locator(".creation-panel [role=status]")).toHaveCount(0);
  await page.screenshot({ path: info.outputPath("preview.png") });
  await expect(page.getByRole("link", { name: "Начать прогулку", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Закрыть создание прогулки" }).click();
  await page.getByRole("link", { name: "История", exact: true }).click();
  await page.getByRole("link", { name: "Редактировать" }).click();
  await expect(page.getByRole("heading", { name: "Ваш маршрут" })).toBeVisible();
  await expect(page.locator(".creation-panel")).toContainText(destination.address);
  await page.getByRole("link", { name: "Начать прогулку", exact: true }).click();
  await expect(page.locator(".creation-panel")).toHaveCount(0);
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Открыть мою прогулку" })).toHaveCount(0);
  const frame = page.locator(".walk-session-map");
  await expect(frame).toBeVisible();
  const geometry = await frame.evaluate(el => {
    const frame = el.getBoundingClientRect();
    const map = el.querySelector(".explore-map-layer")!.getBoundingClientRect();
    return { height: frame.height, contained: map.top >= frame.top && map.bottom <= frame.bottom && map.left >= frame.left && map.right <= frame.right };
  });
  expect(geometry.height).toBeGreaterThan(200);
  expect(geometry.contained).toBe(true);
  const overlay = frame.locator(".leaflet-overlay-pane svg");
  await expect(overlay).toBeVisible();
  await expect.poll(() => overlay.evaluate(el => Math.abs(el.getBoundingClientRect().width - Number(el.getAttribute("width"))))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("walk-page.png") });
  expect(errors).toEqual([]);
});

test("дом передаёт старт, возврат включён по умолчанию, Back закрывает панель", async ({ page }) => {
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [{ id: "test-house", name: "Дом для прогулки", address: "Москва, Дербеневская, 1", location: { lat: 55.7249, lon: 37.6507 }, story: null, audio: null }] } }));
  await page.goto("/");
  await page.locator('[title="Дом для прогулки"]').click();
  await page.getByRole("link", { name: "Создать прогулку отсюда" }).click();
  await expect(page.locator(".creation-endpoints")).toContainText("Москва, Дербеневская, 1");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени" }).click();
  await expect(page.getByRole("checkbox", { name: "Вернуться к началу" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Вернуться к началу" }).uncheck();
  await page.goBack();
  await expect(page.locator(".creation-panel")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Изменить маршрут" }).click();
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
  await expect(page.locator(".creation-panel")).toHaveCount(0);
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
    await expect(page.locator(".creation-letter")).toHaveCount(0);
    const panel = await page.locator(".creation-panel").boundingBox();
    expect(panel!.height).toBeLessThanOrEqual(240);
    const nav = await page.getByRole("navigation", { name: "Основная навигация" }).boundingBox();
    expect(Math.abs(panel!.x + panel!.width / 2 - width / 2)).toBeLessThanOrEqual(1);
    const surface = await page.locator("body").evaluate(el => getComputedStyle(el).backgroundColor);
    for (const selector of [".creation-panel"]) {
      expect(await page.locator(selector).evaluate(el => getComputedStyle(el).backgroundColor)).toBe(surface);
    }
    expect(panel!.y + panel!.height).toBeLessThanOrEqual(nav!.y);
    for (const item of await page.getByRole("navigation").locator("a,button").all()) {
      const box = await item.boundingBox();
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
    }
    await expect(page.locator(".around-bottom")).toBeHidden();
    await page.screenshot({ path: info.outputPath("creation.png") });
  });
}

for (const width of [390, 1440]) {
  test(`список выбора расположен у активного поля ${width}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: 844 });
    await page.goto("/?walk=create");
    const start = page.getByRole("button", { name: "Откуда", exact: true });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("heading", { name: "Прогулка", exact: true })).toBeVisible();
    const startBox = await start.boundingBox();
    const menuBox = await page.locator("#creation-picker").boundingBox();
    const finishBox = await page.getByRole("button", { name: "Куда", exact: true }).boundingBox();
    expect(menuBox!.y).toBeGreaterThanOrEqual(startBox!.y + startBox!.height - 1);
    expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(finishBox!.y);
    expect((await page.locator(".creation-panel").boundingBox())!.height).toBeLessThan(430);
    expect(await start.evaluate(el => getComputedStyle(el).outlineOffset)).toBe("-3px");
    await page.screenshot({ path: info.outputPath("start-options.png") });
    await page.keyboard.press("Escape");
    await expect(page.locator("#creation-picker")).toHaveCount(0);
    await expect(start).toBeFocused();
  });
}

test("ручной адрес подтверждается кнопкой без каталога и сохраняется при ошибке", async ({ page }) => {
  let attempts = 0;
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [] } }));
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
  await expect(page.locator(".creation-panel").getByRole("alert")).toContainText("Уточните номер дома");
  await expect(input).toHaveValue("Дербеневская 3");
  await input.press("Enter");
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText("Москва, Дербеневская улица, 3");
  await expect(page.getByRole("button", { name: "Выбрать эту точку" })).toHaveCount(0);
  expect(attempts).toBe(2);
});

test("время имеет мягкий акцент, а Готово подтверждает выбор", async ({ page }) => {
  await page.goto("/?walk=create");
  await page.getByRole("button", { name: "Куда", exact: true }).click();
  await page.getByRole("button", { name: "По времени", exact: true }).click();
  const duration = page.getByRole("button", { name: "60 мин", exact: true });
  await duration.click();
  await expect(duration).toHaveAttribute("aria-pressed", "true");
  expect(await duration.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgba(32, 62, 56, 0.12)");
  const done = page.getByRole("button", { name: "Готово", exact: true });
  expect(await done.evaluate(el => getComputedStyle(el).backgroundColor)).toBe("rgb(32, 62, 56)");
  await done.click();
  await expect(page.locator("#creation-picker")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText("60 мин пешком");
});

test("карточка выбранного дома не оставляет пустую строку над адресом", async ({ page }, info) => {
  await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, 1-й Дербеневский переулок, 5", location: { lat: 55.725, lon: 37.65 } } }));
  await page.goto("/");
  await expect(page.locator(".map-loading")).toHaveCount(0);
  await page.locator(".explore-map").click({ position: { x: 180, y: 200 } });
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

test("подпись карты размером 11 пикселей без подчёркивания", async ({ page }) => {
  await page.goto("/");
  const attribution = page.getByRole("link", { name: "© OpenStreetMap", exact: true });
  await expect(attribution).toBeVisible();
  expect(await attribution.evaluate(el => ({ size: getComputedStyle(el).fontSize, decoration: getComputedStyle(el).textDecorationLine }))).toEqual({ size: "11px", decoration: "none" });
  await expect(attribution).toHaveAttribute("href", "https://www.openstreetmap.org/copyright");
});

for (const [width, height, expectedGap] of [[390, 844, 20], [1440, 900, 12], [568, 400, 20]]) {
  test(`карточка близко к навигации ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: "Москва, Дербеневская улица, 3", location: { lat: 55.725, lon: 37.65 } } }));
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Смотрите истории рядом с вами", exact: true })).toBeVisible();
    const card = await page.locator(".around-bottom").boundingBox();
    const nav = await page.getByRole("navigation", { name: "Основная навигация" }).boundingBox();
    expect(Math.abs(nav!.y - card!.y - card!.height - expectedGap)).toBeLessThanOrEqual(1);
  });
}

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
  await expect(page.locator(".creation-panel.is-picking")).toHaveCount(0);
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
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [{ id: "start-house", name: "Стартовый дом", address: start, location: { lat: 55.7249, lon: 37.6507 }, story: null, audio: null }] } }));
  await page.route("**/api/story-place?*", route => route.fulfill({ json: { address: finish, location: { lat: 55.75, lon: 37.6 } } }));
  await page.goto("/");
  await page.locator('[title="Стартовый дом"]').click();
  await page.getByRole("link", { name: "Создать прогулку отсюда" }).click();
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(start);
  await page.locator(".explore-map").click({ position: { x: 150, y: 200 } });
  await expect(page.getByRole("button", { name: "Куда", exact: true })).toContainText(finish);
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(start);
  await page.getByRole("button", { name: "Откуда", exact: true }).click();
  await page.getByRole("button", { name: "Выбрать на карте", exact: true }).click();
  await page.locator(".explore-map").click({ position: { x: 160, y: 210 } });
  await expect(page.getByRole("button", { name: "Откуда", exact: true })).toContainText(finish);
});

test("достопримечательности остаются компактными точками при создании прогулки", async ({ page }) => {
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [{ id: "landmark", name: "Тестовая достопримечательность", address: "Москва, Арбат, 10", location: { lat: 55.7249, lon: 37.6507 }, story: null, audio: null }] } }));
  await page.goto("/");
  const pin = page.locator('[title="Тестовая достопримечательность"]');
  await expect(pin).toBeVisible();
  await page.getByRole("link", { name: "Прогулка", exact: true }).click();
  await expect(pin).toBeVisible();
  await expect(pin).toHaveClass(/explore-dot/);
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
  await expect(page.locator(".leaflet-overlay-pane path")).toBeVisible();
  await page.getByRole("link", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Ваш маршрут", exact: true })).toBeVisible();
  await expect(page.getByText("Некорректные данные прогулки.", { exact: true })).toHaveCount(0);
  const map = page.locator(".walk-session-map");
  await map.scrollIntoViewIfNeeded();
  await expect(map.locator(".leaflet-overlay-pane path")).toBeVisible();
  const overlay = map.locator(".leaflet-overlay-pane svg");
  await expect.poll(() => overlay.evaluate(el => Math.abs(el.getBoundingClientRect().width - Number(el.getAttribute("width"))))).toBeLessThan(2);
  await page.screenshot({ path: info.outputPath("alexander-garden-track.png") });
});
