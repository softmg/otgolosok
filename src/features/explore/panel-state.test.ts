import { describe, expect, it } from "vitest";
import { selectExplorePanel } from "./panel-state";

describe("карточка выбранного места на карте", () => {
  it("показывает выбранный дом вместо рекомендаций рядом", () => {
    expect(selectExplorePanel({ nearbyCenter: true, place: true })).toBe("place");
  });

  it("показывает рекомендации, когда центр задан геолокацией без выбранного дома", () => {
    expect(selectExplorePanel({ nearbyCenter: true })).toBe("nearby");
  });

  it("показывает поиск дома во время определения адреса и при ошибке", () => {
    expect(selectExplorePanel({ nearbyCenter: true, placeBusy: true })).toBe("place");
    expect(selectExplorePanel({ nearbyCenter: true, placeError: true })).toBe("place");
  });
});
