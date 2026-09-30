import { afterEach, expect, it, vi } from "vitest";
import { drawMapIcon, mapIconId } from "./map-icons";

afterEach(() => vi.unstubAllGlobals());

it.each(["", "marking-oneway", "poi-", "poi-cafe", "station"])("leaves a foreign image id %j to MapLibre", id => {
  vi.stubGlobal("document", { createElement: () => { throw new Error("must not draw"); } });
  expect(drawMapIcon(id)).toBeNull();
});

it("gives up quietly where the browser cannot draw on a canvas", () => {
  vi.stubGlobal("document", { createElement: () => ({ getContext: () => null }) });
  expect(drawMapIcon(mapIconId("station"))).toBeNull();
});
