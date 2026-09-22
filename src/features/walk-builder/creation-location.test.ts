import { expect, it } from "vitest";
import { creationLocation, creationInputError } from "./creation-location";
import { creationReducer } from "./creation-state";
it.each([["", "/history"], ["new=1", "/?new=1&walk=create"], ["local=one&edit=1", "/?local=one&edit=1&walk=create"], ["id=one", null], ["id=one&new=1", null], ["new=1&resume=1", null], ["share=one&edit=1", null]])("переносит старый адрес %s без потери намерения", (query, expected) => {
  expect(creationLocation(new URLSearchParams(query!))).toBe(expected);
});
it("возвращает выбор точки в текущий шаг", () => {
  const state = creationReducer({ step: "options", picking: false }, { type: "pick" });
  expect(state).toEqual({ step: "options", picking: true });
  expect(creationReducer(state, { type: "return" })).toEqual({ step: "options", picking: false });
});
it.each(["id=one&local=two", "lat=NaN&lon=37.6&address=Москва", "new=1&resume=1"])("не открывает конструктор с некорректными параметрами %s", query => {
  expect(creationInputError(new URLSearchParams(query))).not.toBeNull();
});
