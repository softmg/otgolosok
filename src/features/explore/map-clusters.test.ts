// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Leaflet from "leaflet";
import { clusterRadius, createMapClusters, loadMapLibrary, type MapClusters } from "./map-clusters";

describe("clusterRadius", () => {
  it.each([
    [10, 120], [11, 120], [12, 100], [13, 90], [14, 80], [15, 64], [16, 52], [19, 52],
  ])("zoom %i → %i px", (zoom, radius) => expect(clusterRadius(zoom)).toBe(radius));

  it("never grows when zooming in", () => {
    for (let zoom = 10; zoom < 19; zoom += 1) expect(clusterRadius(zoom + 1)).toBeLessThanOrEqual(clusterRadius(zoom));
  });
});

describe("createMapClusters", () => {
  let L: typeof Leaflet;
  let map: Leaflet.Map;
  let clusters: MapClusters;
  let element: HTMLDivElement;
  // Every clock read advances past the frame budget, so each task adds exactly one batch.
  let time = 0;
  const now = () => (time += 10);
  const markers = (count: number, lat = 55.75) =>
    Array.from({ length: count }, (_, index) => L.marker([lat, 37.6 + index * 0.001]));
  const added = () => clusters.group.getLayers().length;

  beforeEach(async () => {
    vi.useFakeTimers();
    L = await loadMapLibrary();
    element = document.createElement("div");
    document.body.append(element);
    map = L.map(element, { minZoom: 10, maxZoom: 19 }).setView([55.75, 37.6], 14);
    clusters = createMapClusters(L, { className: "cluster", spiderLegColor: "#000" }, { now }).addTo(map);
  });
  afterEach(() => {
    clusters.dispose();
    map.remove();
    element.remove();
    vi.useRealTimers();
  });

  it("adds a small update at once", () => {
    clusters.addLayers(markers(3));
    expect(added()).toBe(3);
  });

  it("spreads a large catalog over several tasks and adds every marker once", () => {
    clusters.addLayers(markers(1000));
    expect(added()).toBe(200);
    vi.advanceTimersByTime(0);
    expect(added()).toBe(400);
    vi.runAllTimers();
    expect(added()).toBe(1000);
  });

  it("drops a queued marker removed before its batch, so no ghost pin appears later", () => {
    const all = markers(500);
    clusters.addLayers(all);
    const waiting = all[450];
    clusters.removeLayer(waiting);
    vi.runAllTimers();
    expect(added()).toBe(499);
    expect(clusters.group.hasLayer(waiting)).toBe(false);
  });

  it("removes an already clustered marker from the group", () => {
    const all = markers(3);
    clusters.addLayers(all);
    clusters.removeLayer(all[0]);
    expect(clusters.group.hasLayer(all[0])).toBe(false);
    expect(added()).toBe(2);
  });

  it("re-adds a marker that was taken out of the queue (a pin deselected during loading)", () => {
    const all = markers(500);
    clusters.addLayers(all);
    clusters.removeLayer(all[450]);
    clusters.addLayers([all[450]]);
    vi.runAllTimers();
    expect(added()).toBe(500);
  });

  it("stops pending additions on dispose", () => {
    clusters.addLayers(markers(1000));
    clusters.dispose();
    vi.runAllTimers();
    expect(added()).toBe(200);
  });
});
