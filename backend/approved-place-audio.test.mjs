import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { hasValidStoryText } from "./admin.mjs";

const placeId = "osm:node:42";
const story = (words, profile = "story-v1") => ({
  title: "Площадь Пречистенские Ворота", effectiveProfile: profile,
  paragraphs: [{ text: Array.from({ length: words }, (_, index) => index % 2 ? "история" : "площади").join(" "), factIds: [] }],
  sources: [], facts: [],
});
function fixture(t, text, approved = true, options = {}) {
  const store = createStore(":memory:", options);
  t.after(() => store.close());
  store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), rulesVersion: "v1", coverage: "fixture",
    places: [{ placeId, osmType: "node", osmId: 42, name: "Площадь", location: { lat: 55.75, lon: 37.61 }, tags: {} }] });
  store.createBatch({ requestKey: "approved-audio-text", placeIds: [placeId], limit: 1, mode: "text-only" });
  const content = store.claimContentJob();
  const result = store.completeContentJob(content.id, { story: text, evidence: {}, autoApprove: approved });
  const input = { sourceJobId: `place-text:${result.id}`, sourceRevision: 0, story: { ...text, address: "Москва, Площадь" } };
  return { store, input };
}

for (const { words, profile } of [{ words: 91, profile: "story-v1" }, { words: 113, profile: "description-v1" }]) {
  test(`approved ${profile} with ${words} words is voiced without changing its text or profile`, async t => {
    const text = story(words, profile);
    assert.equal(hasValidStoryText(text), false);
    const { store, input } = fixture(t, text);
    const before = store.getPublishedPlace(placeId).text;
    const queued = await store.enqueueExternalAudio(input);
    const claim = store.claimExternalAudio({ workerId: "audio-test", requestId: "approved-audio-1", profileIds: [queued.profileId] });
    assert.equal(claim.spokenText, text.paragraphs[0].text);
    const artifact = { url: `/api/story-audio/${"b".repeat(64)}.mp3`, sha256: "b".repeat(64), durationSec: 50 };
    assert.equal(store.acceptExternalAudio(queued.id, { workerId: "audio-test", generation: claim.leaseGeneration, leaseToken: claim.leaseToken,
      uploadId: "approved-upload-1", uploadSha256: artifact.sha256, artifact }).state, "succeeded");
    const after = store.getPublishedPlace(placeId).text;
    assert.deepEqual(after, { ...before, audio: artifact });
    assert.equal((await store.enqueueExternalAudio(input)).id, queued.id);
  });
}

test("catalog audio requires the exact published text before normalization", async t => {
  const { store, input } = fixture(t, story(91));
  await assert.rejects(store.enqueueExternalAudio({ ...input, story: story(92) }), { code: "BAD_REQUEST" });
  await assert.rejects(store.enqueueExternalAudio({ ...input, sourceJobId: "place-text:missing" }), { code: "BAD_REQUEST" });
  assert.deepEqual(store.getExternalAudioStats().states, {});
});

test("an unpublished catalog text cannot use the approved-text path", async t => {
  const { store, input } = fixture(t, story(91), false);
  await assert.rejects(store.enqueueExternalAudio(input), { code: "BAD_REQUEST" });
  assert.deepEqual(store.getExternalAudioStats().states, {});
});

for (const invalid of [
  { ...story(91), title: " " },
  { ...story(91), title: "я".repeat(181) },
  { ...story(91), paragraphs: [] },
  { ...story(91), paragraphs: [{ text: null }] },
  { ...story(91), paragraphs: [{ text: " " }] },
  { ...story(91), paragraphs: [{ text: "я".repeat(6001) }] },
  { ...story(91), paragraphs: [{ text: "<script>unsafe</script>" }] },
  { ...story(91), paragraphs: [{ text: "Текст\u0000" }] },
  { ...story(91), paragraphs: Array.from({ length: 101 }, () => ({ text: "Место" })) },
  { ...story(91), paragraphs: Array.from({ length: 20 }, () => ({ text: "я".repeat(6000) })) },
]) test("malformed approved catalog text cannot reach speech synthesis", async t => {
  const { store, input } = fixture(t, invalid);
  await assert.rejects(store.enqueueExternalAudio(input), { code: "BAD_REQUEST" });
  assert.deepEqual(store.getExternalAudioStats().states, {});
});

test("generated jobs still enforce their story profile even with editorial metadata", async t => {
  const { store } = fixture(t, story(91));
  const source = store.createOrGet({ key: "generated-story", address: "Москва, Площадь" });
  const text = { ...story(91), verification: "editorial" };
  const saved = store.update(source.id, { stage: "failed", data: { story: text } }, source.revision);
  await assert.rejects(store.enqueueExternalAudio({ sourceJobId: source.id, sourceRevision: saved.revision, story: text }), { code: "BAD_REQUEST" });
});

test("an editorial change during normalization prevents queuing the superseded text", async t => {
  const { promise: waiting, resolve: release } = Promise.withResolvers();
  const { store, input } = fixture(t, story(91), true, { normalizeExternalText: async text => { await waiting; return text; } });
  const enqueuing = store.enqueueExternalAudio(input);
  const rejected = assert.rejects(enqueuing, { code: "CONFLICT" });
  const edited = store.approvePlaceText(placeId, story(92));
  assert.notEqual(`place-text:${edited.text.id}`, input.sourceJobId);
  release(undefined);
  await rejected;
  assert.deepEqual(store.getExternalAudioStats().states, {});
  assert.equal(store.getPublishedPlace(placeId).text.audio, null);
  assert.deepEqual(store.getPublishedPlace(placeId).text.story, story(92));
  await assert.rejects(store.enqueueExternalAudio(input), { code: "BAD_REQUEST" });
});
