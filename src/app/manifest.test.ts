import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import manifest from "./manifest";

const app = manifest();
const icons = app.icons ?? [];

// Width and height from the PNG IHDR chunk.
function pngSize(src: string): string {
  const png = readFileSync(new URL(`../../public${src}`, import.meta.url));
  expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

describe("манифест приложения", () => {
  it("открывает установленное приложение внутри своей области", () => {
    expect(app.display).toBe("standalone");
    expect(app.id).toBe("/");
    expect(app.start_url?.startsWith(app.scope ?? "")).toBe(true);
    expect(app.name && app.short_name).toBeTruthy();
  });

  it.each(["192x192", "512x512"])("содержит PNG-иконку %s для установки", (size) => {
    expect(icons.some((icon) => icon.type === "image/png" && icon.sizes === size && icon.purpose === "any")).toBe(true);
  });

  it("содержит отдельную маскируемую иконку", () => {
    const maskable = icons.filter((icon) => icon.purpose === "maskable");
    expect(maskable).toHaveLength(1);
    expect(maskable[0].src).not.toBe("/icon.svg");
  });

  it.each(icons.filter((icon) => icon.type === "image/png").map((icon) => [icon.src, icon.sizes]))(
    "%s — файл с заявленным размером %s",
    (src, sizes) => {
      expect(pngSize(src)).toBe(sizes);
    },
  );

  it("иконка для iOS — PNG 180×180", () => {
    expect(pngSize("/icons/apple-touch-icon.png")).toBe("180x180");
  });
});
