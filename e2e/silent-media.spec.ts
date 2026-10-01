import { expect, test } from "./support/test";

test("медиа в тестах играет без звука", async ({ page }) => {
  await page.goto("about:blank");
  const muted = await page.evaluate(() => {
    const audio = new Audio();
    audio.play().catch(() => undefined);
    return audio.muted;
  });
  expect(muted).toBe(true);
});
