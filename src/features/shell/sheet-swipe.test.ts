import { expect, it } from "vitest";
import { readSwipe } from "./sheet-swipe";

it.each([
  { case: "длинный вверх", dx: 0, dy: -80, ms: 400, swipe: "up" },
  { case: "длинный вниз", dx: 5, dy: 80, ms: 400, swipe: "down" },
  { case: "ровно 32 px медленно", dx: 0, dy: -32, ms: 1000, swipe: "up" },
  { case: "31 px медленно", dx: 0, dy: -31, ms: 1000, swipe: null },
  { case: "короткий быстрый рывок", dx: 0, dy: 20, ms: 40, swipe: "down" },
  { case: "ровно 12 px со скоростью 0,4 px/мс", dx: 0, dy: -12, ms: 30, swipe: "up" },
  { case: "12 px чуть медленнее порога", dx: 0, dy: -12, ms: 31, swipe: null },
  { case: "11 px мгновенно", dx: 0, dy: -11, ms: 0, swipe: null },
  { case: "12 px за 0 мс", dx: 0, dy: 12, ms: 0, swipe: "down" },
  { case: "горизонтальный", dx: 60, dy: 40, ms: 200, swipe: null },
  { case: "диагональ поровну", dx: 50, dy: -50, ms: 200, swipe: "up" },
])("readSwipe: $case", ({ dx, dy, ms, swipe }) => {
  expect(readSwipe({ dx, dy, ms })).toBe(swipe);
});
