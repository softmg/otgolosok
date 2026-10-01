// Rasterizes src/app/icon.svg into the PNG icons that installed apps need:
// iOS ignores SVG touch icons, and maskable icons must be full-bleed because
// the launcher applies its own mask. Run after changing the logo:
//   node scripts/build-app-icons.mjs
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const source = await readFile(new URL("../src/app/icon.svg", import.meta.url), "utf8");
const rounded = /\srx="\d+"/;
if (!rounded.test(source)) throw new Error("icon.svg: the background <rect rx> is missing; update the full-bleed variant");
const fullBleed = source.replace(rounded, "");

const output = new URL("../public/icons/", import.meta.url);
const icons = [
  { file: "icon-192.png", size: 192, svg: source },
  { file: "icon-512.png", size: 512, svg: source },
  { file: "maskable-512.png", size: 512, svg: fullBleed },
  // iOS rounds the corners itself and fills transparency with black.
  { file: "apple-touch-icon.png", size: 180, svg: fullBleed },
];

await mkdir(output, { recursive: true });
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ deviceScaleFactor: 1 });
  for (const { file, size, svg } of icons) {
    await page.setViewportSize({ width: size, height: size });
    const sized = svg.replace("<svg ", `<svg width="${size}" height="${size}" `);
    await page.setContent(`<style>*{margin:0}svg{display:block}</style>${sized}`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
    await writeFile(new URL(file, output), png);
    console.log(`public/icons/${file}: ${size}×${size}`);
  }
} finally {
  await browser.close();
}
