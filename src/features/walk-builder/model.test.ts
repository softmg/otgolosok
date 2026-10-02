import { describe, expect, it } from "vitest";
import { DRAFT_KEY, editDraft, emptyDraft, isPlace, isPlan, parseDraft, rememberStory, routeShortfall, storyAddressKey, saveDraft, validStops, type Place, type Plan } from "./model";

const start: Place = { address: "Москва, улица Первая, 1", location: { lat: 55.75, lon: 37.6 } };
const stop: Place = { address: "Москва, улица Вторая, 2", location: { lat: 55.752, lon: 37.602 } };
const last: Place = { address: "Москва, улица Третья, 3", location: { lat: 55.755, lon: 37.605 } };
const route: Plan = { stops: [stop], geometry: [start.location, stop.location, start.location], distanceM: 600, walkingMinutes: 10, attribution: "OpenStreetMap" };
describe("walk draft", () => {
  it("matches backend address normalization without merging distinct house numbers", () => {
    expect(storyAddressKey("  ул.   Зелёная,  10 ")).toBe(storyAddressKey("МОСКВА, УЛ ЗЕЛЕНАЯ. 10"));
    expect(storyAddressKey("Москва, ул. Зелёная, １０")).toBe(storyAddressKey("Москва ул Зеленая 10"));
    expect(storyAddressKey("Москва ул Зеленая 10/1")).not.toBe(storyAddressKey("Москва ул Зеленая 10/2"));
    expect(storyAddressKey("Москва ул Зеленая 10-1")).not.toBe(storyAddressKey("Москва ул Зеленая 10 1"));
  });
  it("upserts a backend ID and restores old duplicates using the last known state", () => {
    const old = { place: start, id: "12345678-1234-1234-1234-123456789abc", stage: "failed" as const };
    const retried = { ...old, place: { ...stop, address: "МОСКВА. улица Первая 1" }, stage: "queued" as const };
    expect(storyAddressKey(old.place.address)).toBe(storyAddressKey(retried.place.address));
    expect(rememberStory([old], retried)).toEqual([retried]);
    expect(parseDraft(JSON.stringify({ ...emptyDraft(), jobs: [old, retried] })).jobs).toEqual([retried]);
    expect(old.stage).toBe("failed");
  });
  it("defaults to loop and restores only validated versioned data", () => {
    expect(parseDraft(null).mode).toBe("loop");
    const d = { ...emptyDraft(), start, stops: [stop], route };
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
    for (const raw of ["{", "null", JSON.stringify({ ...d, version: 2 }), JSON.stringify({ ...d, minutes: "30" }), JSON.stringify({ ...d, stops: [last] }), JSON.stringify({ ...d, jobs: [{ place: start, id: "bad", stage: "ready" }] })]) expect(() => parseDraft(raw)).toThrow();
  });
  it("rejects non-finite/outside locations and malformed route data", () => {
    expect(isPlace({ ...start, location: { lat: NaN, lon: 37 } })).toBe(false);
    expect(isPlace({ ...start, address: "<script>" })).toBe(false);
    expect(isPlan({ ...route, geometry: [] })).toBe(false);
    expect(isPlan({ ...route, distanceM: Infinity })).toBe(false);
    expect(isPlan({ ...route, walkingMinutes: -1 })).toBe(false);
    expect(() => parseDraft(JSON.stringify({ ...emptyDraft(), start, stops: [stop], route: { ...route, walkingMinutes: 60 } }))).toThrow();
    expect(isPlace({ ...stop, contentId: "osm:way:42" })).toBe(true);
    expect(isPlace({ ...stop, contentId: "not-osm" })).toBe(false);
  });
  it("validates manual count and distinct houses", () => {
    expect(validStops(start, [stop, last])).toBe(true);
    expect(validStops(null, [stop])).toBe(false);
    expect(validStops(start, [])).toBe(false);
    expect(validStops(start, [stop, start])).toBe(false);
    expect(validStops(start, [stop, stop])).toBe(false);
    const distinct = Array.from({ length: 40 }, (_, index) => ({ address: `Москва, Арбат, ${index + 10}`, location: { lat: 55.752 + index * 0.001, lon: 37.604 } }));
    expect(validStops(start, distinct)).toBe(true);
    expect(validStops(start, [...distinct, { address: "Москва, Арбат, 50", location: { lat: 55.792, lon: 37.604 } }])).toBe(false);
  });
  // The first stop may be the start building, like on the server; no other pair may coincide.
  it.each([
    ["first stop at the start", [0], undefined, true],
    ["first stop 3 m from the start", [3], undefined, true],
    ["first stop 3 m from the start with a destination", [3], 400, true],
    ["second stop 3 m from the start", [200, 3], undefined, false],
    ["destination 3 m from the start", [200], 3, false],
    ["destination 3 m from the start without stops", [], 3, false],
  ] as const)("%s: valid is %s", (_, stopsNorthM, destinationEastM, valid) => {
    const north = (m: number, i: number): Place => ({ address: `Москва, Арбат, ${i + 10}`, location: { lat: start.location.lat + m / 111195, lon: start.location.lon } });
    const destination: Place | null = destinationEastM === undefined ? null : { address: "Москва, Арбат, 99", location: { lat: start.location.lat, lon: start.location.lon + destinationEastM / 62600 } };
    expect(validStops(start, stopsNorthM.map(north), destination)).toBe(valid);
  });
  it("restores a saved route whose first stop is the start building", () => {
    const here: Place = { address: start.address, location: { lat: start.location.lat + 3 / 111195, lon: start.location.lon } };
    const d = { ...emptyDraft(), start, stops: [here, stop], route: { ...route, stops: [here, stop] } };
    expect(parseDraft(JSON.stringify(d))).toEqual(d);
  });
  it.each([11, 28, 40])("restores all %i stops and rejects oversized or reordered routes", count => {
    const stops = Array.from({ length: count }, (_, index) => ({ address: `Москва, Арбат, ${index + 10}`, location: { lat: 55.752 + index * 0.001, lon: 37.604 } }));
    const draft = { ...emptyDraft(), start, stops, route: { ...route, stops } };
    expect(parseDraft(JSON.stringify(draft)).stops).toEqual(stops);
    expect(isPlan(draft.route)).toBe(true);
    expect(() => parseDraft(JSON.stringify({ ...draft, route: { ...draft.route, stops: stops.toReversed() } }))).toThrow();
    const oversized = Array.from({ length: 41 }, (_, index) => ({ ...stop, address: `Москва, Арбат, ${index + 1}` }));
    expect(isPlan({ ...route, stops: oversized })).toBe(false);
    expect(() => parseDraft(JSON.stringify({ ...draft, stops: oversized, route: null }))).toThrow();
  });
  it("all planning edits invalidate geometry but preserve successful IDs and uncertain intent", () => {
    const jobs = [{ place: start, id: "12345678-1234-1234-1234-123456789abc", stage: "ready" as const }];
    const d = { ...emptyDraft(), start, stops: [stop], route, jobs, submitting: stop };
    for (const change of [{ mode: "open" as const }, { minutes: 60 as const }, { start: last }, { stops: [last] }]) {
      const next = editDraft(d, change);
      expect(next.route).toBeNull(); expect(next.jobs).toEqual(jobs); expect(next.submitting).toEqual(stop);
    }
  });
  it("never overwrites an unreadable or concurrently changed stored copy", () => {
    const values = new Map<string,string>();
    const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => { values.set(k, v); } };
    const raw = saveDraft(storage, emptyDraft(), null);
    expect(parseDraft(raw)).toEqual(emptyDraft());
    values.set(DRAFT_KEY, "corrupted original");
    expect(() => saveDraft(storage, emptyDraft(), raw)).toThrow();
    expect(values.get(DRAFT_KEY)).toBe("corrupted original");
    expect(() => saveDraft({ getItem: () => null, setItem: () => { throw new Error("quota"); } }, emptyDraft(), null)).toThrow("quota");
  });
});

describe("route shortfall", () => {
  it.each([
    [10, 60, 10],
    [44, 60, 44],
    [45, 60, null],
    [60, 60, null],
    [22, 30, 22],
    [23, 30, null],
    [67, 90, 67],
    [68, 90, null],
  ])("%i of %i walking minutes reports %s", (walkingMinutes, minutes, expected) => {
    expect(routeShortfall({ walkingMinutes }, minutes)).toBe(expected);
  });
});
