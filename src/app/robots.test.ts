import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rules = readFileSync(new URL("./robots.txt", import.meta.url), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));
const disallowed = rules.filter((line) => line.startsWith("Disallow:")).map((line) => line.slice(9).trim());

describe("robots.txt", () => {
  it("открывает публичные страницы для индексации", () => {
    expect(rules).toContain("User-agent: *");
    expect(disallowed).not.toContain("/");
    for (const page of ["/", "/walk", "/history", "/create"]) {
      expect(disallowed.some((prefix) => prefix && page.startsWith(prefix))).toBe(false);
    }
  });

  it.each(["/admin", "/account", "/login", "/api/"])("закрывает служебный раздел %s", (path) => {
    expect(disallowed).toContain(path);
  });
});
