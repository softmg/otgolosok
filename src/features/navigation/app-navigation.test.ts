import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { navigationSection } from "./app-navigation-state";

describe("нижняя навигация приложения", () => {
  it.each([
    ["/", "nearby"],
    ["/walk", "walk"],
    ["/walk/", "walk"],
    ["/create", null],
    ["/account", "account"],
    ["/history", "history"],
  ] as const)("выделяет раздел %s", (pathname, expected) => {
    expect(navigationSection(pathname)).toBe(expected);
  });

  it.each(["/login", "/admin", "/update.html"])(
    "не выделяет служебный маршрут %s",
    (pathname) => {
      expect(navigationSection(pathname)).toBeNull();
    },
  );

  it("подключена в общем layout, а не отдельно на страницах", () => {
    const layout = readFileSync(
      fileURLToPath(new URL("../../app/layout.tsx", import.meta.url)),
      "utf8",
    );
    expect(layout).toContain("<AppNavigation />");
  });

  it("открывает создание на карте и отдельную историю", () => {
    const navigation = readFileSync(
      fileURLToPath(new URL("./app-navigation.tsx", import.meta.url)),
      "utf8",
    );
    const home = readFileSync(
      fileURLToPath(new URL("../explore/around-screen.tsx", import.meta.url)),
      "utf8",
    );

    expect(navigation).toContain('<Link href="/?walk=create"');
    expect(navigation).toContain('<Link href="/history"');
    expect(home).toContain("<WalkCreationPanel");
  });
});
