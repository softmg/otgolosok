import test from "node:test";
import assert from "node:assert/strict";
import { cellKey, cellOf, etagOf, serializeCell, toMapPoint } from "./map-cells.mjs";

for (const { lat, lon, key } of [
  { lat: 55.75, lon: 37.62, key: "55:37" }, { lat: -0.5, lon: -0.5, key: "-1:-1" }, { lat: 56, lon: 38, key: "56:38" },
  { lat: 90, lon: 180, key: "89:179" }, { lat: -90, lon: -180, key: "-90:-180" }, { lat: 0, lon: 0, key: "0:0" },
]) {
  test(`cellOf(${lat}, ${lon}) is ${key}`, () => assert.equal(cellKey(cellOf(lat, lon)), key));
}

const row = { id: "osm:node:1", name: "Сад", address: null, lat: 55.7512345678, lon: 37.6198765432 };
/** @type {Array<[string, Record<string, unknown>, Record<string, unknown>]>} */
const fallbacks = [
  ["no title falls back to the name", {}, { title: "Сад" }],
  ["blank title falls back to the name", { title: "  " }, { title: "Сад" }],
  ["title wins", { title: "История сада" }, { title: "История сада" }],
  ["no address falls back to the name", {}, { address: "Сад" }],
  ["address wins", { address: "Москва, Сад" }, { address: "Москва, Сад" }],
  ["zero duration is no audio", { durationSec: 0 }, { durationSec: null }],
  ["negative duration is no audio", { durationSec: -5 }, { durationSec: null }],
  ["NaN duration is no audio", { durationSec: Number.NaN }, { durationSec: null }],
  ["positive duration is kept", { durationSec: 61.5 }, { durationSec: 61.5 }],
  ["missing counts are zero", {}, { facts: 0, sources: 0 }],
  ["negative or fractional counts are zero", { facts: -1, sources: 1.5 }, { facts: 0, sources: 0 }],
  ["counts are kept", { facts: 3, sources: 2 }, { facts: 3, sources: 2 }],
];
for (const [name, input, expected] of fallbacks) {
  test(`toMapPoint: ${name}`, () => {
    const point = toMapPoint({ ...row, ...input });
    for (const [key, value] of Object.entries(expected)) assert.equal(point[key], value);
    assert.equal(point.lat, 55.75123);
    assert.equal(point.lon, 37.61988);
  });
}

test("serializeCell is independent of input order and its ETag is stable", () => {
  const a = toMapPoint({ ...row, id: "osm:node:2" }), b = toMapPoint(row), c = toMapPoint({ ...row, id: "osm:way:1" });
  const body = serializeCell({ lat: 55, lon: 37 }, [a, c, b]);
  assert.equal(body, serializeCell({ lat: 55, lon: 37 }, [c, b, a]));
  assert.deepEqual(JSON.parse(body).points.map(point => point.id), ["osm:node:1", "osm:node:2", "osm:way:1"]);
  assert.equal(etagOf(body), etagOf(serializeCell({ lat: 55, lon: 37 }, [b, a, c])));
  assert.match(etagOf(body), /^[0-9a-f]{32}$/);
  assert.notEqual(etagOf(body), etagOf(serializeCell({ lat: 55, lon: 37 }, [a, b])));
});
