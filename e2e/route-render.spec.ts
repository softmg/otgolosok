import { expect, test } from "./support/test";
import { draftToWalkDocument } from "../src/features/walks/adapters";

const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
// A long zigzag across several kilometres: at walk zoom it runs far past every edge of the screen.
const geometry = Array.from({ length: 401 }, (_, i) => ({ lat: 55.7 + i * 0.00025, lon: 37.55 + 0.03 * Math.sin(i / 20) + i * 0.0003 }));
const stops = [200, 400].map((index, n) => ({ address: `Остановка ${n + 1}`, location: geometry[index] }));

test("линия маршрута не обрывается, пока карту тянут мышью на десктопе", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const document = draftToWalkDocument({ version: 1, title: "Длинная", start: { address: "Старт", location: geometry[0] }, destination: stops[1], mode: "open", minutes: 90,
    stops, route: { stops, geometry, distanceM: 8000, walkingMinutes: 90, attribution: "OSM" }, jobs: [], submitting: null }, id);
  await page.addInitScript(({ id, document }) => {
    localStorage.setItem("otgolosok:walks:v2", JSON.stringify({ version: 2, legacyId: null, items: { [id]: { document, revision: 0 } } }));
  }, { id, document });
  await page.route("**/api/**", route => route.fulfill({ json: { user: null } }));
  await page.goto(`/walk?local=${id}`);
  const map = page.locator(".walk-session-map");
  await expect(map.locator(".leaflet-route-pane path[data-route]")).toBeVisible();

  // Leaflet redraws a line only when the map stops: mid-drag the screen shows what was drawn before it.
  await page.mouse.move(1000, 300);
  await page.mouse.down();
  await page.mouse.move(400, 500, { steps: 20 });
  const drawn = await map.locator(".leaflet-route-pane svg").boundingBox();
  const view = await map.boundingBox();
  await page.mouse.up();
  expect(drawn && view).toBeTruthy();
  expect(drawn!.x).toBeLessThanOrEqual(view!.x);
  expect(drawn!.y).toBeLessThanOrEqual(view!.y);
  expect(drawn!.x + drawn!.width).toBeGreaterThanOrEqual(view!.x + view!.width);
  expect(drawn!.y + drawn!.height).toBeGreaterThanOrEqual(view!.y + view!.height);
});
