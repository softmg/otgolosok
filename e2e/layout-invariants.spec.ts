import { appendFileSync } from "node:fs";
import { test } from "./support/test";
import { applyLayoutCase, collectViolations, expectLayout, layoutCases, type KnownFailure } from "./support/layout";
import { SCREEN_STATES } from "./support/scenarios";

/**
 * Layout defects that still exist. Each entry must keep failing: when a defect is
 * fixed the run fails until the entry is removed, so the list only shrinks.
 */
const KNOWN_LAYOUT_FAILURES: KnownFailure[] = [
  { screen: "прогулка", state: "до старта", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 390×844", "webkit 667×375"] },
  { screen: "прогулка", state: "завершена", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "320×568", "568×320", "667×375", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 667×375"] },
  { screen: "прогулка", state: "настройки", invariant: "footer", reason: "в боковой колонке 568×320 панель прокручивается целиком, основное действие уходит из вида",
    cases: ["568×320"] },
  { screen: "прогулка", state: "настройки", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 390×844", "webkit 667×375"] },
  { screen: "прогулка", state: "остановка", invariant: "footer", reason: "в боковой колонке 568×320 панель прокручивается целиком, основное действие уходит из вида",
    cases: ["568×320"] },
  { screen: "прогулка", state: "остановка", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 390×844", "webkit 667×375"] },
  { screen: "прогулка", state: "офлайн-копия", invariant: "footer", reason: "в боковой колонке 568×320 панель прокручивается целиком, основное действие уходит из вида",
    cases: ["568×320"] },
  { screen: "прогулка", state: "офлайн-копия", invariant: "notices", reason: "в боковой колонке 568×320 текст офлайн-копии не помещается над панелью на 2 px",
    cases: ["568×320"] },
  { screen: "прогулка", state: "офлайн-копия", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430"] },
  { screen: "прогулка", state: "список остановок", invariant: "footer", reason: "в боковой колонке 568×320 панель прокручивается целиком, основное действие уходит из вида",
    cases: ["568×320"] },
  { screen: "прогулка", state: "список остановок", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 390×844", "webkit 667×375"] },
  { screen: "прогулка", state: "текст истории", invariant: "footer", reason: "в боковой колонке 568×320 панель прокручивается целиком, основное действие уходит из вида",
    cases: ["568×320"] },
  { screen: "прогулка", state: "текст истории", invariant: "target", reason: "кнопки внутри панели прогулки (крестик, вкладки, переключатели) меньше 44 px",
    cases: ["1024×500", "1280×640", "1440×900", "320×568", "360×640", "375×667", "390×844", "390×844 с вырезом", "430×932", "568×320", "667×375", "699×800", "700×800", "768×1024", "844×390", "844×390 с вырезом", "932×430", "webkit 1024×500", "webkit 320×568", "webkit 390×844", "webkit 667×375"] },
];

// LAYOUT_DUMP=<file> records the violations of every case instead of asserting — used to audit the matrix.
const dump = process.env.LAYOUT_DUMP;

for (const { screen, state, options, open, chromiumOnly } of SCREEN_STATES) {
  test.describe(`${screen} / ${state}`, () => {
    // Chromium has the superset of cases; other browsers skip the ones they do not run.
    for (const layout of layoutCases("chromium")) {
      test(layout.name, async ({ page, browserName }) => {
        test.skip(!layoutCases(browserName).some(item => item.name === layout.name), "вариант только для Chromium");
        test.skip(Boolean(chromiumOnly) && browserName !== "chromium", chromiumOnly);
        await applyLayoutCase(page, layout);
        await open(page);
        if (dump) {
          await page.waitForTimeout(1500);
          const violations = await collectViolations(page, options, layout.safeArea);
          appendFileSync(dump, JSON.stringify({ browserName, screen, state, layout: layout.name, violations }) + "\n");
          return;
        }
        await expectLayout(page, { screen, state, layout, browserName, options, known: KNOWN_LAYOUT_FAILURES });
      });
    }
  });
}
