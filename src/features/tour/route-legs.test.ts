import { describe, expect, it } from "vitest";
import { legFitPoints, legRange, routeLegCuts } from "./route-legs";

// About 31 m per step east along a parallel in Moscow; north steps are 11 m.
const at = (step: number, north = 0) => ({ lat: 55.75 + north * 0.0001, lon: 37.6 + step * 0.0005 });
const line = (count: number) => Array.from({ length: count }, (_, step) => at(step));

describe("routeLegCuts", () => {
  it.each([
    { name: "a straight route cuts at each stop's vertex", geometry: line(10), stops: [at(3), at(7)], cuts: [3, 7] },
    { name: "a stop at the start building cuts at vertex 0", geometry: line(10), stops: [at(0), at(5)], cuts: [0, 5] },
    { name: "a stop at the finish cuts at the last vertex", geometry: line(10), stops: [at(4), at(9)], cuts: [4, 9] },
    { name: "a stop 100 m off the line still cuts at the nearest vertex", geometry: line(10), stops: [at(6, 9)], cuts: [6] },
    { name: "no stops, no cuts", geometry: line(10), stops: [], cuts: [] },
  ])("$name", ({ geometry, stops, cuts }) => {
    expect(routeLegCuts(geometry, stops)).toEqual(cuts);
  });

  it("a loop walk that passes a stop twice cuts at the first pass", () => {
    // Out along the street to step 6 and back on the same street, 5 m to the side.
    const geometry = [...line(7), ...[5, 4, 3, 2, 1, 0].map(step => at(step, 0.45))];
    expect(routeLegCuts(geometry, [at(3, 0.45)])).toEqual([3]);
    // The next stop is searched after the previous one, so the way back counts for it.
    expect(routeLegCuts(geometry, [at(6), at(2, 0.45)])).toEqual([6, 10]);
  });
});

describe("legRange", () => {
  it.each([
    { name: "the first leg from the start", cuts: [3, 7], leg: 0, range: [0, 3] },
    { name: "a leg between stops", cuts: [3, 7], leg: 1, range: [3, 7] },
    { name: "the leg to the finish", cuts: [3, 7], leg: 2, range: [7, 9] },
    { name: "a stop at the start has no leg into it", cuts: [0, 5], leg: 0, range: null },
    { name: "a finish at the last stop has no final leg", cuts: [4, 9], leg: 2, range: null },
    { name: "without stops the only leg is the whole route", cuts: [], leg: 0, range: [0, 9] },
    { name: "a leg past the finish", cuts: [3], leg: 2, range: null },
    { name: "a negative leg", cuts: [3], leg: -1, range: null },
  ])("$name", ({ cuts, leg, range }) => {
    expect(legRange(cuts, 10, leg)).toEqual(range);
  });

  it("a route without a line has no legs", () => {
    expect(legRange([], 1, 0)).toBeNull();
  });
});

describe("legFitPoints", () => {
  const geometry = line(10);
  it.each([
    { name: "a leg without a position", range: [2, 4] as [number, number], user: null, points: [at(2), at(3), at(4)], withUser: false },
    { name: "a leg with the walker beside it", range: [2, 4] as [number, number], user: { ...at(1, 3), accuracyM: 10 }, points: [at(2), at(3), at(4), at(1, 3)], withUser: true },
    { name: "a leg with the walker 1.4 km north", range: [2, 4] as [number, number], user: at(3, 126), points: [at(2), at(3), at(4), at(3, 126)], withUser: true },
    { name: "a leg with the walker 1.6 km north", range: [2, 4] as [number, number], user: at(3, 144), points: [at(2), at(3), at(4)], withUser: false },
    { name: "a leg without length shows its stop", range: null, user: null, points: [at(7)], withUser: false },
  ])("$name", ({ range, user, points, withUser }) => {
    expect(legFitPoints(geometry, range, at(7), user)).toEqual({ points, withUser });
  });
});
