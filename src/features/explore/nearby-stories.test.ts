import { describe, expect, it } from "vitest";
import { nearbyRadiusForAccuracy, nearbyStoryCatalog, recommendNearbyStories, type NearbyStory } from "./nearby-stories";
import type { Route } from "../tour/types";

const catalog: NearbyStory[] = [
  { id: "closer", title: "Ближе", address: "Москва", location: { lat: 55.75, lon: 37.6 }, durationSec: 90, sourceCount: 2, factCount: 3 },
  { id: "better", title: "Подтверждённее", address: "Москва", location: { lat: 55.75072, lon: 37.6 }, durationSec: 90, sourceCount: 4, factCount: 5 },
  { id: "far", title: "Далеко", address: "Москва", location: { lat: 55.753, lon: 37.6 }, durationSec: 90, sourceCount: 9, factCount: 9 },
];

describe("nearby story recommendations", () => {
  it("keeps the exact radius boundary and ranks evidence before distance", () => {
    expect(recommendNearbyStories({ lat: 55.75, lon: 37.6 }, 100, catalog).map((story) => story.id)).toEqual(["better", "closer"]);
    expect(recommendNearbyStories({ lat: 55.75, lon: 37.6 }, 200, catalog).map((story) => story.id)).toEqual(["better", "closer"]);
  });

  it("returns one recommendation and at most two alternatives", () => {
    expect(recommendNearbyStories({ lat: 55.75, lon: 37.6 }, 300, [...catalog, {
      id: "third", title: "Третья", address: "Москва", location: { lat: 55.7515, lon: 37.6 }, durationSec: 90, sourceCount: 1, factCount: 1,
    }])).toHaveLength(3);
  });

  it("only exposes unique, publication-ready POIs", () => {
    const route = {
      pois: [
        { id: "ready", name: "  Готовый объект ", eyebrow: " Москва, адрес ", location: { lat: 55.75, lon: 37.6 }, viewpoint: null, story: { text_status: "ready", duration_sec: 90 }, sources: [{ id: "source" }], facts: [{ confidence: "verified" }] },
        { id: "ready", name: "Дубль", eyebrow: "Москва", location: { lat: 55.75, lon: 37.6 }, viewpoint: null, story: { text_status: "ready", duration_sec: 90 }, sources: [{ id: "source" }], facts: [{ confidence: "verified" }] },
        { id: "draft", name: "Черновик", eyebrow: "Москва", location: { lat: 55.75, lon: 37.6 }, viewpoint: null, story: { text_status: "draft", duration_sec: 90 }, sources: [{ id: "source" }], facts: [{ confidence: "verified" }] },
      ],
    } as unknown as Route;
    expect(nearbyStoryCatalog(route)).toEqual([expect.objectContaining({ id: "ready", title: "Готовый объект", address: "Москва, адрес" })]);
  });

  it.each([
    [5, 100],
    [100, 100],
    [100.5, 200],
    [200, 200],
    [300, 300],
    [301, null],
    [Number.POSITIVE_INFINITY, null],
    [Number.NaN, null],
  ])("covers a position accuracy of %s m with a %s m radius", (accuracyM, radius) => {
    expect(nearbyRadiusForAccuracy(accuracyM)).toBe(radius);
  });
});
