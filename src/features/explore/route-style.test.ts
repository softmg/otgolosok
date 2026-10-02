import { describe, expect, it } from "vitest";
import { chevronMarks, routeRuns, type RouteRun } from "./route-style";

const run = (from: number, to: number, covered = false, active = false): RouteRun => ({ from, to, covered, active });

describe("routeRuns", () => {
  it.each([
    { name: "a plain route is one run", tunnels: [], active: null, runs: [run(0, 9)] },
    { name: "a tunnel splits the line", tunnels: [[3, 5]] as const, active: null, runs: [run(0, 3), run(3, 5, true), run(5, 9)] },
    { name: "a tunnel at both ends", tunnels: [[0, 2], [7, 9]] as const, active: null, runs: [run(0, 2, true), run(2, 7), run(7, 9, true)] },
    { name: "the highlighted leg is cut out of the rest", tunnels: [], active: [2, 6] as const, runs: [run(0, 2), run(2, 6, false, true), run(6, 9)] },
    { name: "a highlighted last leg", tunnels: [], active: [6, 9] as const, runs: [run(0, 6), run(6, 9, false, true)] },
    { name: "the whole route highlighted", tunnels: [], active: [0, 9] as const, runs: [run(0, 9, false, true)] },
    { name: "a tunnel crossing the start of the leg", tunnels: [[1, 4]] as const, active: [3, 6] as const,
      runs: [run(0, 1), run(1, 3, true), run(3, 4, true, true), run(4, 6, false, true), run(6, 9)] },
    { name: "a tunnel crossing the end of the leg", tunnels: [[5, 8]] as const, active: [3, 6] as const,
      runs: [run(0, 3), run(3, 5, false, true), run(5, 6, true, true), run(6, 8, true), run(8, 9)] },
    { name: "a tunnel inside the leg", tunnels: [[4, 5]] as const, active: [3, 6] as const,
      runs: [run(0, 3), run(3, 4, false, true), run(4, 5, true, true), run(5, 6, false, true), run(6, 9)] },
    { name: "a range past the end is clipped", tunnels: [[8, 20]] as const, active: null, runs: [run(0, 8), run(8, 9, true)] },
  ])("$name", ({ tunnels, active, runs }) => {
    const result = routeRuns(10, tunnels, active);
    expect(result).toEqual(runs);
    // Every segment exactly once, in order.
    expect(result[0].from).toBe(0);
    expect(result.at(-1)?.to).toBe(9);
    for (let i = 1; i < result.length; i++) expect(result[i].from).toBe(result[i - 1].to);
  });

  it("draws nothing for a route without a line", () => {
    expect(routeRuns(1)).toEqual([]);
    expect(routeRuns(0, [[0, 1]], [0, 1])).toEqual([]);
  });
});

describe("chevronMarks", () => {
  it("spaces marks evenly along a straight line, half a step from the ends", () => {
    const marks = chevronMarks([{ x: 0, y: 0 }, { x: 280, y: 0 }], 70);
    expect(marks.map(mark => mark.x)).toEqual([35, 105, 175, 245]);
    expect(marks.every(mark => mark.y === 0 && mark.angleDeg === 0)).toBe(true);
  });

  it("turns each mark along its own segment", () => {
    // East 100 px, then south (screen y grows down) 100 px.
    const marks = chevronMarks([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }], 50);
    expect(marks.map(mark => [mark.x, mark.y, mark.angleDeg])).toEqual([[25, 0, 0], [75, 0, 0], [100, 25, 90], [100, 75, 90]]);
  });

  it("points backwards on a line drawn west", () => {
    expect(chevronMarks([{ x: 100, y: 0 }, { x: 0, y: 0 }], 70)).toEqual([{ x: 50, y: 0, angleDeg: 180 }]);
  });

  it("puts one mark in the middle of a short leg", () => {
    expect(chevronMarks([{ x: 0, y: 0 }, { x: 0, y: -30 }], 70)).toEqual([{ x: 0, y: -15, angleDeg: -90 }]);
  });

  it("skips repeated vertices", () => {
    expect(chevronMarks([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 140, y: 0 }], 70).map(mark => mark.x)).toEqual([35, 105]);
  });

  it("caps the number of marks on a very long leg", () => {
    const marks = chevronMarks([{ x: 0, y: 0 }, { x: 100000, y: 0 }], 70, 200);
    expect(marks).toHaveLength(200);
    expect(marks[1].x - marks[0].x).toBe(500);
  });

  it.each([
    { name: "no points", points: [] },
    { name: "one point", points: [{ x: 5, y: 5 }] },
    { name: "a zero-length leg", points: [{ x: 5, y: 5 }, { x: 5, y: 5 }] },
  ])("draws nothing for $name", ({ points }) => {
    expect(chevronMarks(points)).toEqual([]);
  });
});
