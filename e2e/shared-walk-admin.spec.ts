import { test, expect, type Page } from "./support/test";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createAccountStore } from "../backend/account-store.mjs";
import { createStore } from "../backend/store.mjs";
import { createApp } from "../backend/server.mjs";

/** The local server uses the real account store and routes with an isolated editor session for «Анна». */
function backend(outputDir: string) {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','Борис','boris@example.test')");
  let now = Date.UTC(2026, 8, 30);
  const accountStore = createAccountStore(db, () => now++), store = createStore(":memory:");
  const auth = { api: { getSession: async () => ({ user: { id: "anna", role: "editor", name: "Анна", email: "anna@example.test" }, session: { id: "test", createdAt: new Date() } }) } };
  const app = createApp({ store, accountStore, auth: auth as never, provider: null, origin: "http://localhost:3217", audioDirectory: outputDir, workerEnabled: false, allowLegacyAdminToken: false });
  return {
    db, accountStore,
    async listen(page: Page) {
      await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
      const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      await page.route("**/api/**", async route => {
        const url = new URL(route.request().url());
        const response = await route.fetch({ url: apiBase + url.pathname + url.search });
        await route.fulfill({ response });
      });
      return apiBase;
    },
    async close() { await app.close(); store.close(); db.close(); },
  };
}

test("редактор находит пользовательские прогулки, листает страницы и копирует рабочую ссылку", async ({ page, context }, testInfo) => {
  const { accountStore, listen, close } = backend(testInfo.outputDir);
  try {
    for (let index = 0; index < 27; index++) {
      const title = index === 26 ? "Арбат для Анны" : `Прогулка ${index}`;
      const owner = index === 26 ? "anna" : "boris";
      const walk = accountStore.createWalk(owner, { title, idempotencyKey: `browser-walk-${index}`, snapshot: { version: 1, title, start: null, stops: [], mode: index === 26 ? "open" : "loop", minutes: 30, route: null, jobs: [], submitting: null } });
      if (!walk) throw new Error("Не удалось создать тестовую прогулку");
      accountStore.setWalkVisibility(owner, walk.id, walk.revision, "shared");
    }
    const apiBase = await listen(page);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/admin?section=walks");
    await expect(page.getByRole("heading", { name: "Пользовательские прогулки" })).toBeVisible();
    await expect(page.getByText("Показано 1–25 из 27 прогулок.")).toBeVisible();
    await expect(page.getByText("anna@example.test", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Далее", exact: true }).click();
    await expect(page.getByText("Страница 2 из 2")).toBeVisible();
    await page.getByLabel("Название прогулки").fill("АРБАТ");
    await page.getByLabel("Автор", { exact: true }).fill("АННА");
    await page.getByLabel("Тип маршрута").selectOption("open");
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(page.getByText("Показано 1–1 из 1 прогулок.")).toBeVisible();
    await expect(page.getByText("Страница 1 из 1")).toBeVisible();
    await page.getByRole("button", { name: "Скопировать ссылку: Арбат для Анны", exact: true }).click();
    await expect(page.getByText("Ссылка на «Арбат для Анны» скопирована.")).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    const token = new URL(copied).searchParams.get("share");
    expect(token).toBeTruthy();
    const publicResponse = await page.request.get(`${apiBase}/api/story-walks/shared/${token}`);
    expect(publicResponse.status()).toBe(200);
    expect((await publicResponse.json()).document.title).toBe("Арбат для Анны");
    await page.getByLabel("Название прогулки").fill("Нет такой прогулки");
    await page.getByRole("button", { name: "Найти", exact: true }).click();
    await expect(page.getByText("По этим фильтрам прогулок нет.", { exact: false })).toBeVisible();
    await page.getByRole("button", { name: "Сбросить", exact: true }).click();
    await expect(page.getByText("Показано 1–25 из 27 прогулок.")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("shared-walks-mobile.png"), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: testInfo.outputPath("shared-walks-desktop.png"), fullPage: true });
    await page.getByRole("button", { name: "Редактор глав", exact: true }).click();
    await expect(page.getByText("Редактируйте главы и запускайте новую озвучку", { exact: false })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});

const point = (address: string, lat: number, lon: number) => ({ address, location: { lat, lon } });

test("публичная прогулка попадает в топ после одобрения, её запуск засчитывается, а скрытие убирает её из топа", async ({ page }, testInfo) => {
  const { db, accountStore, listen, close } = backend(testInfo.outputDir);
  try {
    const [start, stop, finish] = [point("Москва, Покровка, 1", 55.759, 37.642), point("Москва, Покровка, 10", 55.758, 37.645), point("Москва, Покровка, 20", 55.757, 37.648)];
    const snapshot = {
      version: 2, id: "11111111-1111-4111-8111-111111111111", title: "Покровка", description: "Дворы и арки", city: "Москва", mode: "open", minutes: 30, start, destination: finish,
      stops: [{ id: "11111111-1111-4111-8111-111111111112", place: stop, storyRef: null, transition: "Идём к арке", nextHint: "Ищите арку" }],
      route: { geometry: [start.location, stop.location, finish.location], distanceM: 600, walkingMinutes: 8, attribution: "OSM" }, fieldChecked: false,
    };
    // The author is Борис, so the editor «Анна» launching it is a counted viewer, not the owner.
    const walk = accountStore.createWalk("boris", { title: "Покровка", idempotencyKey: "browser-public-walk", snapshot });
    if (!walk) throw new Error("Не удалось создать тестовую прогулку");
    const token = accountStore.setWalkVisibility("boris", walk.id, walk.revision, "public")?.shareToken;
    expect(token).toBeTruthy();
    const apiBase = await listen(page);
    const topTitles = async () => ((await (await page.request.get(`${apiBase}/api/top-walks`)).json()).walks as Array<{ title: string }>).map(item => item.title);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));

    await page.goto("/admin?section=walks");
    await expect(page.getByRole("button", { name: "Пользовательские · 1", exact: true })).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Топ", exact: true })).toHaveValue("pending");
    await expect(page.getByRole("cell", { name: "Всем · на проверке", exact: true })).toBeVisible();
    expect(await topTitles()).not.toContain("Покровка");
    await page.getByRole("button", { name: "Одобрить для топа: Покровка", exact: true }).click();
    await expect(page.getByText("«Покровка» в топе.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Пользовательские", exact: true })).toBeVisible();
    expect(await topTitles()).toContain("Покровка");

    await page.goto("/history?tab=top");
    await expect(page.getByRole("tab", { name: "Топ прогулок", exact: true })).toHaveAttribute("aria-selected", "true");
    await page.getByRole("link", { name: "Покровка" }).click();
    await expect(page).toHaveURL(new RegExp(`/walk\\?share=${token}$`));
    const launch = page.waitForResponse(response => response.url().endsWith(`/api/story-walks/shared/${token}/launches`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Начать прогулку", exact: true }).click();
    expect(await (await launch).json()).toEqual({ counted: true });
    expect((db.prepare("SELECT SUM(launches) AS total FROM walk_launch_days WHERE walk_id = ?").get(walk.id) as { total: number }).total).toBe(1);

    await page.goto("/admin?section=walks");
    await page.getByRole("button", { name: "Скрыть из топа: Покровка", exact: true }).click();
    await expect(page.getByText("«Покровка» скрыта из топа. Ссылка продолжает работать.")).toBeVisible();
    expect(await topTitles()).not.toContain("Покровка");
    expect((await page.request.get(`${apiBase}/api/story-walks/shared/${token}`)).status()).toBe(200);
    expect(errors).toEqual([]);
  } finally {
    await close();
  }
});
