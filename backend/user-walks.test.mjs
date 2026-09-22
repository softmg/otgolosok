import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { resolveWalkView } from "./user-walks.mjs";
import { validateWalkDocument } from "./walk-document.mjs";
import { catalogWalkView } from "./walk-catalog.mjs";

const id = "11111111-1111-4111-8111-111111111111";
const first = "22222222-2222-4222-8222-222222222222";
const second = "33333333-3333-4333-8333-333333333333";
const p = (address, lat, lon) => ({ address, location: { lat, lon } });
const a = p("Москва, Арбат, 1", 55.75, 37.60);
const b = p("Москва, Арбат, 10", 55.751, 37.601);
const c = p("Москва, Арбат, 20", 55.752, 37.602);

test("the same document produces an ordered partially ready view without exposing private job data", () => {
  const store = createStore(":memory:");
  try {
    const job = store.createOrGet({ key: "one", address: b.address });
    const document = validateWalkDocument({ version: 2, id, title: "Арбат", description: "", city: "Москва", mode: "open", minutes: 30, start: a,
      stops: [{ id: first, place: b, storyRef: { kind: "job", id: job.id }, transition: "", nextHint: "" },
        { id: second, place: c, storyRef: null, transition: "", nextHint: "" }],
      route: { geometry: [a.location, b.location, c.location], distanceM: 330, walkingMinutes: 4, attribution: "OSM" }, fieldChecked: false });
    const view = resolveWalkView(document, 0, store);
    assert.deepEqual(view.chapters.map(item => item.id), [first, second]);
    assert.deepEqual(view.chapters.map(item => item.status), ["preparing", "not_requested"]);
    assert.equal(JSON.stringify(view).includes(job.key), false);
    assert.equal(JSON.stringify(view).includes("recoveryToken"), false);
  } finally { store.close(); }
});

test("a catalog chapter reference resolves through the current editorial publication", () => {
  const store = createStore(":memory:");
  try {
    const route = store.getPublishedWalk("msk-kozhevniki-zindel-short");
    assert.ok(route);
    const document = catalogWalkView(route).document;
    const view = resolveWalkView(document, 3, store);
    assert.equal(view.chapters.length, route.walk.steps.length);
    assert.equal(view.chapters[0].status, "ready");
    assert.ok(view.chapters[0].story?.sources.length);
  } finally { store.close(); }
});
