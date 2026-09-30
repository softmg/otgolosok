import { describe, expect, it } from "vitest";
import { fitBox, insetsFromRects, type MapInsets, type RectLike } from "./map-insets";

const map: RectLike = { top: 0, right: 390, bottom: 844, left: 0 };

describe("свободная область карты", () => {
  it.each<[string, RectLike, RectLike, MapInsets]>([
    ["между шапкой и панелью", map, { top: 130, right: 378, bottom: 500, left: 12 }, { top: 130, right: 12, bottom: 344, left: 12 }],
    ["карта сдвинута от края окна", { top: 20, right: 420, bottom: 864, left: 30 }, { top: 150, right: 400, bottom: 520, left: 42 }, { top: 130, right: 20, bottom: 344, left: 12 }],
    ["дробные пиксели округляются", map, { top: 129.6, right: 377.7, bottom: 500.4, left: 12.2 }, { top: 130, right: 12, bottom: 344, left: 12 }],
    ["пустая свободная ячейка", map, { top: 400, right: 200, bottom: 400, left: 200 }, { top: 400, right: 190, bottom: 444, left: 200 }],
    ["ячейка выходит за карту", map, { top: -10, right: 400, bottom: 900, left: -5 }, { top: 0, right: 0, bottom: 0, left: 0 }],
  ])("%s", (_, mapRect, free, expected) => {
    expect(insetsFromRects(mapRect, free)).toEqual(expected);
  });
});

describe("область вписывания", () => {
  const size = { x: 390, y: 844 };
  const min = { x: 160, y: 96 };

  it.each<[string, MapInsets, MapInsets]>([
    ["достаточная область не меняется", { top: 130, right: 12, bottom: 344, left: 12 }, { top: 130, right: 12, bottom: 344, left: 12 }],
    ["низкая область растёт вокруг центра", { top: 400, right: 12, bottom: 404, left: 12 }, { top: 372, right: 12, bottom: 376, left: 12 }],
    ["отрицательная область не бывает отрицательной", { top: 500, right: 12, bottom: 500, left: 12 }, { top: 374, right: 12, bottom: 374, left: 12 }],
    ["узкая колонка у правого края прижимается к краю", { top: 0, right: 0, bottom: 0, left: 300 }, { top: 0, right: 0, bottom: 0, left: 230 }],
  ])("%s", (_, insets, expected) => {
    const box = fitBox(size, insets, min);
    expect(box).toEqual(expected);
    expect(size.x - box.left - box.right).toBeGreaterThanOrEqual(min.x);
    expect(size.y - box.top - box.bottom).toBeGreaterThanOrEqual(min.y);
  });

  it("карта меньше минимума отдаётся целиком", () => {
    expect(fitBox({ x: 100, y: 50 }, { top: 10, right: 10, bottom: 10, left: 10 }, min)).toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
  });
});
