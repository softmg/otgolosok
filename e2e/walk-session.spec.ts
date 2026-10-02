import { expect, test, type Page } from "./support/test";
import { draftToWalkDocument, routeToWalkView } from "../src/features/walks/adapters";
import routeData from "../public/data/routes/paveletskaya.json" with { type: "json" };
import type { Route } from "../src/features/tour/types";
import editorialPhotos from "../backend/place-images-editorial.json" with { type: "json" };

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stops = [3, 5].map((n, i) => ({ address: `Москва, Арбат, ${n}`, location: { lat: 55.751 + i * .001, lon: 37.601 } }));

async function setup(page: import("@playwright/test").Page, empty = false) {
  const selected = empty ? [] : stops;
  const document = draftToWalkDocument({ version: 1, title: "Арбат", start, destination: stops[1], mode: "open", minutes: 30,
    stops: selected, route: { stops: selected, geometry: [start.location, ...stops.map(s => s.location)], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.goto(`/walk?local=${id}`);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 568, height: 400 }]) {
  test(`карта остаётся при старте и смене остановки ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await expect(page.getByRole("heading", { name: "Арбат", exact: true })).toBeVisible();
    const map = page.locator(".walk-session-map");
    await expect(map.locator(".leaflet-overlay-pane path[data-route]")).toBeVisible();
    await expect(page.locator(".hero, .debug-panel, .walk-plan")).toHaveCount(0);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    await expect(map).toBeVisible();
    await expect(page.getByText("История ещё готовится", { exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Предыдущая остановка" }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    const boxes = await page.locator(".walk-session-panel").evaluate(el => {
      const panel = el.getBoundingClientRect();
      const nav = document.querySelector('[data-region="nav"]')!.getBoundingClientRect();
      return { top: panel.top, bottom: panel.bottom, navTop: nav.top, right: panel.right, width: innerWidth };
    });
    expect(boxes.top).toBeGreaterThanOrEqual(0);
    expect(boxes.bottom).toBeLessThanOrEqual(boxes.navTop);
    expect(boxes.right).toBeLessThanOrEqual(boxes.width);
    await page.screenshot({ path: info.outputPath("walk-session.png") });
    await page.getByRole("button", { name: "Дальше", exact: true }).click();
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
    await expect(map).toBeVisible();
  });
}

test("прогулка по ссылке открывается на первой остановке, а не на всём маршруте", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  // Остановки в паре километров друг от друга: весь маршрут вписался бы мельче, и первая остановка ушла бы от центра.
  const far = [{ address: "Москва, Арбат, 3", location: { lat: 55.752, lon: 37.598 } }, { address: "Москва, Маросейка, 2", location: { lat: 55.758, lon: 37.635 } }];
  const document = draftToWalkDocument({ version: 1, title: "Через центр", start, destination: far[1], mode: "open", minutes: 60,
    stops: far, route: { stops: far, geometry: [start.location, ...far.map(s => s.location)], distanceM: 2600, walkingMinutes: 35, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.goto(`/walk?local=${id}`);
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  await expect.poll(() => firstStopIsVisible(page)).toBe(true);
  // Старт и финиш — кольца на концах линии, а не истории с номерами.
  await expect(page.locator('.walk-session-map [data-marker="endpoint"]')).toHaveCount(2);
  const pins = page.locator('.walk-session-map [data-marker="pin"]');
  const centerX = (index: number) => pins.nth(index).evaluate(pin => { const box = pin.getBoundingClientRect(); return box.left + box.width / 2; });
  // Свободная часть карты на телефоне симметрична по горизонтали: первая остановка в её середине.
  await expect.poll(() => centerX(0)).toBeCloseTo(195, -1);
  // Вторая остановка в двух километрах — за краем окна: карта приближена к первой, а не показывает весь маршрут.
  const second = await centerX(1);
  expect(second < 0 || second > 390).toBe(true);
});

test("маршрут без историй можно пройти и завершить на карте", async ({ page }) => {
  await setup(page, true);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toHaveCount(0);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
});

test("аудио, текст и список остановок открываются внутри панели", async ({ page }, info) => {
  const view = routeToWalkView(routeData as Route);
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: view }));
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
  await page.getByRole("button", { name: "Читать историю" }).click();
  await expect(page.locator(".walk-session-drawer .story-text")).toBeVisible();
  await page.getByRole("button", { name: "Читать историю" }).click();
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByLabel("Переключение остановок").selectOption("manual");
  await page.getByLabel("Скорость аудио").selectOption("1.25");
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByRole("button", { name: /Остановки ·/ }).click();
  await page.locator(".walk-session-stops button").nth(1).click();
  await expect(page.getByRole("heading", { name: "Название с оврагом внутри", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).playbackRate)).toBe(1.25);
  await page.screenshot({ path: info.outputPath("audio-session.png") });
  await page.getByRole("link", { name: "Закрыть прогулку" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".walk-session")).toHaveCount(0);
});

test("крестик в карточке прерывает прогулку только после подтверждения", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByRole("button", { name: "Прервать прогулку" })).toHaveCount(0);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();

  const stop = page.getByRole("button", { name: "Прервать прогулку" });
  const dialog = page.getByRole("dialog", { name: "Прервать прогулку?" });
  await stop.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Продолжить" })).toBeFocused();
  await dialog.getByRole("button", { name: "Продолжить" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();

  await stop.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();

  await stop.click();
  await dialog.getByRole("button", { name: "Прервать", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("heading", { name: "Арбат", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Начать прогулку|Продолжить прогулку/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Прервать прогулку" })).toHaveCount(0);
  await expect(page).toHaveURL(/\/walk\?local=/);
});

test("поиск в шапке прогулки открывает поиск адреса на карте", async ({ page }) => {
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.goto("/walk?catalog=paveletskaya");
  await expect(page.getByRole("link", { name: "Отголосок, на главную" })).toBeVisible();
  await page.getByRole("link", { name: "Найти адрес", exact: true }).click();
  await expect(page.getByLabel("Какой дом вас интересует?")).toBeFocused();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".walk-session")).toHaveCount(0);
});

test("отказ аудио не блокирует переход к следующей остановке", async ({ page }) => {
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.route("**/audio/**", route => route.abort());
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить запуск звука", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Дальше", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Название с оврагом внутри", exact: true })).toBeVisible();
});

test("геопозиция отличается от остановок и не дублирует маркер при обновлении", async ({ page, context }) => {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude: 55.7505, longitude: 37.6005, accuracy: 12 });
  await setup(page);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  const position = page.locator('[data-marker="user"]');
  await expect(position).toBeVisible();
  await expect(position.locator("span")).toHaveCSS("background-color", "rgb(36, 107, 144)");
  await expect(page.locator(".leaflet-control-scale")).toHaveCount(0);
  await context.setGeolocation({ latitude: 55.7508, longitude: 37.6008, accuracy: 18 });
  await expect(position).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Моё местоположение", exact: true })).toBeVisible();
});

test("гостевая прогулка показывает опубликованную историю остановки", async ({ page }) => {
  const document = draftToWalkDocument({ version: 1, title: "Моя прогулка", start, destination: null, mode: "loop", minutes: 30,
    stops: [{ ...stops[0], contentId: "osm:way:3" }], route: { stops, geometry: [start.location, stops[0].location, start.location], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  const requests: unknown[] = [];
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/story-walks/resolve", route => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { document, revision: 0, contentVersion: "e".repeat(64), chapters: [{ id: document.stops[0].id, status: "text_ready",
      story: { title: "Дом с башенкой", address: stops[0].address, paragraphs: [{ text: "Опубликованный рассказ о доме.", factIds: [] }], sources: [], facts: [] }, audio: null }] } });
  });
  await page.goto(`/walk?local=${id}`);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: "Читать историю", exact: true }).click();
  await expect(page.getByText("Опубликованный рассказ о доме.", { exact: true })).toBeVisible();
  // В режиме разработки React дважды запускает эффект; каждый запрос несёт тот же документ.
  expect(requests.length).toBeGreaterThan(0);
  for (const request of requests) expect(request).toEqual({ document, revision: 0 });
});

// Остановка у места из каталога с редакционным фото: сервер подставил его рассказ.
const photoPlace = "osm:way:35814561";
const editorial = editorialPhotos[photoPlace];
const placePhoto = { thumbnail: editorial.thumbnail, src: editorial.src, width: editorial.width, height: editorial.height, alt: editorial.alt,
  author: editorial.author, sourceUrl: editorial.sourceUrl, license: editorial.license, licenseUrl: editorial.licenseUrl };

async function openPhotoStop(page: Page, photo: typeof placePhoto | null = placePhoto) {
  const document = draftToWalkDocument({ version: 1, title: "К кинотеатру", start, destination: null, mode: "loop", minutes: 30,
    stops: [{ ...stops[0], contentId: photoPlace }], route: { stops, geometry: [start.location, stops[0].location, start.location], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/story-walks/resolve", route => route.fulfill({ json: { document, revision: 0, contentVersion: "f".repeat(64), chapters: [{ id: document.stops[0].id, status: "text_ready",
    story: { title: "Кинотеатр «Художественный»", address: stops[0].address, paragraphs: [{ text: "Рассказ о кинотеатре.", factIds: [] }], sources: [], facts: [] }, audio: null }] } }));
  await page.route(`**/api/content/places/${photoPlace}`, route => route.fulfill({ json: { place: { id: photoPlace,
    text: { story: { paragraphs: [{ text: "Рассказ о кинотеатре." }] }, audio: null }, ...(photo ? { photo } : {}) } } }));
  await page.goto(`/walk?local=${id}`);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Кинотеатр «Художественный»", exact: true })).toBeVisible();
}

test("остановка у места из каталога показывает его фото, как карточка места", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openPhotoStop(page);
  const trigger = page.getByRole("button", { name: "Открыть фото: Кинотеатр «Художественный»" });
  await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", placePhoto.width);
  // Фото во всю ширину панели над заголовком остановки.
  expect(await trigger.evaluate(button => {
    const photo = button.getBoundingClientRect(), panel = button.closest(".walk-session-panel")!.getBoundingClientRect();
    const heading = document.getElementById("walk-session-title")!.getBoundingClientRect();
    return Math.abs(photo.top - panel.top) <= 2 && panel.width - photo.width <= 3 && photo.bottom <= heading.top;
  })).toBe(true);
  await trigger.click();
  const viewer = page.getByRole("dialog", { name: "Кинотеатр «Художественный»", exact: true });
  await expect(viewer).toContainText(`Фото: ${editorial.author}.`);
  await page.keyboard.press("Escape");
  await expect(viewer).not.toBeVisible();
  await expect(trigger).toBeFocused();
  // Открытый текст забирает место у фото, как у плеера; закрытый возвращает его.
  await page.getByRole("button", { name: "Читать историю", exact: true }).click();
  await expect(page.getByText("Рассказ о кинотеатре.", { exact: true })).toBeVisible();
  await expect(trigger).toHaveCount(0);
  await page.getByRole("button", { name: "Читать историю", exact: true }).click();
  await expect(trigger).toBeVisible();
});

test("остановка у места без фото не оставляет пустого места в панели", async ({ page }) => {
  await openPhotoStop(page, null);
  await expect(page.getByText("Без истории", { exact: true })).toHaveCount(0);
  await expect(page.locator(".walk-session-photo [data-photo-banner]")).toHaveCount(0);
  await expect(page.locator(".walk-session-photo")).toBeHidden();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
  test(`фото остановки, заголовок и «Завершить» помещаются в экран ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openPhotoStop(page);
    const trigger = page.getByRole("button", { name: "Открыть фото: Кинотеатр «Художественный»" });
    await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", placePhoto.width);
    await expect(trigger).toBeInViewport();
    // На низком экране фото уступает высоту первым, но остаётся удобной целью для пальца.
    expect(await trigger.evaluate(button => button.parentElement!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await expect(page.locator("#walk-session-title")).toBeInViewport();
    await expect(page.getByRole("button", { name: "Завершить", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("walk-photo.png") });
  });
}

// Одна остановка с длинной историей и аудио: панель прогулки становится самой высокой.
const catalog = routeData as Route;
const longStop = routeToWalkView({ ...catalog, walk: { ...catalog.walk!, steps: catalog.walk!.steps.slice(-1) } });
const mapControls = { "крестик": ".walk-session-back", "поиск": ".walk-session-search", "плюс": ".leaflet-control-zoom-in", "минус": ".leaflet-control-zoom-out",
  "геопозиция": ".walk-session-locate", "подпись OSM": ".map-attribution" };

// Кнопка свободна, если она целиком в окне, на неё не заходят панель и навигация, а в её центре — она сама.
function controlsState(page: Page) {
  return page.evaluate(controls => {
    const covers = { "панель": ".walk-session-panel", "навигация": '[data-region="nav"]' };
    return Object.fromEntries(Object.entries(controls).flatMap(([name, selector]) => {
      const control = document.querySelector(selector);
      if (!control) return [];
      const box = control.getBoundingClientRect();
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) return [[name, "за краем окна"]];
      for (const [cover, coverSelector] of Object.entries(covers)) {
        const other = document.querySelector(coverSelector)!.getBoundingClientRect();
        if (box.left < other.right && box.right > other.left && box.top < other.bottom && box.bottom > other.top) return [[name, `под: ${cover}`]];
      }
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return [[name, hit && control.contains(hit) ? "свободна" : `в центре: ${hit?.closest("[class]")?.getAttribute("class")}`]];
    }));
  }, mapControls);
}

// Отступы элемента от краёв окна.
function edges(page: Page, selector: string) {
  return page.locator(selector).first().evaluate(element => {
    const box = element.getBoundingClientRect();
    return { top: Math.round(box.top), left: Math.round(box.left), right: Math.round(innerWidth - box.right), bottom: Math.round(innerHeight - box.bottom) };
  });
}

// Прогулка открывается на первой остановке: её метка в видимой части карты, а не под шапкой, панелью, навигацией или за краем окна.
function firstStopIsVisible(page: Page) {
  return page.evaluate(() => {
    const pin = document.querySelector('.walk-session-map [data-marker="pin"][title^="Остановка 1:"]');
    if (!pin) return false;
    const stop = pin.getBoundingClientRect();
    const inside = stop.left >= 0 && stop.top >= 0 && stop.right <= innerWidth && stop.bottom <= innerHeight;
    return inside && [".walk-session-header", ".walk-session-panel", '[data-region="nav"]'].every(selector => {
      const other = document.querySelector(selector)!.getBoundingClientRect();
      return stop.right <= other.left || stop.left >= other.right || stop.bottom <= other.top || stop.top >= other.bottom;
    });
  });
}

// Проверка в трёх состояниях панели: маршрут до старта, остановка с плеером и открытый текст истории.
async function checkPanelStates(page: Page, check: (state: string) => Promise<void>) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 55.7232, longitude: 37.653, accuracy: 12 });
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: longStop }));
  await page.goto("/walk?catalog=paveletskaya");
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  await expect(page.locator(".walk-session-map .leaflet-control-zoom")).toBeAttached();
  await check("до старта");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Моё местоположение", exact: true })).toBeVisible();
  await check("после старта");
  await page.getByRole("button", { name: "Читать историю", exact: true }).click();
  await expect(page.locator(".walk-session-drawer .story-text")).toBeVisible();
  await check("с текстом истории");
}

// Кнопки карты свободны, а первая остановка видна.
async function expectMapUsable(page: Page, state: string) {
  const controls = await controlsState(page);
  expect(Object.keys(controls), state).toEqual(expect.arrayContaining(["крестик", "поиск", "плюс", "минус", "подпись OSM"]));
  expect(controls, state).toEqual(Object.fromEntries(Object.keys(controls).map(name => [name, "свободна"])));
  await expect.poll(() => firstStopIsVisible(page), { message: `первая остановка видна: ${state}` }).toBe(true);
}

// Панель над навигацией, шапка вверху, под ней на 12 px ниже — кнопки масштаба и геопозиции справа и подпись OSM слева.
async function expectBottomPanel(page: Page, panel: { left: number; right: number; bottom: number }, header: { top: number; left: number; right: number }) {
  const controlsTop = header.top + 62 + 12;
  await checkPanelStates(page, async state => {
    await expectMapUsable(page, state);
    expect(await edges(page, ".walk-session-panel"), state).toMatchObject(panel);
    expect(await edges(page, ".walk-session-header"), state).toMatchObject(header);
    expect(await edges(page, ".leaflet-control-zoom"), state).toMatchObject({ top: controlsTop, right: 22 });
    expect(await edges(page, ".map-attribution"), state).toMatchObject({ top: controlsTop, left: 12 });
    const panelTop = await page.locator(".walk-session-panel").evaluate(element => element.getBoundingClientRect().top);
    expect(panelTop, `панель ниже шапки: ${state}`).toBeGreaterThanOrEqual(controlsTop);
  });
  expect(await edges(page, ".walk-session-locate")).toMatchObject({ top: controlsTop + 84, right: 18 });
}

test.describe("панель прогулки на телефоне", () => {
  // Сенсорный экран: на горизонтальном телефоне навигация тогда островок во всю ширину окна.
  test.use({ hasTouch: true, isMobile: true });

  // Во всю ширину (уже 700 px) панель поднималась до 20 px от верха и закрывала крестик и кнопки масштаба,
  // а по центру (шире) карта вписывала маршрут над панелью, где места не было, и линия пропадала.
  // Теперь панель — колонкой справа, как карточка на стартовой карте, а кнопки карты — в левой колонке.
  for (const [width, height] of [[667, 375], [568, 320], [844, 390]]) {
    test(`не закрывает кнопки карты и маршрут на горизонтальном телефоне ${width}×${height}`, async ({ page }, info) => {
      await page.setViewportSize({ width, height });
      await checkPanelStates(page, async state => {
        await expectMapUsable(page, state);
        const panel = await edges(page, ".walk-session-panel");
        const navigation = await edges(page, '[data-region="nav"]');
        expect(panel.right, state).toBe(12);
        const header = await edges(page, ".walk-session-header");
        expect(header, state).toMatchObject({ top: 12, left: 12 });
        expect(width - header.right + 12, `шапка левее панели: ${state}`).toBeLessThanOrEqual(panel.left);
        expect(panel.top, state).toBeGreaterThanOrEqual(12);
        expect(panel.bottom, state).toBeGreaterThanOrEqual(height - navigation.top);
      });
      await page.screenshot({ path: info.outputPath("walk-landscape.png") });
    });
  }

  test("сохраняет раскладку на вертикальном телефоне 390×844", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectBottomPanel(page, { left: 12, right: 12, bottom: 104 }, { top: 12, left: 12, right: 12 });
  });
});

test("панель прогулки сохраняет раскладку на компьютере 1440×900", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await expectBottomPanel(page, { left: 510, right: 510, bottom: 108 }, { top: 18, left: 340, right: 340 });
});

test.describe("отзывы к каталожной прогулке", () => {
  const oneStop = routeToWalkView({ ...catalog, walk: { ...catalog.walk!, steps: catalog.walk!.steps.slice(0, 1) } });
  const page0 = { summary: { average: 4.6, count: 12 }, reviews: [{ id: "r1", author: "Анна", rating: 5, text: "Очень понравилось.\nВернусь ещё.", createdAt: "2026-09-30T10:00:00Z" }], nextCursor: null, mine: null };

  async function openWithReviews(page: Page) {
    const writes: Array<{ method: string; body: unknown; key: string | null }> = [];
    await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
    await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: oneStop }));
    await page.route("**/api/story-walks/paveletskaya/reviews**", async route => {
      const request = route.request();
      if (request.method() === "GET") { await route.fulfill({ json: page0 }); return; }
      writes.push({ method: request.method(), body: request.postDataJSON(), key: await request.headerValue("x-review-key") });
      await route.fulfill({ json: { summary: page0.summary, mine: { rating: 4, text: "Отличный маршрут", status: "pending", updatedAt: "2026-10-01T10:00:00Z" } } });
    });
    await page.goto("/walk?catalog=paveletskaya");
    return writes;
  }

  test("итог в описании, отзыв после завершения уходит на модерацию", async ({ page }) => {
    const writes = await openWithReviews(page);
    await expect(page.locator(".walk-session-meta")).toContainText("★ 4,6 · 12 оценок");
    await page.getByRole("button", { name: "Отзывы", exact: true }).click();
    await expect(page.getByText("Очень понравилось.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Оставить отзыв" }), "отзыв можно оставить и до старта прогулки").toBeVisible();
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
    await page.getByRole("button", { name: "Оставить отзыв" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog, "форма открывается отдельным окном").toHaveAccessibleName("Оцените прогулку");
    await expect(page.locator(".walk-session-panel form"), "в панели прогулки формы нет").toHaveCount(0);
    await dialog.getByLabel("4 звезды из 5").check();
    await dialog.getByLabel("Отзыв (необязательно)").fill("Отличный маршрут");
    await dialog.getByRole("button", { name: "Отправить отзыв" }).click();
    await expect(dialog.getByRole("status")).toHaveText("Спасибо! Отзыв появится после проверки редакцией.");
    await expect(dialog.getByRole("button", { name: "Закрыть" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: /Сохранить изменения|Удалить отзыв/ })).toHaveCount(0);
    await expect(dialog, "окно закрывается само через несколько секунд").toBeHidden({ timeout: 6_000 });
    await expect(page.getByRole("button", { name: "Изменить отзыв" }), "после отправки финальная кнопка предлагает изменить отзыв").toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: "PUT", body: { rating: 4, text: "Отличный маршрут" } });
    expect(writes[0].key).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  for (const [width, height] of [[390, 844], [320, 568], [568, 400]] as const) {
    test(`окно отзыва помещается на экране ${width}×${height} и закрывается по Escape`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await openWithReviews(page);
      await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
      await page.getByRole("button", { name: "Завершить", exact: true }).click();
      const rate = page.getByRole("button", { name: "Оставить отзыв" });
      await expect(rate).toBeInViewport({ ratio: 1 });
      await expect(page.getByRole("link", { name: "На карту" })).toBeInViewport({ ratio: 1 });
      await rate.click();
      const dialog = page.getByRole("dialog", { name: "Оцените прогулку" });
      const box = await dialog.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y + box!.height).toBeLessThanOrEqual(height);
      await expect(dialog.getByRole("button", { name: "Закрыть" })).toBeInViewport({ ratio: 1 });
      await dialog.getByRole("button", { name: "Отправить отзыв" }).scrollIntoViewIfNeeded();
      await expect(dialog.getByRole("button", { name: "Отправить отзыв" })).toBeInViewport({ ratio: 1 });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(rate, "фокус возвращается к кнопке").toBeFocused();
    });
  }
});

test("у гостевой прогулки нет отзывов", async ({ page }) => {
  await setup(page);
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Отзывы", exact: true })).toHaveCount(0);
});
