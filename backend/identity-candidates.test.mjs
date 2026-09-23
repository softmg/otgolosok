import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { buildIdentityCandidates } from "./identity-triage.mjs";
import { runContentJob } from "./content-pipeline.mjs";

const point = { lat: 55.75, lon: 37.61 };
const osm = (id, name, tags) => ({ placeId: `osm:node:${id}`, osmType: "node", osmId: id, name, location: point, tags: { name, ...tags } });
const places = [
  osm(1, "Музей-квартира Александра Солженицына", { tourism: "museum" }),
  osm(2, "Московский музей образования", { tourism: "museum" }),
  osm(3, "Российский музей медицины", { tourism: "museum" }),
  osm(4, "Василий Прокофьевич Ефанов", { historic: "memorial" }),
  osm(5, "Дом-музей Зураба Церетели", { tourism: "museum" }),
  osm(6, "В. И. Ленину", { historic: "memorial" }),
  osm(7, "Памятник с идентификатором", { historic: "memorial", wikidata: "Q7" }),
];
const catalog = { source: "fixture", sourceSha256: "a".repeat(64), rulesVersion: "v1", coverage: "fixture", places };
const inside = { status: "matched", containingBuilding: { address: "Москва, Тверская улица, 12 с8", relation: "point_in_building" },
  nearbyAddresses: [], street: { name: "Тверская улица", distanceMeters: 20 }, district: { name: "Тверской район" } };
const streetOnly = { status: "matched", containingBuilding: null, nearbyAddresses: [], street: { name: "Тверская улица", distanceMeters: 20 }, district: { name: "Тверской район" } };
// Places 5 and 6 have no addressed building around the point; the rest sit inside one.
const resolveLocation = place => ["osm:node:5", "osm:node:6"].includes(place.id) ? streetOnly : inside;

function assessed(store) {
  const active = store.listPlaces({ limit: 100 }).places.map(place => ({ ...place, contentHash: place.contentHash }));
  return store.replaceIdentityCandidates(buildIdentityCandidates(active, { resolveLocation }));
}

function fixture(t) {
  const store = createStore(":memory:", { maxDaily: 100, maxActive: 100 });
  t.after(() => store.close());
  store.importPlaces(catalog);
  return store;
}

test("assessment stores tiers for weak places only and replaces the previous run", t => {
  const store = fixture(t);
  const first = assessed(store);
  assert.equal(first.total, 6);
  assert.deepEqual(first.tiers, { auto: 4, enrich: 1, manual: 1 });
  const page = store.listIdentityCandidates();
  assert.equal(page.total, 6);
  assert.equal(page.stale, 0);
  assert.equal(page.items[0].score >= page.items.at(-1).score, true);
  assert.ok(!page.items.some(item => item.placeId === "osm:node:7"));
  const museum = page.items.find(item => item.placeId === "osm:node:1");
  assert.equal(museum.tier, "auto");
  assert.ok(museum.signals.includes("inside_address_building"));
  assert.equal(museum.location.building.address, "Москва, Тверская улица, 12 с8");
  assert.equal(museum.job, null);
  assert.equal(assessed(store).total, 6, "a repeated run keeps one row per place");
});

test("candidate list filters by tier, category, name and queue state", t => {
  const store = fixture(t);
  assessed(store);
  assert.deepEqual(store.listIdentityCandidates({ tier: "manual" }).items.map(item => item.placeId), ["osm:node:6"]);
  const museums = store.listIdentityCandidates({ tier: "auto", category: "tourism:museum" });
  assert.equal(museums.total, 3);
  assert.deepEqual(museums.categories, [{ category: "tourism:museum", count: 3 }, { category: "historic:memorial", count: 1 }]);
  assert.equal(store.listIdentityCandidates({ q: "медицин" }).items[0].placeId, "osm:node:3");
  const page = store.listIdentityCandidates({ limit: 2, offset: 2 });
  assert.equal(page.items.length, 2);
  assert.equal(page.hasMore, true);
  for (const bad of [{ tier: "maybe" }, { category: "DROP TABLE" }, { limit: 101 }, { offset: -1 }, { queue: "done" }, { q: "x".repeat(201) }])
    assert.throws(() => store.listIdentityCandidates(bad), { code: "BAD_REQUEST" }, JSON.stringify(bad));
});

test("a changed place makes its assessment stale until the next run", t => {
  const store = fixture(t);
  assessed(store);
  store.importPlaces({ ...catalog, places: [{ ...places[0], tags: { ...places[0].tags, tourism: "gallery" } }] });
  const page = store.listIdentityCandidates();
  assert.equal(page.stale, 1);
  assert.equal(page.total, 5);
  assert.equal(page.tiers.auto, 3);
  assessed(store);
  assert.equal(store.listIdentityCandidates().stale, 0);
});

test("pilot takes auto candidates across categories, is paused and idempotent", t => {
  const store = fixture(t);
  assessed(store);
  const { batch, created } = store.createIdentityPilot({ requestKey: "identity-pilot-1", limit: 2 });
  assert.equal(created, true);
  assert.equal(batch.state, "paused");
  assert.equal(batch.identityPolicy, "weak_identity");
  const ids = store.getBatch(batch.id).items.map(item => item.placeId).sort();
  assert.equal(ids.length, 2);
  assert.ok(ids.includes("osm:node:4"), "the memorial category gets its turn before a third museum");
  assert.equal(store.claimContentJob(), null, "a paused pilot spends nothing");

  store.setBatchState(batch.id, "running");
  const repeated = store.createIdentityPilot({ requestKey: "identity-pilot-1", limit: 2 });
  assert.equal(repeated.created, false);
  assert.equal(repeated.batch.id, batch.id);
  assert.equal(repeated.batch.state, "running", "a repeated request does not pause a started pilot");

  const next = store.createIdentityPilot({ requestKey: "identity-pilot-2", limit: 50 });
  const nextIds = store.getBatch(next.batch.id).items.map(item => item.placeId);
  assert.equal(nextIds.length, 2);
  assert.ok(nextIds.every(id => !ids.includes(id)), "queued places are not selected twice");
  assert.ok(nextIds.every(id => !["osm:node:5", "osm:node:6", "osm:node:7"].includes(id)), "only auto candidates");
  assert.throws(() => store.createIdentityPilot({ requestKey: "identity-pilot-3", limit: 5 }), { code: "NO_IDENTITY_CANDIDATES" });
  assert.equal(store.listIdentityCandidates({ queue: "queued" }).total, 4);
  assert.equal(store.listIdentityCandidates({ queue: "queued" }).items[0].job.identityPolicy, "weak_identity");
});

test("pilot input is bounded", t => {
  const store = fixture(t);
  assessed(store);
  for (const input of [{ requestKey: "short", limit: 1 }, { requestKey: "identity-pilot-x", limit: 51 }, { requestKey: "identity-pilot-y", limit: 0 },
    { requestKey: "identity-pilot-z", limit: 1, mode: "audio-only" }])
    assert.throws(() => store.createIdentityPilot(input), { code: "BAD_REQUEST" }, JSON.stringify(input));
  assert.equal(store.listBatches().length, 0);
});

test("weak identity jobs are never auto-approved and tighten a shared unfinished job", t => {
  const store = fixture(t);
  assessed(store);
  const regular = store.createBatch({ requestKey: "regular-batch", placeIds: ["osm:node:1"], limit: 1 });
  const pilot = store.createBatch({ requestKey: "weak-batch-1", placeIds: ["osm:node:1"], limit: 1, identityPolicy: "weak_identity" });
  assert.equal(regular.identityPolicy, "standard");
  assert.equal(pilot.identityPolicy, "weak_identity");
  const job = store.claimContentJob();
  assert.equal(job.identityPolicy, "weak_identity");
  const story = { title: "Музей", paragraphs: [{ text: "Текст", factIds: ["f1"] }] };
  const completed = store.completeContentJob(job.id, { story, evidence: { facts: [] }, autoApprove: true });
  assert.deepEqual(completed.audioProfiles, []);
  assert.equal(store.getPlace("osm:node:1").text.story, null, "published only after an editor approves");
  assert.equal(store.getPlace("osm:node:1").text.draft.title, "Музей");
  assert.throws(() => store.createBatch({ requestKey: "weak-batch-2", placeIds: ["osm:node:2"], limit: 1, identityPolicy: "loose" }), { code: "BAD_REQUEST" });
});

const page = "Музей-квартира Александра Солженицына открыта на Тверской улице в доме, где жил писатель. ".repeat(6);
const quote = "Музей-квартира Александра Солженицына открыта на Тверской улице в доме, где жил писатель.";
function pipelineProvider(facts) {
  const text = "Музей-квартира открыта в доме, где жил писатель, и рассказывает о его работе. ".repeat(4).trim();
  const queue = [
    { text: "Найден источник", sources: [{ url: "https://one.example/museum", title: "Музей" }] },
    { value: { addressConfirmed: true, identityNote: "Источник описывает музей", placeName: "Музей-квартира Александра Солженицына", resolvedAddress: "Москва", facts } },
    { text: `${text}\n\n${text}` },
    { value: { approved: true, issues: [], checks: { substantive: true, subjectAligned: true, audioClear: true },
      paragraphFacts: [{ paragraph: 1, factIds: ["f1", "f2"] }, { paragraph: 2, factIds: ["f2"] }],
      claims: [{ paragraph: 1, text: "Музей-квартира открыта", factIds: ["f1"], supported: true, address: false },
        { paragraph: 2, text: "Музей-квартира открыта", factIds: ["f2"], supported: true, address: false }] } },
  ];
  return { queue, provider: { writerModel: "writer", response: async () => ({ usage: { total_tokens: 1 }, ...queue.shift() }) } };
}
const fact = (kind, subjectRelation) => ({ claim: `Факт ${kind} ${subjectRelation}`, kind, subjectRelation, contentReason: "Объясняет историю музея",
  topic: "place_history", scope: subjectRelation === "nearby" ? "nearby" : "building", location: "Музей", distanceMeters: subjectRelation === "nearby" ? 100 : null,
  evidence: [{ sourceId: "s1", quote }] });

test("pilot job keeps object facts, stays a draft and is not voiced even with auto approval", async t => {
  const store = fixture(t);
  assessed(store);
  store.createBatch({ requestKey: "weak-pipeline-1", placeIds: ["osm:node:1"], limit: 1, mode: "text-and-audio", ttsProfile: "silero-ru-v1", identityPolicy: "weak_identity" });
  const { provider, queue } = pipelineProvider([fact("identity", "object"), fact("content", "object"), fact("content", "nearby")]);
  const result = await runContentJob(store.claimContentJob(), { store, provider, autoApprove: true,
    fetchPage: async url => ({ url, contentType: "text/html", html: page }) });
  assert.equal(queue.length, 0);
  assert.deepEqual(result.story.facts.map(item => item.claim), ["Факт identity object", "Факт content object"]);
  assert.equal(store.getPlace("osm:node:1").text.story, null);
  assert.equal(store.claimExternalAudio({ workerId: "gpu", requestId: "audio-request-weak", profileIds: ["silero-ru-v1"] }), null);
});

test("pilot job without a source naming the object goes to review before writing", async t => {
  const store = fixture(t);
  assessed(store);
  store.createBatch({ requestKey: "weak-pipeline-2", placeIds: ["osm:node:1"], limit: 1, identityPolicy: "weak_identity" });
  const { provider, queue } = pipelineProvider([fact("content", "object")]);
  const result = await runContentJob(store.claimContentJob(), { store, provider, autoApprove: true,
    fetchPage: async url => ({ url, contentType: "text/html", html: page }) });
  assert.equal(result.state, "review_required");
  assert.equal(result.error.code, "IDENTITY_UNCONFIRMED");
  assert.match(result.error.message, /вручную/);
  assert.equal(queue.length, 2, "the writer and the reviewer are not paid for");
  assert.equal(store.getPlace("osm:node:1").text, null);
});
