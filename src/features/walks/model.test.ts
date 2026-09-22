import { describe, expect, it } from "vitest";
import { migrateLegacyDraft, validateWalkDocument } from "./model";

const id = "11111111-1111-4111-8111-111111111111";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const stop = { address: "Москва, Арбат, 10", location: { lat: 55.751, lon: 37.601 } };

describe("документ пользовательской прогулки", () => {
  it("переносит старый черновик без готовых историй и не теряет линию маршрута", () => {
    const old = { version: 1, title: "Другая прогулка", start, stops: [stop], mode: "open", minutes: 30,
      jobs: [], route: { stops: [stop], geometry: [start.location, stop.location], distanceM: 220, walkingMinutes: 4, attribution: "OSM" } };
    const document = migrateLegacyDraft(old, id);
    expect(validateWalkDocument(document)).toBe(document);
    expect(document.stops).toHaveLength(1);
    expect(document.stops[0].storyRef).toBeNull();
    expect(document.route?.geometry).toEqual(old.route.geometry);
  });
});
