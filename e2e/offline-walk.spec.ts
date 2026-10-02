import { expect, test } from "./support/test";
import type { WalkView } from "../src/features/walks/model";

const stopId = "22222222-2222-4222-8222-222222222222";
const view: WalkView = {
  document: { version: 2, id: "11111111-1111-4111-8111-111111111111", title: "Арбат без сети", description: "", city: "Москва", mode: "open", minutes: 30,
    start: { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } },
    stops: [{ id: stopId, place: { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } }, storyRef: null, transition: "", nextHint: "" }],
    route: null, fieldChecked: false },
  revision: 1, contentVersion: "version-1",
  chapters: [{ id: stopId, status: "ready", story: { title: "Дом на Арбате", address: "Москва, Арбат, 10", paragraphs: [{ text: "История дома без сети.", factIds: [] }], sources: [], facts: [] }, audio: null }],
};

test("сохранённая прогулка каталога открывается, когда сеть недоступна", async ({ page }) => {
  let online = true;
  await page.route("**/api/**", route => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/story-walks/arbat")) return route.fulfill({ json: { user: null } });
    return online ? route.fulfill({ json: view }) : route.abort("internetdisconnected");
  });
  await page.goto("/walk?catalog=arbat");
  const settings = () => page.getByRole("button", { name: /^Остановки ·/ }).click();
  await settings();
  await expect(page.getByText("Офлайн-копия ещё не сохранена").first()).toBeVisible();
  await page.getByRole("button", { name: "Сохранить прогулку без сети" }).first().click();
  await expect(page.getByText("Офлайн-копия сохранена · 0 записей").first()).toBeVisible();

  online = false;
  await page.reload();
  await expect(page.getByText(/^Офлайн-копия от /)).toBeVisible();
  await settings();
  await expect(page.getByText("Офлайн-копия сохранена · 0 записей").first()).toBeVisible();

  await page.getByRole("button", { name: "Удалить офлайн-копию" }).first().click();
  await expect(page.getByText("Офлайн-копия ещё не сохранена").first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("link", { name: "Вернуться к прогулкам" })).toBeVisible();
});
