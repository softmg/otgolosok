import { describe, expect, it, vi } from "vitest";
import { rememberGeoPromptDismissal, shouldShowGeoPrompt } from "./geo-prompt";

describe("подсказка геолокации", () => {
  it("показывается до первого закрытия", () => {
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() };

    expect(shouldShowGeoPrompt(storage)).toBe(true);
  });

  it("сохраняет закрытие и больше не показывается", () => {
    const memory = new Map<string, string>();
    const storage = {
      getItem: (key: string) => memory.get(key) ?? null,
      setItem: (key: string, value: string) => memory.set(key, value),
    };

    rememberGeoPromptDismissal(storage);

    expect(shouldShowGeoPrompt(storage)).toBe(false);
  });

  it("остаётся работоспособной без доступа к хранилищу", () => {
    const storage = {
      getItem: () => { throw new Error("denied"); },
      setItem: () => { throw new Error("denied"); },
    };

    expect(shouldShowGeoPrompt(storage)).toBe(true);
    expect(() => rememberGeoPromptDismissal(storage)).not.toThrow();
  });
});
