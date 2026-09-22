import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = readFileSync(new URL("./globals.css", import.meta.url), "utf8");
const uiStyles = [
  "../features/explore/explore.css",
  "../features/navigation/app-navigation.css",
  "../features/auth/auth.css",
  "../features/walk-builder/walk-builder.css",
  "../features/admin/admin.css",
  "../features/admin/walk-admin.css",
].map((file) => readFileSync(new URL(file, import.meta.url), "utf8"));

describe("дизайн-токены интерфейса", () => {
  it("закрепляет читаемую типографическую шкалу", () => {
    expect(root).toMatch(/--text-body:\s*1\.125rem/);
    expect(root).toMatch(/--text-control:\s*1rem/);
    expect(root).toMatch(/--text-secondary:\s*0\.875rem/);
    expect(root).toMatch(/--text-meta:\s*0\.75rem/);
  });

  it("подключает общие токены к feature-стилям", () => {
    for (const css of uiStyles) expect(css).toMatch(/var\(--text-(?:body|control|secondary|meta)/);
  });

  it("не допускает UI-размеры меньше 12px, кроме согласованной подписи карты 11px", () => {
    for (const css of uiStyles) {
      const controls = css.replace(/\.map-attribution\{[^}]*font-size:[^}]*\}/g, rule => {
        expect(rule).toMatch(/font-size:\s*11px/);
        return "";
      });
      const sizes = [...controls.matchAll(/font-size\s*:\s*(\d+(?:\.\d+)?)px/g)].map((match) => Number(match[1]));
      expect(sizes.filter((size) => size < 12)).toEqual([]);
    }
  });
});
