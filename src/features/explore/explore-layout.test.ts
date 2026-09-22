import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(fileURLToPath(new URL("./explore.css", import.meta.url)), "utf8");
const screen = readFileSync(fileURLToPath(new URL("./around-screen.tsx", import.meta.url)), "utf8");

describe("раскладка карточки места", () => {
  it("центрирует нижние карточки на широких экранах вместе с навигацией", () => {
    const desktop = css.match(/@media\(min-width:700px\)\{([^\n]+)\}/)?.[1];
    expect(desktop).toBeDefined();
    expect(desktop).toMatch(/\.around-bottom\{left:50%;right:auto;width:min\(430px,calc\(100% - 56px\)\);transform:translateX\(-50%\)\}/);
    expect(desktop).toMatch(/\.around-nav\{left:50%;[^}]*transform:translateX\(-50%\)/);
    expect(desktop).not.toMatch(/\.around-geo-message\{[^}]*left:28px/);
  });

  it("сохраняет боковое расположение карточек только на горизонтальных телефонах", () => {
    const landscape = css.match(/@media\(min-width:568px\) and \(max-height:540px\)\{([\s\S]*?)\n\}/)?.[1];
    expect(landscape).toMatch(/\.around-bottom\{left:auto;right:max\(12px,env\(safe-area-inset-right\)\);width:calc\(50% - 24px\)/);
  });

  it("ограничивает всю нижнюю панель областью между шапкой и навигацией", () => {
    expect(css.charCodeAt(0)).not.toBe(0xfeff);
    expect(css).toMatch(
      /^\.around-shell\{[^}]*--around-nav-height:[^}]*position:relative[^}]*height:100dvh/,
    );
    expect(css).toMatch(
      /\.around-bottom\{[^}]*bottom:calc\(var\(--around-nav-height\) \+ 16px\)[^}]*max-height:calc\(100% - var\(--around-sheet-top\) - var\(--around-nav-height\) - 16px\)/,
    );
    expect(css).not.toMatch(
      /\.around-bottom\{[^}]*;height:calc/,
    );
    expect(css).not.toContain(".around-bottom:has(> .around-map-hint)");
    expect(css).not.toMatch(/\.around-map-hint\{[^}]*margin-top:auto/);
    expect(css).toMatch(
      /\.around-bottom>\.around-place-card\{[^}]*min-height:0/,
    );
  });

  it("показывает создание прогулки как второстепенное действие", () => {
    expect(screen).toMatch(
      /aria-labelledby="new-place-title"[\s\S]*className="around-primary"[\s\S]*className="around-secondary"[^>]*>Создать прогулку отсюда[\s\S]*<\/section>/,
    );
    expect(css).toMatch(
      /\.around-place-card \.around-primary\+\.around-secondary\{margin-top:10px\}/,
    );
  });

  it("балансирует перенос заголовка карточки геолокации", () => {
    expect(css).toMatch(/\.around-location-card h2\{text-wrap:balance\}/);
  });

  it("не перекрывает размер текста кнопок нижней навигации", () => {
    expect(css).toContain(".around-shell :where(button,input){font:inherit}");
    expect(css).not.toContain(".around-shell button,.around-shell input{font:inherit}");
  });
});
