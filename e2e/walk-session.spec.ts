import { expect, test, type Page } from "./support/test";
import { draftToWalkDocument, routeToWalkView, walkViewToRoute } from "../src/features/walks/adapters";
import routeData from "../public/data/routes/paveletskaya.json" with { type: "json" };
import type { Route } from "../src/features/tour/types";
import editorialPhotos from "../backend/place-images-editorial.json" with { type: "json" };

const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stops = [3, 5].map((n, i) => ({ address: `Москва, Арбат, ${n}`, location: { lat: 55.751 + i * .001, lon: 37.601 } }));

// Старт по дороге к остановке разблокирует звук прямо в клике тихим клипом data: на 0,15 с,
// поэтому сразу после старта одно «paused» мигает. Запись истории никогда не бывает data:.
const storyPlaying = (page: Page) => page.locator("audio").evaluate(el => {
  const audio = el as HTMLAudioElement;
  return Boolean(audio.currentSrc) && !audio.paused && !audio.currentSrc.startsWith("data:");
});

test("прогулка с конца меняет остановки и финиш, запоминает направление после перезагрузки", async ({ page }) => {
  await setup(page);
  const direction = page.getByRole("button", { name: "Пройти прогулку с конца" });
  await direction.click();
  await expect(direction).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Остановки · 2" }).click();
  await expect(page.locator(".walk-session-stops li").first()).toContainText(stops[1].address);
  await expect(page.locator(".walk-session-endpoint").first()).toHaveText(`Старт: ${stops[1].address}`);
  await expect(page.locator(".walk-session-endpoint").last()).toHaveText(`Финиш: ${start.address}`);
  await page.reload();
  await expect(direction).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(direction).toHaveCount(0);
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Предыдущая остановка" }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await page.getByRole("button", { name: "К финишу", exact: true }).click();
  await expect(page.getByRole("heading", { name: start.address, exact: true })).toBeVisible();
  await expect(page.locator('[data-route-part="active"]')).toHaveCount(1);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
});

test("прогресс двух направлений независим и обратная прогулка продолжается после перезагрузки", async ({ page }) => {
  const view = routeToWalkView(routeData as Route);
  const route = walkViewToRoute(view);
  const chapter = route.walk!.steps.at(-2)!;
  const forward = route.walk!.steps[0];
  const checkpoint = (step: typeof chapter) => ({ version: 1, routeId: route.id, chapterId: step.id, audioUrl: step.audio!.url, positionSec: 0 });
  await page.addInitScript(({ routeId, forward }) => {
    const key = `otgolosok:playback:${routeId}`;
    if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify(forward));
  }, { routeId: route.id, forward: checkpoint(forward) });
  await page.route("**/api/story-walks/paveletskaya/view", request => request.fulfill({ json: view }));
  await page.goto("/walk?catalog=paveletskaya");
  await expect(page.getByRole("button", { name: "Продолжить прогулку", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Пройти прогулку с конца" }).click();
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await expect(page.getByRole("heading", { name: chapter.title, exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Пройти прогулку с конца" })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Продолжить прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: chapter.title, exact: true })).toBeVisible();
  const saved = await page.evaluate(routeId => ({
    forward: JSON.parse(localStorage.getItem(`otgolosok:playback:${routeId}`)!),
    reverse: JSON.parse(localStorage.getItem(`otgolosok:playback:${routeId}:reverse`)!),
  }), route.id);
  expect(saved.forward).toEqual(checkpoint(forward));
  expect(saved.reverse).toEqual(checkpoint(chapter));
});

async function setup(page: import("@playwright/test").Page, empty = false, destination = stops[1]) {
  const selected = empty ? [] : stops;
  const geometry = [start.location, ...stops.map(s => s.location), ...(destination === stops[1] ? [] : [destination.location])];
  const document = draftToWalkDocument({ version: 1, title: "Арбат", start, destination, mode: "open", minutes: 30,
    stops: selected, route: { stops: selected, geometry, distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
  await page.goto(`/walk?local=${id}`);
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 900 }, { width: 568, height: 400 }]) {
  test(`карта остаётся при старте и смене остановки ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await setup(page);
    await expect(page.getByRole("heading", { name: "Арбат", exact: true })).toBeVisible();
    const map = page.locator('[data-region="map"]');
    await expect(map.locator(".leaflet-route-pane path[data-route]")).toBeVisible();
    await expect(page.locator(".hero, .debug-panel, .walk-plan")).toHaveCount(0);
    const navigation = page.getByRole("navigation", { name: "Основная навигация" });
    await expect(navigation).toBeVisible();
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    await expect(page.locator(".walk-session-tools button").first()).toHaveText("Остановка 1 из 2");
    await expect(page.locator(".walk-session-meta")).toHaveCount(0);
    await expect(map).toBeVisible();
    // Идущая прогулка занимает весь экран: нижней навигации нет до остановки или завершения.
    await expect(navigation).toHaveCount(0);
    await expect(page.getByText("История ещё готовится", { exact: true })).toHaveCount(0);
    // Участок от старта до первой остановки — в своём слое со стрелками, остальной маршрут приглушён.
    await expect(map.locator('[data-route-part="active"]')).toHaveCount(1);
    await expect(map.locator("[data-route-arrow]").first()).toBeAttached();
    await expect.poll(() => map.locator(".leaflet-route-pane").evaluate(pane => getComputedStyle(pane).opacity)).toBe("0.3");
    await expect.poll(() => markerIsFree(page, '[data-marker="endpoint"]'), { message: "старт виден" }).toBe(true);
    await expect.poll(() => markerIsFree(page, '[data-marker="pin"][title^="Остановка 1:"]'), { message: "первая остановка видна" }).toBe(true);
    await page.screenshot({ path: info.outputPath("walk-approach.png") });
    await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
    await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Предыдущая остановка" }).click();
    await expect(page.getByRole("heading", { name: stops[0].address, exact: true })).toBeVisible();
    const boxes = await page.locator(".walk-session-panel").evaluate(el => {
      const panel = el.getBoundingClientRect();
      return { top: panel.top, bottom: Math.round(innerHeight - panel.bottom), right: panel.right, width: innerWidth };
    });
    expect(boxes.top).toBeGreaterThanOrEqual(0);
    // Без навигации панель стоит у низа окна на том же поле, что у боковых краёв (MapShell).
    expect(boxes.bottom).toBe(12);
    expect(boxes.right).toBeLessThanOrEqual(boxes.width);
    await page.screenshot({ path: info.outputPath("walk-session.png") });
    await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
    await page.getByRole("button", { name: "Завершить", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
    await expect(map).toBeVisible();
    await expect(navigation, "после завершения навигация возвращается").toBeVisible();
  });
}

test("прогулка по ссылке до старта показывает старт, первую остановку и путь к ней, а не весь маршрут", async ({ page }) => {
  await page.setViewportSize({ width: 393, height: 852 });
  // Первая остановка в 800 м от старта: на одной точке в крупном плане старт уходит за край.
  const far = [
    { address: "Москва, Петровка, 20", location: { lat: 55.757, lon: 37.604 } },
    { address: "Москва, Солянка, 1", location: { lat: 55.765, lon: 37.68 } }
  ];
  const destination = { address: "Москва, Яузская улица, 1", location: { lat: 55.7685, lon: 37.689 } };
  const document = draftToWalkDocument({
    version: 1, title: "Через центр", start, destination,
    mode: "open", minutes: 60, stops: far,
    route: { stops: far, geometry: [start.location, { lat: 55.7535, lon: 37.6005 }, ...far.map(s => s.location), destination.location], distanceM: 7000, walkingMinutes: 90, attribution: "OSM" },
    jobs: [], submitting: null
  }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
  await page.goto(`/walk?local=${id}`);
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  const opening = async (state: string, later: string) => {
    await expect.poll(() => markerIsFree(page, '[data-marker="endpoint"][title^="Старт:"]'), { message: `старт виден: ${state}` }).toBe(true);
    await expect.poll(() => firstStopIsVisible(page), { message: `первая остановка видна: ${state}` }).toBe(true);
    // Дальние остановки не уменьшают карту до обзора всего маршрута.
    const second = await page.locator(`[data-region="map"] [data-marker="pin"][title="Остановка 2: ${later}"]`).evaluate(pin => {
      const box = pin.getBoundingClientRect();
      return box.left + box.width / 2;
    });
    expect(second < 0 || second > 393, `вторая остановка за краем: ${state}`).toBe(true);
  };
  await opening("вперёд", far[1].address);
  // Прогулка с конца открывается на своём первом отрезке: от Яузской к Солянке.
  await page.getByRole("button", { name: "Пройти прогулку с конца" }).click();
  await expect(page.locator('[data-region="map"] [data-marker="endpoint"][title^="Старт:"]')).toHaveAttribute("title", `Старт: ${destination.address}`);
  await opening("с конца", far[0].address);
});

test("маршрут без историй можно пройти и завершить на карте", async ({ page }) => {
  await setup(page, true);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toHaveCount(0);
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
});

test("после последней остановки прогулка ведёт к финишу и только там завершается", async ({ page }) => {
  // Финиш в двух сотнях метров за последней остановкой.
  const finish = { address: "Москва, Арбат, 9", location: { lat: 55.754, lon: 37.601 } };
  await setup(page, false, finish);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Завершить", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "К финишу", exact: true }).click();
  await expect(page.getByRole("heading", { name: finish.address, exact: true })).toBeVisible();
  await expect(page.locator(".walk-session-meta")).toHaveText("До финиша");
  // Подсвечен участок от последней остановки до финиша.
  await expect(page.locator('[data-region="map"] [data-route-part="active"]')).toHaveCount(1);
  // Назад — к последней остановке, прогулка ещё идёт.
  await page.getByRole("button", { name: "Предыдущая остановка" }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();
  await page.getByRole("button", { name: "К финишу", exact: true }).click();
  await page.getByRole("button", { name: "Завершить", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Прогулка завершена" })).toBeVisible();
});

test("аудио, текст и список остановок открываются внутри панели", async ({ page }, info) => {
  const view = routeToWalkView(routeData as Route);
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: view }));
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("region", { name: "Плеер истории" })).toBeVisible();
  // По дороге к остановке ничего не играет. Первая остановка — у самого старта: идти до неё нечего, участок не подсвечен.
  await expect(page.locator(".walk-session-tools button").first()).toHaveText("Остановка 1 из 4");
  await expect(page.locator(".walk-session-meta")).toHaveCount(0);
  expect(await storyPlaying(page)).toBe(false);
  const activeLeg = page.locator('[data-region="map"] [data-route-part="active"]');
  await expect(activeLeg).toHaveCount(0);
  // «Слушать историю» — это «я на месте»: история играет, подсвечен уже участок к следующей остановке.
  await page.getByRole("button", { name: "Слушать историю", exact: true }).click();
  await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
  await expect(activeLeg).toHaveCount(1);
  const secondLeg = await activeLeg.getAttribute("d");
  await page.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
  const readStory = page.getByRole("button", { name: "Читать историю", exact: true });
  await expect(readStory.locator("svg")).toHaveAttribute("aria-hidden", "true");
  await expect(readStory.locator("span")).toHaveCSS("text-decoration-line", "underline");
  await expect(readStory).toHaveAttribute("aria-expanded", "false");
  await readStory.click();
  await expect(page.locator(".walk-session-drawer .story-text")).toBeVisible();
  await expect(readStory).toHaveAttribute("aria-expanded", "true");
  // Ящик занимает место плеера, но звуком по-прежнему управляет мини-плеер в закреплённом футере.
  const miniPlayer = page.locator(".walk-session-actions").getByRole("region", { name: "Плеер истории" });
  await expect(miniPlayer).toBeVisible();
  await miniPlayer.getByRole("button", { name: "Продолжить", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(false);
  await miniPlayer.getByRole("button", { name: "Пауза", exact: true }).click();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
  await readStory.click();
  await expect(page.locator(".walk-session-drawer .story-text")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Плеер истории" })).toHaveCount(1);
  await expect(miniPlayer).toHaveCount(0);
  await expect(readStory.locator("span")).toHaveCSS("text-decoration-line", "underline");
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByLabel("Переключение остановок").selectOption("manual");
  await page.getByLabel("Скорость аудио").selectOption("1.25");
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await page.getByRole("button", { name: /^Остановка \d+ из/ }).click();
  await page.locator(".walk-session-stops button").nth(1).click();
  await expect(page.getByRole("heading", { name: "Название с оврагом внутри", exact: true })).toBeVisible();
  await expect(page.locator(".walk-session-tools button").first()).toHaveText("Остановка 2 из 4");
  await page.getByRole("button", { name: "Слушать историю", exact: true }).click();
  await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).playbackRate)).toBe(1.25);
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await expect(page.locator(".walk-session-tools button").first()).toHaveText("Остановка 3 из 4");
  await expect(page.getByRole("button", { name: "Слушать историю", exact: true })).toBeVisible();
  await expect.poll(() => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused)).toBe(true);
  await expect.poll(() => activeLeg.getAttribute("d"), { message: "подсвечен участок к третьей остановке" }).not.toBe(secondLeg);
  await page.screenshot({ path: info.outputPath("audio-session.png") });
  await page.getByRole("button", { name: "Прервать прогулку" }).click();
  await page.getByRole("dialog", { name: "Прервать прогулку?" }).getByRole("button", { name: "Прервать", exact: true }).click();
  // В шапке крестика нет: прогулку закрывает крестик в карточке.
  await expect(page.locator('[data-region="header"]').getByRole("link", { name: "Закрыть прогулку" })).toHaveCount(0);
  await page.locator(".walk-session-panel").getByRole("link", { name: "Закрыть прогулку" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".walk-session")).toHaveCount(0);
  // Закрытая во время прогулки страница не оставляет стартовую карту без навигации.
  await expect(page.getByRole("navigation", { name: "Основная навигация" })).toBeVisible();
});

test.describe("свёрнутая карточка на телефоне", () => {
  test.use({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });

  test("свайп по ручке вниз оставляет плеер и открывает карту, вверх возвращает карточку", async ({ page }, info) => {
    await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
    await page.goto("/walk?catalog=paveletskaya");
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    const panel = page.locator(".walk-session-panel");
    // На сенсорном экране сворачивает ручка, шеврон для мыши спрятан.
    await expect(page.locator(".walk-session-fold")).toBeHidden();
    const grip = page.getByRole("button", { name: "Свернуть карточку" });
    await expect(grip).toBeVisible();
    const open = (await panel.boundingBox())!;
    // A real finger: touch events through the DevTools protocol, which the browser turns into pointer events.
    const cdp = await page.context().newCDPSession(page);
    const swipe = async (dy: number) => {
      const box = (await page.locator(".walk-session-handle button").boundingBox())!;
      const x = box.x + box.width / 2, y = box.y + box.height / 2;
      await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
      for (let step = 1; step <= 4; step++) await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x, y: y + dy * step / 4 }] });
      await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    // Without the photo the grip's touch area stays above the title.
    const clearOfTitle = async () => {
      const grip = (await page.locator(".walk-session-handle button").boundingBox())!;
      const title = (await page.locator("#walk-session-title").boundingBox())!;
      expect(grip.y + grip.height).toBeLessThanOrEqual(title.y + 1);
    };
    await swipe(80);
    await expect(panel).toHaveAttribute("data-folded", "");
    await expect(page.locator(".walk-session-actions").getByRole("region", { name: "Плеер истории" })).toBeVisible();
    await expect(page.getByRole("button", { name: /^Дальше(:|$)/ })).toBeVisible();
    await expect(page.locator(".walk-session-tools, .walk-session-photo")).toHaveCount(0);
    await clearOfTitle();
    const folded = (await panel.boundingBox())!;
    expect(folded.height).toBeLessThan(open.height / 2);
    expect(folded.y + folded.height).toBeCloseTo(open.y + open.height, 0);
    await page.screenshot({ path: info.outputPath("walk-folded-phone.png") });
    // Свёрнутой карточка остаётся и на следующей остановке.
    await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
    await expect(panel).toHaveAttribute("data-folded", "");
    await swipe(-80);
    await expect(panel).not.toHaveAttribute("data-folded", "");
    await expect(page.locator(".walk-session-tools")).toBeVisible();
    // A swipe ends with a click on the grip; it must not toggle the card back.
    await page.waitForTimeout(300);
    await expect(panel).not.toHaveAttribute("data-folded", "");
    await page.getByRole("button", { name: "Настройки прогулки" }).click();
    await expect(page.locator(".walk-session-photo")).toHaveCount(0);
    await clearOfTitle();
  });
});

test("на компьютере карточку прогулки сворачивает и разворачивает шеврон рядом с крестиком", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.locator(".walk-session-handle")).toBeHidden();
  const panel = page.locator(".walk-session-panel");
  const open = (await panel.boundingBox())!;
  await page.getByRole("button", { name: "Свернуть карточку" }).click();
  await expect(panel).toHaveAttribute("data-folded", "");
  await expect(page.locator(".walk-session-actions").getByRole("region", { name: "Плеер истории" })).toBeVisible();
  expect((await panel.boundingBox())!.height).toBeLessThan(open.height * .6);
  await page.screenshot({ path: info.outputPath("walk-folded-desktop.png") });
  const expand = page.getByRole("button", { name: "Развернуть карточку" });
  await expect(expand).toBeFocused();
  await expand.click();
  await expect(panel).not.toHaveAttribute("data-folded", "");
  await expect(page.getByRole("button", { name: "Свернуть карточку" })).toBeFocused();
});

test("с клавиатуры фокус не прячется под мини-плеером в закреплённом футере", async ({ page }) => {
  // На низком горизонтальном экране мини-плеер заметно поднимает футер: прокрутка к фокусу должна это учитывать.
  await page.setViewportSize({ width: 568, height: 320 });
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: "Настройки прогулки" }).click();
  await expect(page.locator(".walk-session-actions").getByRole("region", { name: "Плеер истории" })).toBeVisible();
  await page.locator("#walk-session-title").focus();
  const covered: string[] = [];
  for (let step = 0; step < 12; step++) {
    await page.keyboard.press("Tab");
    const hidden = await page.evaluate(() => new Promise<string | null>(resolve => requestAnimationFrame(() => {
      const focused = document.activeElement as HTMLElement | null;
      const footer = document.querySelector(".walk-session-actions")!;
      if (!focused?.closest(".walk-session-panel") || footer.contains(focused)) return resolve(null);
      resolve(focused.getBoundingClientRect().bottom > footer.getBoundingClientRect().top ? focused.getAttribute("aria-label") ?? focused.textContent ?? "" : null);
    })));
    if (hidden !== null) covered.push(hidden);
  }
  expect(covered).toEqual([]);
});

test("крестик в карточке прерывает прогулку только после подтверждения", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await expect(page.getByRole("button", { name: "Прервать прогулку" })).toHaveCount(0);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
  await expect(page.getByRole("heading", { name: stops[1].address, exact: true })).toBeVisible();

  const stop = page.getByRole("button", { name: "Прервать прогулку" });
  const dialog = page.getByRole("dialog", { name: "Прервать прогулку?" });
  await stop.click();
  await expect(dialog).toBeVisible();
  // Кнопки подтверждения того же размера, что «Дальше» под ним: не крупнее основного действия прогулки.
  const shape = (button: import("@playwright/test").Locator) => button.evaluate(el => ({ height: Math.round(el.getBoundingClientRect().height), font: getComputedStyle(el).fontSize }));
  const next = await shape(page.locator(".walk-session-primary"));
  expect(await shape(dialog.getByRole("button", { name: "Продолжить" }))).toEqual(next);
  expect(await shape(dialog.getByRole("button", { name: "Прервать", exact: true }))).toEqual(next);
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
  await expect(page.getByRole("navigation", { name: "Основная навигация" }), "после остановки навигация возвращается").toBeVisible();
});

test("отказ аудио не блокирует переход к следующей остановке", async ({ page }) => {
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.route("**/audio/**", route => route.abort());
  await page.goto("/walk?catalog=paveletskaya");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await page.getByRole("button", { name: "Слушать историю", exact: true }).click();
  await expect(page.getByRole("button", { name: "Повторить запуск звука", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^Дальше(:|$)/ }).click();
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
  await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
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
const placeWithoutPhoto = "osm:node:999999999";
const editorial = editorialPhotos[photoPlace];
const placePhoto = { thumbnail: editorial.thumbnail, src: editorial.src, width: editorial.width, height: editorial.height, alt: editorial.alt,
  author: editorial.author, sourceUrl: editorial.sourceUrl, license: editorial.license, licenseUrl: editorial.licenseUrl };

/** `story`: the stop tells the place's published story; `place`: the stop only names the catalog place, as with a test placeholder. */
async function openPhotoStop(page: Page, photo: typeof placePhoto | null = placePhoto, link: "story" | "place" = "story", place = photoPlace) {
  const document = draftToWalkDocument({ version: 1, title: "К кинотеатру", start, destination: null, mode: "loop", minutes: 30,
    stops: [{ ...stops[0], ...(link === "story" ? { contentId: place } : {}), placeId: place }], route: { stops, geometry: [start.location, stops[0].location, start.location], distanceM: 400, walkingMinutes: 6, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
  await page.route("**/api/story-walks/resolve", route => route.fulfill({ json: { document, revision: 0, contentVersion: "f".repeat(64), chapters: [{ id: document.stops[0].id, status: "text_ready",
    story: { title: "Кинотеатр «Художественный»", address: stops[0].address, paragraphs: [{ text: "Рассказ о кинотеатре.", factIds: [] }], sources: [], facts: [] }, audio: null }] } }));
  await page.route(`**/api/content/places/${place}`, route => route.fulfill({ json: { place: { id: place,
    text: { story: { paragraphs: [{ text: "Рассказ о кинотеатре." }] }, audio: null }, ...(photo ? { photo } : {}) } } }));
  await page.goto(`/walk?local=${id}`);
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("heading", { name: link === "story" ? "Кинотеатр «Художественный»" : stops[0].address, exact: true })).toBeVisible();
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

test("остановка у места из каталога без рассказа всё равно показывает его фото", async ({ page }) => {
  await openPhotoStop(page, placePhoto, "place");
  const trigger = page.getByRole("button", { name: `Открыть фото: ${stops[0].address}` });
  await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", placePhoto.width);
});

test("остановка у места без фото не оставляет пустого места в панели", async ({ page }) => {
  // У кинотеатра есть редакционное фото (place-images-editorial.json): нужно место совсем без снимков.
  await openPhotoStop(page, null, "story", placeWithoutPhoto);
  await expect(page.getByText("Без истории", { exact: true })).toHaveCount(0);
  await expect(page.locator(".walk-session-photo [data-photo-banner]")).toHaveCount(0);
  await expect(page.locator(".walk-session-photo")).toBeHidden();
});

for (const viewport of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1440, height: 900 }]) {
  test(`фото остановки, заголовок и «К финишу» помещаются в экран ${viewport.width}×${viewport.height}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await openPhotoStop(page);
    const trigger = page.getByRole("button", { name: "Открыть фото: Кинотеатр «Художественный»" });
    await expect(trigger.locator("img")).toHaveJSProperty("naturalWidth", placePhoto.width);
    await expect(trigger).toBeInViewport();
    // На низком экране фото уступает высоту первым, но остаётся удобной целью для пальца.
    expect(await trigger.evaluate(button => button.parentElement!.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
    await expect(page.locator("#walk-session-title")).toBeInViewport();
    // Кольцевая прогулка после единственной остановки ведёт обратно к старту.
    await expect(page.getByRole("button", { name: "К финишу", exact: true })).toBeInViewport();
    await page.screenshot({ path: info.outputPath("walk-photo.png") });
  });
}

// Одна остановка с длинной историей и аудио: панель прогулки становится самой высокой.
const catalog = routeData as Route;
const longStop = routeToWalkView({ ...catalog, walk: { ...catalog.walk!, steps: catalog.walk!.steps.slice(-1) } });
// Кнопок масштаба на карте больше нет (45ce739): масштаб меняется жестами и колесом.
const mapControls = { "геопозиция": 'button[aria-label="Моё местоположение"]', "подпись OSM": '[data-region="attribution"]' };

// Кнопка свободна, если она целиком в окне, на неё не заходят панель и навигация (до старта), а в её центре — она сама.
function controlsState(page: Page) {
  return page.evaluate(controls => {
    const covers = { "панель": ".walk-session-panel", "навигация": '[data-region="nav"]' };
    // The Next.js dev indicator is not part of the app and sits over the bottom-left corner.
    for (const portal of document.querySelectorAll<HTMLElement>("nextjs-portal")) portal.style.display = "none";
    return Object.fromEntries(Object.entries(controls).flatMap(([name, selector]) => {
      const control = document.querySelector(selector);
      if (!control) return [];
      const box = control.getBoundingClientRect();
      if (box.left < 0 || box.top < 0 || box.right > innerWidth || box.bottom > innerHeight) return [[name, "за краем окна"]];
      for (const [cover, coverSelector] of Object.entries(covers)) {
        const other = document.querySelector(coverSelector)?.getBoundingClientRect();
        if (!other) continue;
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
  return markerIsFree(page, '[data-marker="pin"][title^="Остановка 1:"]');
}

// Метка карты в свободной её части: целиком в окне и не под шапкой, панелью или навигацией (до старта).
function markerIsFree(page: Page, selector: string) {
  return page.evaluate(selector => {
    const pin = document.querySelector(`[data-region="map"] ${selector}`);
    if (!pin) return false;
    const stop = pin.getBoundingClientRect();
    const inside = stop.left >= 0 && stop.top >= 0 && stop.right <= innerWidth && stop.bottom <= innerHeight;
    return inside && ['[data-region="header"]', ".walk-session-panel", '[data-region="nav"]'].every(selector => {
      const other = document.querySelector(selector)?.getBoundingClientRect();
      if (!other) return true;
      return stop.right <= other.left || stop.left >= other.right || stop.bottom <= other.top || stop.top >= other.bottom;
    });
  }, selector);
}

// Проверка в трёх состояниях панели: маршрут до старта, остановка с плеером и открытый текст истории.
async function checkPanelStates(page: Page, check: (state: string) => Promise<void>) {
  await page.context().grantPermissions(["geolocation"]);
  await page.context().setGeolocation({ latitude: 55.7232, longitude: 37.653, accuracy: 12 });
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: longStop }));
  await page.goto("/walk?catalog=paveletskaya");
  await expect(page.getByRole("button", { name: "Начать прогулку", exact: true })).toBeVisible();
  await expect(page.locator('[data-region="attribution"]')).toBeVisible();
  await check("до старта");
  await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  await expect(page.getByRole("button", { name: "Моё местоположение", exact: true })).toBeVisible();
  await check("после старта");
  await page.getByRole("button", { name: "Читать историю", exact: true }).click();
  await expect(page.locator(".walk-session-drawer .story-text")).toBeVisible();
  await check("с текстом истории");
}

// Экран прогулки стоит в общей рамке карт (MapShell): та же шапка с логотипом и кнопками карты,
// что на стартовой карте, кнопки свободны, первая остановка видна. До старта панель над навигацией,
// во время прогулки навигации нет и панель стоит у низа окна на поле 12 px.
for (const [width, height] of [[390, 844], [320, 568], [667, 375], [568, 320], [844, 390], [1440, 900]]) {
  test(`прогулка в общей рамке карт на ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await checkPanelStates(page, async state => {
      const controls = await controlsState(page);
      expect(Object.keys(controls), state).toEqual(expect.arrayContaining(["подпись OSM"]));
      expect(controls, state).toEqual(Object.fromEntries(Object.keys(controls).map(name => [name, "свободна"])));
      // На 320×568 карточка с плеером оставляет карте меньше наименьшей рамки вписывания (MIN_BOX в map-view.ts),
      // и метка может зайти под карточку — как на стартовой карте; на остальных экранах она видна.
      if (height > 568) await expect.poll(() => firstStopIsVisible(page), { message: `первая остановка видна: ${state}` }).toBe(true);
      await expect(page.locator('[data-region="header"]').getByRole("link", { name: "Отголосок, на главную" }), state).toBeVisible();
      // Кнопки карты, когда они есть (геопозиция появляется с первой точкой), не заходят на шапку.
      const mapButtons = page.locator('[data-region="controls"]');
      if (await mapButtons.count()) {
        const header = (await page.locator('[data-region="header"]').boundingBox())!;
        const buttons = (await mapButtons.boundingBox())!;
        const sameRow = Math.abs(buttons.y - header.y) <= 1;
        expect(sameRow ? buttons.x >= header.x + header.width : buttons.y >= header.y + header.height + 7, `кнопки карты не перекрывают шапку: ${state}`).toBe(true);
      }
      const panel = await edges(page, ".walk-session-panel");
      const nav = page.locator('[data-region="nav"]');
      if (state === "до старта") {
        const navigation = await edges(page, '[data-region="nav"]');
        expect(panel.bottom, `панель над навигацией: ${state}`).toBeGreaterThanOrEqual(height - navigation.top);
      } else {
        await expect(nav, state).toHaveCount(0);
        expect(panel.bottom, state).toBe(12);
      }
    });
    await page.screenshot({ path: info.outputPath(`walk-${width}x${height}.png`) });
  });
}

// Панель прогулки прокручивается только в крайнем случае (низкий телефон в альбомной ориентации). На обычном
// настольном окне с фото, плеером и всеми инструментами она помещается целиком: боковой полосы прокрутки нет.
for (const [width, height] of [[1280, 720], [1366, 768], [1440, 900], [1280, 640], [1440, 600], [1280, 520]]) {
  test(`остановка с фото и плеером помещается в панель без прокрутки на ${width}×${height}`, async ({ page }, info) => {
    await page.setViewportSize({ width, height });
    await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
    await page.route("**/api/content/places/**", route => route.fulfill({ json: { place: { id: photoPlace,
      text: { story: { paragraphs: [{ text: "Рассказ о месте." }] }, audio: null }, photo: placePhoto } } }));
    // Остановка каталожной прогулки у места с фото: так выглядит любая промопрогулка, у каждой остановки есть превью.
    // Название в три строки, как у «Церкви святых апостолов Петра и Павла в Лефортове» на снимке из отчёта.
    const withPhoto = { ...longStop, document: { ...longStop.document, stops: longStop.document.stops.map(stop => ({ ...stop, placeId: photoPlace })) },
      chapters: longStop.chapters.map(chapter => ({ ...chapter, story: chapter.story && { ...chapter.story, title: "Церковь святых апостолов Петра и Павла в Лефортове" } })) };
    await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: withPhoto }));
    await page.goto("/walk?catalog=paveletskaya");
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await expect(page.locator(".walk-session-photo img")).toBeVisible();
    await expect(page.getByRole("button", { name: "Читать историю", exact: true })).toBeVisible();
    // Плашка загрузки карты занимает место над панелью только до готовности карты.
    await expect(page.getByText("Загружаем карту…", { exact: true })).toHaveCount(0, { timeout: 20000 });
    const panel = page.locator(".walk-session-panel");
    const overflow = await panel.evaluate(element => element.scrollHeight - element.clientHeight);
    await page.screenshot({ path: info.outputPath(`walk-photo-${width}x${height}.png`) });
    expect(overflow, "панель не прокручивается").toBeLessThanOrEqual(0);
    // Ни один инструмент не уходит под закреплённые кнопки.
    const tools = await page.locator(".walk-session-tools").boundingBox(), actions = await page.locator(".walk-session-actions").boundingBox();
    expect(tools!.y + tools!.height).toBeLessThanOrEqual(actions!.y);
    // Панель уже трёх инструментов в ряд: «Настройки» остаются иконкой, и инструменты не уходят во вторую строку.
    await expect(page.locator(".walk-session-settings-label")).toBeHidden();
    const rows = await page.locator(".walk-session-tools > *").evaluateAll(items => new Set(items.map(item => Math.round(item.getBoundingClientRect().top))).size);
    expect(rows, "инструменты в одну строку").toBe(1);
  });
}

test.describe("отзывы к каталожной прогулке", () => {
  const oneStop = routeToWalkView({ ...catalog, walk: { ...catalog.walk!, steps: catalog.walk!.steps.slice(0, 1) } });
  const page0 = { summary: { average: 4.6, count: 12 }, reviews: [{ id: "r1", author: "Анна", rating: 5, text: "Очень понравилось.\nВернусь ещё.", createdAt: "2026-09-30T10:00:00Z" }], nextCursor: null, mine: null };

  async function openWithReviews(page: Page) {
    const writes: Array<{ method: string; body: unknown; key: string | null }> = [];
    await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
    await page.route("**/api/food/**", route => route.fulfill({ status: 503, json: { error: "FOOD_INDEX_UNAVAILABLE" } }));
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

test.describe("переключение остановок", () => {
  const view = routeToWalkView(routeData as Route);
  async function open(page: Page, advance: string, query = "") {
    await page.addInitScript(advance => localStorage.setItem("otgolosok:walk-settings", JSON.stringify({ advance, rate: 1 })), advance);
    await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: view }));
    await page.goto(`/walk?catalog=paveletskaya${query}`);
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
  }
  const paused = (page: Page) => page.locator("audio").evaluate(el => (el as HTMLAudioElement).paused);

  test("по месту в обратном направлении играет рассказ последней остановки", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("otgolosok:walk-settings", JSON.stringify({ advance: "place", rate: 1 })));
    await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: view }));
    await page.goto("/walk?catalog=paveletskaya&replay=walk&speed=20");
    await page.getByRole("button", { name: "Пройти прогулку с конца" }).click();
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    await expect.poll(() => storyPlaying(page), { timeout: 20_000 }).toBe(true);
    const chapter = walkViewToRoute(view).walk!.steps.at(-1)!;
    await expect(page.getByRole("heading", { name: chapter.title, exact: true })).toBeVisible();
    await expect(page.locator("audio")).toHaveAttribute("src", chapter.audio!.url);
    await expect(page.locator(".walk-session-meta")).toHaveCount(0);
  });

  test("по месту история начинается сама, когда идущий подходит к остановке", async ({ page }) => {
    await open(page, "place", "&replay=walk&speed=20");
    await expect(page.locator(".walk-session-meta")).toHaveText("Начнётся, когда подойдёте");
    expect(await storyPlaying(page)).toBe(false);
    await expect(page.locator(".walk-session-meta")).toHaveCount(0, { timeout: 20_000 });
    await expect.poll(() => paused(page)).toBe(false);
  });

  test("подряд история играет сразу, без дороги к остановке", async ({ page }) => {
    await open(page, "sequence");
    await expect(page.locator(".walk-session-tools button").first()).toHaveText("Остановка 1 из 4");
    await expect(page.locator(".walk-session-meta")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Пауза", exact: true })).toBeVisible();
    await expect.poll(() => storyPlaying(page)).toBe(true);
  });
});

test("крытый участок маршрута нарисован пунктиром", async ({ page }) => {
  // В каталожном маршруте у Павелецкой — переход [29, 30].
  await page.route("**/api/story-walks/paveletskaya/view", route => route.fulfill({ json: routeToWalkView(routeData as Route) }));
  await page.goto("/walk?catalog=paveletskaya");
  const covered = page.locator('[data-region="map"] path[data-route-covered]');
  await expect(covered).toHaveCount(1);
  expect(await covered.evaluate(path => getComputedStyle(path).strokeDasharray)).toMatch(/\d/);
  // До старта весь маршрут одинаково полупрозрачный, без подсветки.
  await expect(page.locator('[data-region="map"] [data-route-part="active"]')).toHaveCount(0);
  await expect.poll(() => page.locator('[data-region="map"] .leaflet-route-pane').evaluate(pane => getComputedStyle(pane).opacity)).toBe("0.8");
});
