import test from "node:test";
import assert from "node:assert/strict";
import { planToWalkDocument } from "./walk-plan-document.mjs";
import { validateWalkDocument } from "./walk-document.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const start = { address: "метро «Чистые пруды»", location: { lat: 55.765, lon: 37.6386 } };
const plan = stops => ({ stops, geometry: [{ lat: 55.765, lon: 37.6386 }, { lat: 55.766, lon: 37.64 }], distanceM: 1800, walkingMinutes: 28, attribution: "© OpenStreetMap contributors" });
const options = mode => ({ id, title: "Прогулка", description: "", mode, minutes: 30, start });

test("planner results become valid walk documents", () => {
  const cases = [
    { name: "published place links an OSM story", stop: { address: "Мясницкая, 17", location: { lat: 55.764, lon: 37.636 }, contentId: "osm:way:42" }, storyRef: { kind: "osm", id: "osm:way:42" }, address: "Мясницкая, 17", mode: "loop" },
    { name: "place without content has no story", stop: { address: "Сретенский бульвар", location: { lat: 55.766, lon: 37.637 } }, storyRef: null, address: "Сретенский бульвар", mode: "open" },
    { name: "180-character address is kept", stop: { address: "а".repeat(180), location: { lat: 55.764, lon: 37.636 } }, storyRef: null, address: "а".repeat(180), mode: "loop" },
    { name: "240-character address is truncated", stop: { address: "б".repeat(240), location: { lat: 55.764, lon: 37.636 } }, storyRef: null, address: `${"б".repeat(179)}…`, mode: "loop" },
  ];
  for (const item of cases) {
    const document = planToWalkDocument(plan([item.stop]), options(item.mode));
    assert.deepEqual(validateWalkDocument(document), document, item.name);
    assert.equal(document.mode, item.mode, item.name);
    assert.deepEqual(document.stops[0], { id: `${id}-stop-0`, place: { address: item.address, location: item.stop.location }, storyRef: item.storyRef, transition: "", nextHint: "" }, item.name);
    assert.deepEqual(document.route, { geometry: plan([]).geometry, distanceM: 1800, walkingMinutes: 28, attribution: "© OpenStreetMap contributors" }, item.name);
    assert.deepEqual(document.start, start, item.name);
    assert.equal(document.fieldChecked, false, item.name);
  }
});

test("a plan that breaks the document contract is rejected", () => {
  assert.throws(() => planToWalkDocument({ ...plan([]), distanceM: 9000 }, options("loop")), error => error instanceof Error && !("code" in error) && /walk document contract/.test(error.message));
});

test("planner tunnels are carried into the document, and their absence leaves no key", () => {
  const stop = { address: "Мясницкая, 17", location: { lat: 55.764, lon: 37.636 } };
  const document = planToWalkDocument({ ...plan([stop]), tunnels: [[0, 1]] }, options("loop"));
  assert.deepEqual(document.route.tunnels, [[0, 1]]);
  assert.equal("tunnels" in planToWalkDocument(plan([stop]), options("loop")).route, false);
});
