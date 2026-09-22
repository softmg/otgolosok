import { describe, expect, it } from "vitest";
import { DRAFT_KEY, editDraft, emptyDraft, isPlace, isPlan, moveStop, parseDraft, rememberStory, storyAddressKey, saveDraft, validStops, type Place, type Plan } from "./model";

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
    expect(validStops(start, [start])).toBe(false);
    expect(validStops(start, [stop, stop])).toBe(false);
    const distinct = Array.from({ length: 10 }, (_, index) => ({ address: `Москва, Арбат, ${index + 10}`, location: { lat: 55.752 + index * 0.001, lon: 37.604 } }));
    expect(validStops(start, distinct)).toBe(true);
    expect(validStops(start, [...distinct, { address: "Москва, Арбат, 20", location: { lat: 55.762, lon: 37.604 } }])).toBe(false);
  });
  it("reorders immutably with bounded accessible up/down operations", () => {
    const stops = [stop, last];
    expect(moveStop(stops, 0, 1)).toEqual([last, stop]);
    expect(moveStop(stops, 1, -1)).toEqual([last, stop]);
    expect(moveStop(stops, 0, -1)).toEqual(stops);
    expect(moveStop(stops, 1, 1)).toEqual(stops);
    expect(stops).toEqual([stop, last]);
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
