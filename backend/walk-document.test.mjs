import test from "node:test";
import assert from "node:assert/strict";
import { validateWalkDocument, migrateLegacyDraft, validateWalkView, validTunnels } from "./walk-document.mjs";

const point = (lat, lon) => ({ lat, lon });
const place = (address, lat, lon) => ({ address, location: point(lat, lon) });
const start = place("Москва, Арбат, 1", 55.75, 37.60);
const stop = place("Москва, Арбат, 10", 55.751, 37.601);
const id = "11111111-1111-4111-8111-111111111111";
const chapter = "22222222-2222-4222-8222-222222222222";
const walk = () => ({ version: 2, id, title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30,
  start, stops: [{ id: chapter, place: stop, storyRef: null, transition: "", nextHint: "" }],
  route: { geometry: [start.location, stop.location], distanceM: 200, walkingMinutes: 3, attribution: "OSM" }, fieldChecked: false });

test("walk document preserves distinct chapters and real geometry", () => {
  assert.deepEqual(validateWalkDocument(walk()), walk());
  const duplicate = walk(); duplicate.stops.push({ ...duplicate.stops[0] });
  assert.throws(() => validateWalkDocument(duplicate), { code: "BAD_REQUEST" });
  const impossible = walk(); impossible.route.geometry[1] = point(0, 0);
  assert.throws(() => validateWalkDocument(impossible), { code: "BAD_REQUEST" });
});

test("walk documents accept forty stops and reject a forty-first", () => {
  const document = walk();
  document.stops = Array.from({ length: 40 }, (_, index) => ({
    id: `22222222-2222-4222-8222-${String(index + 1).padStart(12, "0")}`,
    place: place(`Москва, Арбат, ${index + 2}`, 55.751 + index * 0.001, 37.601),
    storyRef: null, transition: "", nextHint: "",
  }));
  document.route.geometry = [start.location, ...document.stops.map(item => item.place.location)];
  assert.deepEqual(validateWalkDocument(document), document);
  document.stops.push({ id: "22222222-2222-4222-8222-000000000041", place: place("Москва, Арбат, 42", 55.791, 37.601), storyRef: null, transition: "", nextHint: "" });
  assert.throws(() => validateWalkDocument(document), { code: "BAD_REQUEST" });
});

test("legacy migration keeps a start story only if one was requested and does not repeat a loop start", () => {
  const legacy = { version: 1, title: "Моя прогулка", start, stops: [stop], mode: "loop", minutes: 30,
    route: { stops: [stop], geometry: [start.location, stop.location, start.location], distanceM: 400, walkingMinutes: 6, attribution: "OSM" },
    jobs: [{ place: start, id: chapter, stage: "ready" }] };
  const converted = migrateLegacyDraft(legacy, id);
  assert.equal(converted.stops.length, 2);
  assert.equal(converted.stops[0].storyRef.id, chapter);
  assert.equal(converted.stops[1].storyRef, null);
  assert.deepEqual(migrateLegacyDraft(legacy, id), converted);
});

test("a saved empty draft remains a draft after migration", () => {
  const legacy = { version: 1, title: "Позже", start: null, stops: [], mode: "loop", minutes: 30, route: null, jobs: [], submitting: null };
  const migrated = migrateLegacyDraft(legacy, id);
  assert.equal(migrated.start, null);
  assert.deepEqual(migrated.stops, []);
  assert.equal(migrated.route, null);
  assert.deepEqual(migrateLegacyDraft(legacy, id), migrated);
});

test("a draft with a start but no stops can be saved, while an unbuilt path cannot be played", () => {
  const draft = walk(); draft.stops = []; draft.route = null;
  assert.deepEqual(validateWalkDocument(draft), draft);
  draft.route = walk().route;
  assert.throws(() => validateWalkDocument(draft), { code: "BAD_REQUEST" });
});

test("legacy automatic research retains the start's story without repeating the loop finish", () => {
  const legacy = { version: 1, title: "Прогулка", start, stops: [stop], mode: "loop", minutes: 30, jobs: [{ id: chapter, place: start, stage: "ready" }],
    researchApplied: true, route: { geometry: [start.location, stop.location, start.location], distanceM: 450, walkingMinutes: 6, attribution: "OSM" } };
  const migrated = migrateLegacyDraft(legacy, id);
  assert.equal(migrated.stops[0].storyRef.id, chapter);
  assert.equal(migrated.stops.length, 2);
});

test("public view rejects hidden fields and unrelated chapters", () => {
  const document = walk();
  const view = { document, revision: 0, contentVersion: "1", chapters: [{ id: chapter, status: "preparing", story: null, audio: null }] };
  assert.deepEqual(validateWalkView(view), view);
  assert.throws(() => validateWalkView({ ...view, recoveryToken: "secret" }), { code: "BAD_REQUEST" });
  assert.throws(() => validateWalkView({ ...view, chapters: [] }), { code: "BAD_REQUEST" });
  assert.throws(() => validateWalkView({ ...view, chapters: [{ ...view.chapters[0], story: { recoveryToken: "secret" } }] }), { code: "BAD_REQUEST" });
  assert.throws(() => validateWalkView({ ...view, chapters: [{ ...view.chapters[0], audio: { url: "https://other.example/audio", sha256: "x", durationSec: 1 } }] }), { code: "BAD_REQUEST" });
});

test("long public views preserve chapter order and reject duplicates or swapped chapters", () => {
  const document = walk();
  document.stops = Array.from({ length: 40 }, (_, index) => ({ ...document.stops[0], id: `stop-${index}` }));
  const view = { document, revision: 1, contentVersion: "long-walk", chapters: document.stops.map(item => ({ id: item.id, status: "ready", story: { title: item.id, address: item.place.address, paragraphs: [{ text: "История места.", factIds: [] }], sources: [], facts: [] }, audio: { url: `/audio/walk/${item.id}.mp3`, sha256: "a".repeat(64), durationSec: 60 } })) };
  assert.deepEqual(validateWalkView(view).chapters.map(item => item.id), document.stops.map(item => item.id));
  assert.throws(() => validateWalkView({ ...view, chapters: view.chapters.toReversed() }), { code: "BAD_REQUEST" });
  assert.throws(() => validateWalkView({ ...view, document: { ...document, stops: [...document.stops.slice(0, -1), document.stops[0]] } }), { code: "BAD_REQUEST" });
});

for (const count of [11, 28, 40]) test(`legacy migration preserves ${count} ordered stops`, () => {
  const stops = Array.from({ length: count }, (_, index) => place(`Москва, Арбат, ${index + 2}`, 55.751 + index * 0.001, 37.601));
  const legacy = { version: 1, title: "Арбат", start, stops, mode: "open", minutes: 90, route: null, jobs: [] };
  assert.deepEqual(migrateLegacyDraft(legacy, id).stops.map(item => item.place), stops);
  if (count === 40) {
    assert.throws(() => migrateLegacyDraft({ ...legacy, stops: [...stops, stop] }, id), { code: "BAD_REQUEST" });
    assert.throws(() => migrateLegacyDraft({ ...legacy, jobs: [{ place: start, id: chapter }] }, id), { code: "BAD_REQUEST" });
  }
});

test("route tunnels are sorted, separated ranges of the geometry's vertices", () => {
  const cases = [
    { name: "absent", tunnels: undefined, valid: true },
    { name: "empty", tunnels: [], valid: true },
    { name: "one range", tunnels: [[1, 3]], valid: true },
    { name: "whole route", tunnels: [[0, 9]], valid: true },
    { name: "two separated ranges", tunnels: [[0, 2], [4, 6]], valid: true },
    { name: "a equals b", tunnels: [[2, 2]], valid: false },
    { name: "a after b", tunnels: [[3, 2]], valid: false },
    { name: "negative start", tunnels: [[-1, 2]], valid: false },
    { name: "end past the last vertex", tunnels: [[8, 10]], valid: false },
    { name: "overlapping", tunnels: [[0, 4], [3, 6]], valid: false },
    { name: "touching", tunnels: [[0, 3], [3, 6]], valid: false },
    { name: "unsorted", tunnels: [[4, 6], [0, 2]], valid: false },
    { name: "non-integer", tunnels: [[0.5, 2]], valid: false },
    { name: "three numbers", tunnels: [[0, 1, 2]], valid: false },
    { name: "not an array", tunnels: { 0: [0, 1] }, valid: false },
    { name: "null", tunnels: null, valid: false },
  ];
  for (const item of cases) assert.equal(validTunnels(item.tunnels, 10), item.valid, item.name);
  const many = Array.from({ length: 501 }, (_, index) => [index * 2, index * 2 + 1]);
  assert.equal(validTunnels(many.slice(0, 500), 1100), true);
  assert.equal(validTunnels(many, 1100), false);
});

test("a document keeps its route tunnels, and migration carries them over", () => {
  const document = walk(); document.route.tunnels = [[0, 1]];
  assert.deepEqual(validateWalkDocument(document), document);
  const broken = walk(); broken.route.tunnels = [[0, 2]];
  assert.throws(() => validateWalkDocument(broken), { code: "BAD_REQUEST" });
  const legacy = { version: 1, title: "Тоннель", start, stops: [stop], mode: "open", minutes: 30,
    route: { stops: [stop], geometry: [start.location, stop.location], distanceM: 200, walkingMinutes: 3, attribution: "OSM", tunnels: [[0, 1]] }, jobs: [] };
  assert.deepEqual(migrateLegacyDraft(legacy, id).route.tunnels, [[0, 1]]);
  assert.equal("tunnels" in migrateLegacyDraft({ ...legacy, route: { ...legacy.route, tunnels: undefined } }, id).route, false);
});
