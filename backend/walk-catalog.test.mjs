import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { catalogWalkView } from "./walk-catalog.mjs";

test("catalogue adapter preserves the four published chapters and recordings", () => {
  const route = JSON.parse(readFileSync(new URL("../public/data/routes/paveletskaya.json", import.meta.url), "utf8"));
  const view = catalogWalkView(route);
  assert.deepEqual(view.chapters.map(chapter => chapter.id), route.walk.steps.map(step => step.id));
  assert.deepEqual(view.chapters.map(chapter => chapter.audio?.url), route.walk.steps.map(step => step.audio.url));
  assert.equal(view.document.route.geometry.length, route.walk.path.coordinates.length);
  assert.ok(view.chapters.every(chapter => chapter.story?.sources.length));
});
