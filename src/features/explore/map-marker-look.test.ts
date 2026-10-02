import { describe, expect, it } from "vitest";
import type { MapItem } from "./explore-map";
import { markerLook } from "./map-marker-look";

const at = { lat: 55.75, lon: 37.6 };
const item = (extra: Partial<MapItem>): MapItem => ({ id: "x", title: "Место", location: at, ...extra });

describe("вид метки на карте", () => {
  it.each([
    ["место", {}, false, { kind: "place", label: "", size: 44, dataMarker: "pin", zIndex: 0 }],
    ["выбранное место", {}, true, { kind: "place", label: "", size: 44, dataMarker: "pin", zIndex: 1000 }],
    ["история готовится", { pending: true }, false, { kind: "pending", label: "", size: 44, dataMarker: "pin", zIndex: 0 }],
    ["выбранная готовящаяся история", { pending: true }, true, { kind: "pending", label: "", size: 44, dataMarker: "pin", zIndex: 1000 }],
    ["остановка", { number: 3 }, false, { kind: "stop", label: "3", size: 44, dataMarker: "pin", zIndex: 0 }],
    ["текущая остановка", { number: 3 }, true, { kind: "stop", label: "3", size: 44, dataMarker: "pin", zIndex: 1000 }],
    ["старт или финиш", { endpoint: true }, false, { kind: "endpoint", label: "", size: 44, dataMarker: "endpoint", zIndex: -1000 }],
    ["фоновая точка каталога", { compact: true }, false, { kind: "background", label: "", size: 32, dataMarker: "dot", zIndex: -1000 }],
    ["номер важнее «готовится»", { number: 2, pending: true }, false, { kind: "stop", label: "2", size: 44, dataMarker: "pin", zIndex: 0 }],
    ["конец маршрута важнее номера", { endpoint: true, number: 2 }, false, { kind: "endpoint", label: "", size: 44, dataMarker: "endpoint", zIndex: -1000 }],
  ] as const)("%s", (_name, extra, active, expected) => {
    expect(markerLook(item(extra), active)).toEqual(expected);
  });

});
