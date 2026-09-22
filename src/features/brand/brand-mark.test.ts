import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("единый логотип", () => {
  it("использует общее написание во всех шапках приложения", () => {
    const brand = read("./brand-mark.tsx");
    expect(brand).toContain("Отголосок<span");
    for (const path of [
      "../explore/around-screen.tsx", "../navigation/app-header.tsx",
      "../generator/story-generator.tsx", "../tour/tour-experience.tsx",
      "../admin/admin-desk.tsx",
    ]) {
      const source = read(path);
      expect(source, path).toContain("<BrandMark />");
      expect(source, path).not.toMatch(/(?:Отголосок|отголосок)<span/);
    }
  });

  it("не допускает локальных вариантов шрифта и цвета точки", () => {
    const styles = read("../../app/globals.css");
    expect(styles).toMatch(/\.brand-mark\s*\{[^}]*font-family:\s*var\(--font-display\)/);
    expect(styles).toContain("color: var(--brand-accent);");
    expect(styles).toMatch(/\.brand-mark\s*\{[^}]*line-height:\s*1;/);
    expect(styles).not.toContain('.shell[data-mode="walk"] .brand-mark > span');
    for (const path of ["../explore/explore.css", "../walk-builder/walk-builder.css", "../admin/admin.css"]) {
      expect(read(path), path).not.toMatch(/\.(?:around-brand|admin-wordmark) span\s*\{|\.walk-builder header span\s*\{/);
    }
  });

  it("использует единственный значок браузера и тот же знак в PWA", () => {
    expect(read("../../app/icon.svg")).toContain('viewBox="0 0 512 512"');
    expect(read("../../app/manifest.ts")).toContain('src: "/icon.svg"');
    const update = read("../../../public/update.html");
    expect(update).toContain('href="/icon.svg"');
    expect(update).toContain('<span class="brand-mark">Отголосок<span aria-hidden="true">.</span></span>');
    expect(read("../../../public/update.css")).toContain('.brand-mark > span { color: var(--brand-accent); }');
    expect(read("../../app/layout.tsx")).toContain('icon: "/icon.svg"');
    expect(read("../../../scripts/service-worker-manifest.mjs")).not.toContain('"favicon.ico"');
  });
});
