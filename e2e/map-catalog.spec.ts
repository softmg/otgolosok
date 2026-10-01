import { expect, test, type Page } from "./support/test";

const places = Array.from({ length: 1438 }, (_, index) => ({
  id: `osm:node:${index + 1}`, name: `Каталог: ${index + 1}`, address: "Москва",
  location: index === 1437 ? { lat: 55.7249, lon: 37.6507 } : { lat: 55.726, lon: 37.649 + (index % 50) * 0.000005 },
  story: { title: `Каталог: ${index + 1}`, paragraphs: [{ text: `Рассказ о месте ${index + 1}.` }] },
  audio: null,
}));

async function representedPlaces(page: Page) {
  return page.locator(".leaflet-marker-pane").evaluate(pane =>
    [...pane.querySelectorAll<HTMLElement>("[data-cluster-count]")].reduce((total, node) => total + Number(node.dataset.clusterCount), 0)
    + pane.querySelectorAll('[data-marker="pin"][title^="Каталог:"]').length);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("otgolosok:explore:geo-prompt-dismissed", "1"));
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
});

test("карта показывает все 1438 мест выбранной области и открывает последнюю карточку", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/content/places?*", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    return route.fulfill({ json: { places: places.slice(offset, offset + 100), total: places.length, hasMore: offset + 100 < places.length } });
  });
  await page.goto("/");
  await expect.poll(() => representedPlaces(page)).toBe(1438);
  expect(await page.locator(".leaflet-marker-icon").count()).toBeLessThan(30);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Текст истории", exact: true })).toContainText("Рассказ о месте 1438.");
  expect(errors).toEqual([]);
});

test("пустой каталог не добавляет пять встроенных точек", async ({ page }) => {
  await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: [], total: 0, hasMore: false } }));
  await page.goto("/");
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  await expect(page.getByRole("region", { name: /^Карта историй/ })).toBeVisible();
  await expect(page.locator(".leaflet-marker-icon")).toHaveCount(0);
});

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) for (const path of ["/", "/?walk=create"]) {
  test(`статус виден до первого ответа и до конца загрузки ${viewport.width}×${viewport.height} ${path}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    let firstPage!: () => void;
    let lastPage!: () => void;
    const first = new Promise<void>(resolve => { firstPage = resolve; });
    const last = new Promise<void>(resolve => { lastPage = resolve; });
    await page.route("**/api/content/places?*", async route => {
      const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
      await (offset === 0 ? first : last);
      await route.fulfill({ json: { places: places.slice(offset, Math.min(offset + 100, 101)), total: 101, hasMore: offset === 0 } });
    });
    try {
      await page.goto(path);
      const status = page.locator('[data-region="catalog-status"] [role="status"]');
      await expect(status).toHaveText("Загружаем места…");
      await expect(status).toBeInViewport();
      await expect(page.getByRole("progressbar", { name: "Загрузка мест на карте" })).not.toHaveAttribute("value");
      firstPage();
      await expect(status).toHaveText("Загружаем места: 100 из 101…");
      await expect(page.getByRole("progressbar")).toHaveAttribute("value", "100");
      await page.screenshot({ path: info.outputPath("catalog-loading.png") });
      lastPage();
      await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
      await expect.poll(() => representedPlaces(page)).toBe(101);
    } finally { firstPage(); lastPage(); }
  });
}

test("после сбоя второй страницы точки остаются, повтор догружает область", async ({ page }) => {
  let unavailable = true;
  const sample = places.slice(0, 101);
  await page.route("**/api/content/places?*", route => {
    const offset = Number(new URL(route.request().url()).searchParams.get("offset"));
    if (offset === 100 && unavailable) return route.fulfill({ status: 503, json: {} });
    return route.fulfill({ json: { places: sample.slice(offset, offset + 100), total: sample.length, hasMore: offset + 100 < sample.length } });
  });
  await page.goto("/");
  await expect(page.getByRole("status").filter({ hasText: "Не все места загрузились." })).toBeVisible();
  await expect.poll(() => representedPlaces(page)).toBe(100);
  unavailable = false;
  await page.getByRole("button", { name: "Повторить загрузку мест" }).click();
  await expect.poll(() => representedPlaces(page)).toBe(101);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
});

for (const coincident of [false, true]) {
  test(coincident ? "совпадающие места раскрываются веером и доступны по отдельности" : "группа раскрывается с клавиатуры и снова объединяется при отдалении", async ({ page }, info) => {
    const sample = places.slice(0, 2).map((place, index) => ({ ...place,
      location: { lat: 55.7249, lon: coincident ? 37.6507 : 37.6505 + index * 0.0004 },
    }));
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.route("**/api/content/places?*", route => route.fulfill({ json: { places: sample, total: 2, hasMore: false } }));
    await page.goto("/");
    const group = page.getByRole("button", { name: "Мест: 2. Нажмите, чтобы раскрыть группу" });
    await expect(group).toBeVisible();
    await expect(page.locator('[data-marker="pin"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("cluster.png") });
    await group.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator('[data-marker="pin"][title^="Каталог:"]')).toHaveCount(2);
    await expect(page.locator('[data-sheet="story"], [data-sheet="place"]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("expanded.png") });
    if (!coincident) {
      for (let i = 0; i < 3; i++) await page.getByRole("button", { name: "Отдалить", exact: true }).click();
      await expect(group).toBeVisible();
      await expect.poll(() => representedPlaces(page)).toBe(2);
      await group.click();
      await expect(page.locator('[data-marker="pin"][title^="Каталог:"]')).toHaveCount(2);
    }
    await page.getByTitle("Каталог: 2", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Каталог: 2", exact: true })).toBeVisible();
    await expect(page.getByTitle("Каталог: 2", { exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(errors).toEqual([]);
  });
}

for (const viewport of [{ width: 390, height: 844 }, { width: 1440, height: 1000 }]) {
  test(`первая загрузка ограничена двумя шагами масштаба, новые области догружаются ${viewport.width}`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    const requests: URL[] = [];
    let distant = places[1];
    const sample = [places[1437]];
    await page.route("**/api/content/places?*", route => {
      const url = new URL(route.request().url());
      requests.push(url);
      const west = Number(url.searchParams.get("west")), east = Number(url.searchParams.get("east"));
      const south = Number(url.searchParams.get("south")), north = Number(url.searchParams.get("north"));
      if (requests.length === 1) {
        distant = { ...places[1], location: { lat: 55.7249, lon: east + (east - west) * 0.15 } };
        sample.push(distant);
      }
      const local = sample.filter(place => place.location.lon >= west && place.location.lon <= east && place.location.lat >= south && place.location.lat <= north);
      return route.fulfill({ json: { places: local, total: local.length, hasMore: false } });
    });
    await page.goto("/");
    await expect(page.getByTitle("Каталог: 1438", { exact: true })).toBeVisible();
    await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
    expect(requests).toHaveLength(1);
    const bounds = requests[0].searchParams;
    const map = page.locator(".leaflet-container");
    const box = await map.boundingBox();
    const pixels = (Number(bounds.get("east")) - Number(bounds.get("west"))) / 360 * 256 * 2 ** 16;
    expect(pixels).toBeCloseTo(box!.width * 4, 2);
    expect(await page.getByTitle("Каталог: 2", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "Отдалить", exact: true }).click();
    await page.getByRole("button", { name: "Отдалить", exact: true }).click();
    await expect.poll(() => requests.length).toBe(2);
    await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
    const second = requests[1].searchParams;
    expect(Number(second.get("east"))).toBeGreaterThan(distant.location.lon);
    await page.getByRole("button", { name: "Отдалить", exact: true }).click();
    await expect(page.getByTitle("Каталог: 2", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    await page.getByRole("button", { name: "Приблизить", exact: true }).click();
    await expect(page.getByTitle("Каталог: 1438", { exact: true })).toBeVisible();
    await page.screenshot({ path: info.outputPath("viewport-catalog.png") });
    expect(requests).toHaveLength(2);
  });
}

test("перемещение догружает точки за исходной областью и сохраняет выбранную карточку", async ({ page }) => {
  const requests: URL[] = [];
  await page.route("**/api/content/places?*", route => {
    requests.push(new URL(route.request().url()));
    return route.fulfill({ json: { places: [places[1437]], total: 1, hasMore: false } });
  });
  await page.goto("/");
  await page.getByTitle("Каталог: 1438", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
  const map = page.locator(".leaflet-container");
  const box = (await map.boundingBox())!;
  for (let i = 0; i < 5; i++) {
    await page.mouse.move(box.x + box.width * 0.85, box.y + 180);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.15, box.y + 180, { steps: 15 });
    await page.mouse.up();
  }
  await expect.poll(() => requests.length).toBeGreaterThan(1);
  await expect(page.locator('[data-region="catalog-status"]')).toHaveCount(0);
  expect(Number(requests.at(-1)!.searchParams.get("east"))).toBeGreaterThan(Number(requests[0].searchParams.get("east")));
  await expect(page.getByRole("heading", { name: "Каталог: 1438", exact: true })).toBeVisible();
});
