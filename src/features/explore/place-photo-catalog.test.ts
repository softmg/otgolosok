import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import photos from "../../../backend/place-images-editorial.json";

describe("редакционный каталог фотографий", () => {
  it.each(Object.entries(photos))("%s: локальные файлы и указание авторства готовы к публикации", (id, photo) => {
    expect(id).toMatch(/^osm:(node|way|relation):\d+$/);
    expect(photo.alt.trim().length).toBeGreaterThan(5);
    expect(photo.author.trim().length).toBeGreaterThan(0);
    expect(photo.license.trim().length).toBeGreaterThan(0);
    expect(new URL(photo.sourceUrl).hostname).toBe("commons.wikimedia.org");
    expect(["https:", "http:"]).toContain(new URL(photo.licenseUrl).protocol);
    expect(photo.width).toBeGreaterThan(0);
    expect(photo.height).toBeGreaterThan(0);
    expect(photo.src).not.toBe(photo.thumbnail);
    for (const path of [photo.thumbnail, photo.src]) {
      expect(path).toMatch(/^\/images\/places\/[a-z0-9-]+\.jpg$/);
      const bytes = readFileSync(fileURLToPath(new URL(`../../../public${path}`, import.meta.url)));
      expect(path).toContain(createHash("sha256").update(bytes).digest("hex").slice(0, 12));
      expect([...bytes.subarray(0, 3)]).toEqual([255, 216, 255]);
      expect(bytes.length).toBeLessThan(path === photo.thumbnail ? 60_000 : 1_000_000);
    }
  });
});
