import { describe, expect, it } from "vitest";
import { emptyDraft, parseDraft, researchKey, validStops } from "./model";
import { draftToWalkDocument, walkDocumentToDraft, walkViewToRoute } from "../walks/adapters";
const start = { address: "Москва, Арбат, 1", location: { lat: 55.75, lon: 37.6 } };
const destination = { address: "Москва, Арбат, 20", location: { lat: 55.752, lon: 37.6 } };

describe("финиш прогулки", () => {
  it("сохраняется в документе и черновике даже без исторических остановок", () => {
    const draft = { ...emptyDraft(), start, destination, mode: "open" as const, route: { stops: [], geometry: [start.location, destination.location], walkingMinutes: 4, distanceM: 220, attribution: "OSM" } };
    const document = draftToWalkDocument(draft, "11111111-1111-4111-8111-111111111111");
    expect(parseDraft(JSON.stringify(walkDocumentToDraft(document)))).toMatchObject({ destination, route: draft.route });
    expect(walkViewToRoute({ document, revision: 0, contentVersion: "test", chapters: [] }).walk?.finish.location).toEqual(destination.location);
    expect(() => parseDraft(JSON.stringify({ ...draft, mode: "loop" }))).toThrow();
  });
  it("не принимает совпавший финиш и не ослабляет старые ограничения", () => {
    expect(validStops(start, [])).toBe(false);
    expect(validStops(start, [], destination)).toBe(true);
    expect(validStops(start, [], start)).toBe(false);
  });
  it("различает исследования к разным финишам и сохраняет старый ключ", () => {
    const request = { start, mode: "open" as const, minutes: 30 as const };
    expect(researchKey(request)).toBe(JSON.stringify([55.75, 37.6, "open", 30]));
    expect(researchKey({ ...request, destination })).not.toBe(researchKey(request));
  });
});
