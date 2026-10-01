import { test as base } from "@playwright/test";

export { expect } from "@playwright/test";
export type { Locator, Page } from "@playwright/test";

/**
 * Every e2e test runs with silent media. Headless Chromium mutes itself, but WebKit
 * plays real story audio through the speakers, and so does any browser run with --headed.
 */
export const test = base.extend<{ silentMedia: void }>({
  silentMedia: [async ({ page }, use) => {
    await page.addInitScript(() => {
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        this.muted = true;
        return play.call(this);
      };
    });
    await use();
  }, { auto: true }],
});
