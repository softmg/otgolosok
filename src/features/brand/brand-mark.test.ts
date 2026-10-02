import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

describe("единый логотип", () => {
  it("использует общее написание во всех шапках приложения", () => {
    const brand = read("./brand-mark.tsx");
    expect(brand).toContain("Отголосок<span");
    for (const path of [
      "../explore/around-header.tsx", "../navigation/app-header.tsx",
      "../tour/tour-experience.tsx",
      "../admin/admin-desk.tsx",
    ]) {
      const source = read(path);
      expect(source, path).toContain("<BrandMark />");
      expect(source, path).not.toMatch(/(?:Отголосок|отголосок)<span/);
    }
  });

  it("страница обновления повторяет цвета из токенов", () => {
    // public/update.css lives outside the bundle and mirrors the tokens by hand.
    const declarations = (css: string) => new Map([...css.matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)].map(([, name, value]) => [name, value.trim()]));
    const tokens = declarations(read("../../styles/tokens.css"));
    const resolve = (value: string): string => value.replace(/var\((--[\w-]+)\)/g, (_, name: string) => resolve(tokens.get(name) ?? name));
    const mirrored = declarations(read("../../../public/update.css"));
    for (const name of ["--paper", "--raised", "--ink", "--muted", "--accent", "--brand-accent"]) {
      expect(mirrored.get(name), name).toBe(resolve(tokens.get(name)!));
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
