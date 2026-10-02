import { describe, expect, it } from "vitest";
import type { WalkView } from "./model";
import { ownWalkEditHref, ownWalkNotes } from "./own-walk";

const place = (n: number) => ({ address: `Москва, Арбат, ${n}`, location: { lat: 55.75 + n / 10000, lon: 37.6 } });
type Status = WalkView["chapters"][number]["status"];
function view({ minutes = 30, walkingMinutes = 25, destination = false, statuses = [] }: { minutes?: number; walkingMinutes?: number | null; destination?: boolean; statuses?: readonly Status[] }): WalkView {
  const stops = statuses.map((_, i) => ({ id: `stop-${i}`, place: place(i + 10), storyRef: null, transition: "", nextHint: "" }));
  return {
    document: { version: 2, id: "11111111-1111-4111-8111-111111111111", title: "Арбат", description: "", city: "Москва", mode: destination ? "open" : "loop", minutes,
      start: place(1), destination: destination ? place(2) : null, stops, fieldChecked: false,
      route: walkingMinutes === null ? null : { geometry: [place(1).location, place(2).location], distanceM: 1000, walkingMinutes, attribution: "OSM" } },
    revision: 1, contentVersion: "v1", chapters: statuses.map((status, i) => ({ id: `stop-${i}`, status, story: null, audio: null })),
  };
}
const shortfall = (walked: number, minutes: number) => `Рядом нашлось мест только на ${walked} мин из ${minutes}. Измените начало прогулки.`;

describe("own walk", () => {
  it.each([
    ["local", "a b", "/?walk=create&local=a+b&edit=1"],
    ["id", "11111111-1111-4111-8111-111111111111", "/?walk=create&id=11111111-1111-4111-8111-111111111111&edit=1"],
  ] as const)("edits a %s walk in the builder", (kind, id, href) => {
    expect(ownWalkEditHref(kind, id)).toBe(href);
  });

  it.each([
    ["a walk that fills the time", { walkingMinutes: 25 }, []],
    ["exactly 75 % of the time", { minutes: 60, walkingMinutes: 45 }, []],
    ["below 75 % of the time", { minutes: 60, walkingMinutes: 44 }, [shortfall(44, 60)]],
    ["a short walk to a chosen destination", { walkingMinutes: 5, destination: true }, []],
    ["a walk without a route", { walkingMinutes: null }, []],
    ["one stop without a story", { statuses: ["ready", "not_requested"] as const }, ["У 1 остановки пока нет истории."]],
    ["stops still being prepared", { statuses: ["preparing", "failed"] as const }, []],
    ["both notes", { walkingMinutes: 10, statuses: ["not_requested", "not_requested", "ready"] as const }, [shortfall(10, 30), "У 2 остановок пока нет истории."]],
    ["21 stops without a story", { statuses: Array<Status>(21).fill("not_requested") }, ["У 21 остановки пока нет истории."]],
  ] as const)("notes for %s", (_, input, notes) => {
    expect(ownWalkNotes(view(input))).toEqual(notes);
  });
});
