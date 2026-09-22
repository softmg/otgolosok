import { describe, expect, it } from "vitest";
import routeData from "../../../public/data/routes/paveletskaya.json";
import { getWalkChapters } from "../tour/walk-plan";
import type { Route } from "../tour/types";
import { draftToWalkDocument, routeToWalkView, walkDocumentToDraft, walkViewToRoute } from "./adapters";
import type { Draft } from "../walk-builder/model";

const start = { address: "Москва, Арбат, 1", location: { lat: 55.7521, lon: 37.5935 } };
const firstStop = { address: "Москва, Арбат, 3", location: { lat: 55.7523, lon: 37.594 } };
const secondStop = { address: "Москва, Арбат, 5", location: { lat: 55.7525, lon: 37.5945 } };
const jobId = "11111111-1111-4111-8111-111111111111";

function draft(stops = [firstStop, secondStop]): Draft {
  return {
    version: 1,
    title: "Арбат",
    start,
    mode: "open",
    minutes: 30,
    stops,
    route: null,
    jobs: [{ id: jobId, place: start, stage: "ready" }],
    submitting: null,
  };
}

describe("universal walk adapters", () => {
  it("keeps a start story separate and preserves stop identities after reordering", () => {
    const id = "22222222-2222-4222-8222-222222222222";
    const initial = draftToWalkDocument(draft(), id);
    expect(initial.stops.map(stop => stop.place.address)).toEqual([start.address, firstStop.address, secondStop.address]);
    const ids = new Map(initial.stops.map(stop => [stop.place.address, stop.id]));
    const reordered = draftToWalkDocument(draft([secondStop, firstStop]), id, initial);
    expect(reordered.stops.map(stop => stop.place.address)).toEqual([start.address, secondStop.address, firstStop.address]);
    expect(reordered.stops.map(stop => stop.id)).toEqual([ids.get(start.address), ids.get(secondStop.address), ids.get(firstStop.address)]);

    const restored = walkDocumentToDraft(reordered);
    expect(restored.start).toEqual(start);
    expect(restored.stops).toEqual([secondStop, firstStop]);
    expect(restored.jobs[0].id).toBe(jobId);
  });

  it("keeps a partially prepared stop visible without inventing audio", () => {
    const document = draftToWalkDocument(draft([firstStop]), "33333333-3333-4333-8333-333333333333");
    const view = {
      document,
      revision: 1,
      contentVersion: "pending-1",
      chapters: document.stops.map(stop => ({ id: stop.id, status: "preparing" as const, story: null, audio: null })),
    };
    const route = walkViewToRoute(view);
    expect(getWalkChapters(route)).toHaveLength(0);
    const chapters = getWalkChapters(route, true);
    expect(chapters).toHaveLength(2);
    expect(chapters.every(chapter => !chapter.audio)).toBe(true);
    expect(chapters.map(chapter => chapter.status)).toEqual(["preparing", "preparing"]);
  });

  it("links a published OSM story selected by the route planner", () => {
    const contentStop = { ...firstStop, contentId: "osm:way:42" };
    const document = draftToWalkDocument(draft([contentStop]), "44444444-4444-4444-8444-444444444444");
    expect(document.stops.at(-1)?.storyRef).toEqual({ kind: "osm", id: "osm:way:42" });
    expect(walkDocumentToDraft(document).stops[0]).toEqual(contentStop);
  });

  it("round-trips the bundled catalogue through the universal view", () => {
    const view = routeToWalkView(routeData as Route);
    expect(view.document.stops).toHaveLength(4);
    expect(view.chapters.every(chapter => chapter.status === "ready")).toBe(true);
    expect(view.chapters.every(chapter => chapter.audio?.sha256)).toBe(true);
    expect(view.document.stops.at(-1)?.place.address).toBe("Дербеневская набережная, 7с22");
    const route = walkViewToRoute(view);
    expect(getWalkChapters(route, true).map(chapter => chapter.id)).toEqual(["kozhevniki", "derbenevskaya", "housing", "zindel"]);
    expect(route.walk?.path.coordinates.length).toBeGreaterThan(20);
  });
});
