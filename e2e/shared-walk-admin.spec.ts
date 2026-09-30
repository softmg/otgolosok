import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import type { AddressInfo } from "node:net";
import { createAccountStore } from "../backend/account-store.mjs";
import { createStore } from "../backend/store.mjs";
import { createApp } from "../backend/server.mjs";

test("редактор находит общедоступные прогулки, листает страницы и копирует рабочую ссылку", async ({ page, context }, testInfo) => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE user (id TEXT PRIMARY KEY, name TEXT, email TEXT); INSERT INTO user VALUES ('anna','Анна','anna@example.test'), ('boris','Борис','boris@example.test')");
  let now = Date.UTC(2026, 8, 30);
  const accountStore = createAccountStore(db, () => now++), store = createStore(":memory:");
  // The local server uses the real account store and routes with an isolated editor session.
  const auth = { api: { getSession: async () => ({ user: { id: "anna", role: "editor", name: "Анна", email: "anna@example.test" }, session: { id: "test", createdAt: new Date() } }) } };
  const app = createApp({ store, accountStore, auth: auth as never, provider: null, origin: "http://localhost:3217", audioDirectory: testInfo.outputDir, workerEnabled: false, allowLegacyAdminToken: false });
  try {
    for (let index = 0; index < 27; index++) {
      const title = index === 26 ? "Арбат для Анны" : `Прогулка ${index}`;
      const owner = index === 26 ? "anna" : "boris";
      const walk = accountStore.createWalk(owner, { title, idempotencyKey: `browser-walk-${index}`, snapshot: { version: 1, title, start: null, stops: [], mode: index === 26 ? "open" : "loop", minutes: 30, route: null, jobs: [], submitting: null } });
      if (!walk) throw new Error("Не удалось создать тестовую прогулку");
      accountStore.setWalkSharing(owner, walk.id, walk.revision, true);
    }
    await new Promise<void>(resolve => app.server.listen(0, "127.0.0.1", resolve));
    const apiBase = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    await page.route("**/api/**", async route => {
      const url = new URL(route.request().url());
      const response = await route.fetch({ url: apiBase + url.pathname + url.search });
      await route.fulfill({ response });
    });
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/admin?section=walks");
    await expect(page.getByRole("heading", { name: "Прогулки по ссылке" })).toBeVisible();
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
    await app.close(); store.close(); db.close();
  }
});
