import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createStore } from "./store.mjs";

const profileId = "elevenlabs-v3";
const placeId = "osm:node:42";
const story = { title: "Дом", effectiveProfile: "description-v1", paragraphs: [{ text: "История московского дома и его жителей. ".repeat(15).trim(), factIds: [] }], sources: [], facts: [] };
const profile = (model = "v3", speaker = "narrator") => ({ engine: "elevenlabs", model, speaker, maximumPublicationDurationSec: 300 });
function fixture(t, { generated = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "published-audio-"));
  const file = join(directory, "fixture.sqlite");
  /** @type {ReturnType<typeof createStore>} */
  let store;
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const open = (model = "v3", speaker = "narrator", extra = {}) => {
    store?.close();
    store = createStore(file, { workerLeaseSecret: "fixture", externalTtsProfiles: { [profileId]: profile(model, speaker) }, ...extra });
    return store;
  };
  open();
  let input;
  if (generated) {
    const source = store.createOrGet({ key: "generated", address: "Москва, дом" });
    const saved = store.update(source.id, { stage: "failed", data: { story } }, source.revision);
    input = { sourceJobId: saved.id, sourceRevision: saved.revision, story, profileId };
  } else {
    store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), rulesVersion: "v1", coverage: "fixture", places: [{ placeId, osmType: "node", osmId: 42, name: "Дом", location: { lat: 55.75, lon: 37.61 }, tags: {} }] });
    store.createBatch({ requestKey: "fixture-published", placeIds: [placeId], limit: 1, mode: "text-only" });
    const content = store.claimContentJob();
    const text = store.completeContentJob(content.id, { story, evidence: {}, autoApprove: true });
    input = { sourceJobId: `place-text:${text.id}`, sourceRevision: 0, story, profileId };
  }
  const published = () => generated ? store.get(input.sourceJobId).data.audio : store.getPublishedPlace(placeId).text.audio;
  const publish = (job, hash = "b") => {
    const claim = store.claimExternalAudio({ workerId: "fixture", requestId: randomUUID(), profileIds: [profileId] });
    assert.equal(claim.id, job.id);
    const artifact = { url: `/api/story-audio/${hash.repeat(64)}.mp3`, sha256: hash.repeat(64), bytes: 100, durationSec: 60, provider: "elevenlabs", voice: claim.profile.speaker, model: claim.profile.model, synthetic: true };
    store.acceptExternalAudio(job.id, { workerId: "fixture", generation: claim.leaseGeneration, leaseToken: claim.leaseToken, uploadId: randomUUID(), uploadSha256: artifact.sha256, artifact });
    if (generated) input.sourceRevision = store.get(input.sourceJobId).revision;
    return artifact;
  };
  const mutate = fn => { const db = new DatabaseSync(file); try { fn(db); } finally { db.close(); } };
  return { get store() { return store; }, input, open, publish, published, mutate };
}

for (const generated of [false, true]) test(`published ElevenLabs audio survives model changes and restart (${generated ? "generated" : "catalog"})`, async t => {
  const f = fixture(t, { generated });
  const first = await f.store.enqueueExternalAudio(f.input);
  const artifact = f.publish(first);
  for (const model of ["v4", "v4-turbo"]) {
    f.open(model);
    assert.equal((await f.store.enqueueExternalAudio(f.input)).id, first.id);
    assert.deepEqual(f.store.getExternalAudioStats().states, { succeeded: 1 });
    assert.deepEqual(f.published(), artifact);
  }
});

test("same-model deliberate requests create new work and preserve published audio", async t => {
  const f = fixture(t);
  const first = await f.store.enqueueExternalAudio(f.input);
  const old = f.publish(first);
  const requestId = randomUUID();
  const replacement = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  assert.notEqual(replacement.id, first.id);
  assert.deepEqual(f.published(), old);
  assert.equal((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId })).id, replacement.id);
  f.open("v4");
  assert.equal((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId })).id, replacement.id);
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() }), { code: "CONFLICT" });
  f.publish(replacement, "c");
  assert.equal((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId })).id, replacement.id);
  assert.notEqual((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() })).id, replacement.id);
});

for (const corruption of ["missing receipt", "wrong source hash", "wrong receipt voice", "wrong upload hash"]) test(`legacy ambiguous publication conflicts (${corruption}) but explicit action is available`, async t => {
  const f = fixture(t);
  const original = await f.store.enqueueExternalAudio(f.input);
  const old = f.publish(original);
  f.mutate(db => {
    const row = db.prepare("SELECT * FROM external_audio_jobs WHERE id=?").get(original.id);
    const payload = JSON.parse(row.payload_json);
    const receipt = JSON.parse(row.receipt_json);
    if (corruption === "missing receipt") db.prepare("UPDATE external_audio_jobs SET receipt_json=NULL WHERE id=?").run(original.id);
    if (corruption === "wrong source hash") { payload.sourceTextHash = "d".repeat(64); db.prepare("UPDATE external_audio_jobs SET payload_json=? WHERE id=?").run(JSON.stringify(payload),original.id); }
    if (corruption === "wrong receipt voice") { receipt.artifact.voice = "other"; db.prepare("UPDATE external_audio_jobs SET receipt_json=? WHERE id=?").run(JSON.stringify(receipt),original.id); }
    if (corruption === "wrong upload hash") { receipt.uploadSha256 = "d".repeat(64); db.prepare("UPDATE external_audio_jobs SET receipt_json=? WHERE id=?").run(JSON.stringify(receipt),original.id); }
  });
  f.open("v4");
  await assert.rejects(f.store.enqueueExternalAudio(f.input), { code: "CONFLICT" });
  assert.deepEqual(f.store.getExternalAudioStats().states, { succeeded: 1 });
  const explicit = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() });
  assert.notEqual(explicit.id, original.id);
  assert.deepEqual(f.published(), old);
});

test("changed narration and voice are known mismatches; title-only edit reuses fallback", async t => {
  const f = fixture(t);
  const original = await f.store.enqueueExternalAudio(f.input);
  f.publish(original);
  const titleOnly = f.store.approvePlaceText(placeId, { ...story, title: "Другой заголовок" });
  f.input.sourceJobId = `place-text:${titleOnly.text.id}`;
  f.input.story = titleOnly.text.story;
  f.open("v4");
  assert.equal((await f.store.enqueueExternalAudio(f.input)).id, original.id);
  const editedStory = { ...story, paragraphs: [{ ...story.paragraphs[0], text: story.paragraphs[0].text + " Изменённый текст." }] };
  const edited = f.store.approvePlaceText(placeId, editedStory);
  f.input.sourceJobId = `place-text:${edited.text.id}`;
  f.input.story = editedStory;
  const newText = await f.store.enqueueExternalAudio(f.input);
  assert.notEqual(newText.id, original.id);
  f.publish(newText, "c");
  f.open("v4", "other-narrator");
  assert.notEqual((await f.store.enqueueExternalAudio(f.input)).id, newText.id);
});

test("ordinary compatible active work is idempotent; incompatible model conflicts", async t => {
  const f = fixture(t);
  const [first, second] = await Promise.all([f.store.enqueueExternalAudio(f.input), f.store.enqueueExternalAudio(f.input)]);
  assert.equal(first.id, second.id);
  f.open("v4");
  await assert.rejects(f.store.enqueueExternalAudio(f.input), { code: "CONFLICT" });
  assert.deepEqual(f.store.getExternalAudioStats().states, { queued: 1 });
});

test("ordinary publication reuse restores target-profile protection", async t => {
  const f = fixture(t);
  const original = await f.store.enqueueExternalAudio(f.input);
  const artifact = f.publish(original);
  const other = await f.store.enqueueExternalAudio({ ...f.input, profileId: "silero-ru-v1" });
  f.open("v4");
  assert.equal((await f.store.enqueueExternalAudio(f.input)).id, original.id);
  const claim = f.store.claimExternalAudio({ workerId: "other", requestId: randomUUID(), profileIds: ["silero-ru-v1"] });
  assert.equal(claim.id, other.id);
  const replacement = { ...artifact, provider: "external", voice: "silero", sha256: "d".repeat(64), url: `/api/story-audio/${"d".repeat(64)}.mp3` };
  f.store.acceptExternalAudio(other.id, { workerId: "other", generation: claim.leaseGeneration, leaseToken: claim.leaseToken, uploadId: randomUUID(), uploadSha256: replacement.sha256, artifact: replacement });
  assert.deepEqual(f.published(), artifact);
  assert.deepEqual(f.store.getPlace(placeId).text.audio, artifact);
});

for (const terminal of ["failed", "cancelled"]) test(`explicit ${terminal} replay stays terminal with stable synthesis identity`, async t => {
  const f = fixture(t);
  const requestId = randomUUID();
  const job = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  const claim = f.store.claimExternalAudio({ workerId: "fixture", requestId: randomUUID(), profileIds: [profileId] });
  assert.equal(claim.cacheNamespace, `external-revoice:${job.id}`);
  f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state=?,attempts=3 WHERE id=?").run(terminal,job.id));
  f.open("v4");
  const replay = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  assert.equal(replay.id, job.id);
  assert.equal(replay.state, terminal);
  assert.equal(replay.attempts, 3);
  f.open("v4", "other-narrator");
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId }), { code: "CONFLICT" });
});

test("explicit request ID cannot be reused for changed catalog narration", async t => {
  const f = fixture(t);
  const requestId = randomUUID();
  await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  const changedStory = { ...story, paragraphs: [{ ...story.paragraphs[0], text: story.paragraphs[0].text + " Изменение." }] };
  const changed = f.store.approvePlaceText(placeId, changedStory);
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, sourceJobId: `place-text:${changed.text.id}`, story: changedStory, revoiceRequestId: requestId }), { code: "CONFLICT" });
});

for (const revoiceRequestId of ["invalid", "", null, 42]) test("malformed explicit identifiers are rejected before preparation", async t => {
  const f = fixture(t);
  f.open("v3", "narrator", { normalizeExternalText: async () => { assert.fail("must not prepare"); } });
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: /** @type {string} */ (/** @type {unknown} */ (revoiceRequestId)) }), { code: "BAD_REQUEST" });
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, profileId: "silero-ru-v1", revoiceRequestId: randomUUID() }), { code: "BAD_REQUEST" });
});

for (const explicit of [false, true]) test(`editorial normalization race rejects ${explicit ? "explicit insertion" : "ordinary reuse"}`, async t => {
  const f = fixture(t);
  f.publish(await f.store.enqueueExternalAudio(f.input));
  const { promise, resolve } = Promise.withResolvers();
  f.open("v4", "narrator", { normalizeExternalText: async text => { await promise; return text; } });
  const pending = f.store.enqueueExternalAudio({ ...f.input, ...(explicit ? { revoiceRequestId: randomUUID() } : {}) });
  const rejected = assert.rejects(pending, { code: "CONFLICT" });
  f.store.approvePlaceText(placeId, { ...story, title: "Изменено" });
  resolve();
  await rejected;
  assert.deepEqual(f.store.getExternalAudioStats().states, { succeeded: 1 });
});

test("generated freshness rejects stale revision and narration during preparation", async t => {
  const f = fixture(t, { generated: true });
  f.publish(await f.store.enqueueExternalAudio(f.input));
  await assert.rejects(f.store.enqueueExternalAudio({ ...f.input, sourceRevision: f.input.sourceRevision - 1 }), { code: "CONFLICT" });
  const { promise, resolve } = Promise.withResolvers();
  f.open("v4", "narrator", { normalizeExternalText: async text => { await promise; return text; } });
  const pending = f.store.enqueueExternalAudio(f.input);
  const rejected = assert.rejects(pending, { code: "CONFLICT" });
  const current = f.store.get(f.input.sourceJobId);
  f.store.update(current.id, { data: { ...current.data, story: { ...story, title: "Изменено" } } }, current.revision);
  resolve();
  await rejected;
  assert.deepEqual(f.store.getExternalAudioStats().states, { succeeded: 1 });
});

test("identical bytes use matching successful receipt instead of artifact first owner", async t => {
  const f = fixture(t);
  const first = await f.store.enqueueExternalAudio(f.input);
  f.publish(first);
  const editedStory = { ...story, paragraphs: [{ ...story.paragraphs[0], text: story.paragraphs[0].text + " Изменение." }] };
  const edited = f.store.approvePlaceText(placeId, editedStory);
  f.input.sourceJobId = `place-text:${edited.text.id}`;
  f.input.story = editedStory;
  const replacement = await f.store.enqueueExternalAudio(f.input);
  f.publish(replacement); // Same hash: audio_artifacts retains the first job_id.
  f.open("v4");
  assert.equal((await f.store.enqueueExternalAudio(f.input)).id, replacement.id);
});

for (const publication of ["none", "other-provider", "historical-only"]) test(`ordinary work does not reuse unrelated success (${publication})`, async t => {
  const f = fixture(t);
  const first = await f.store.enqueueExternalAudio(f.input);
  const old = f.publish(first);
  f.mutate(db => {
    const artifact = publication === "none" ? null : publication === "other-provider" ? { ...old, provider: "silero" } : { ...old, sha256: "e".repeat(64), url: `/api/story-audio/${"e".repeat(64)}.mp3`, provider: "external" };
    db.prepare("UPDATE place_texts SET audio_json=? WHERE id=?").run(JSON.stringify(artifact), f.input.sourceJobId.slice(11));
  });
  f.open("v4");
  assert.notEqual((await f.store.enqueueExternalAudio(f.input)).id, first.id);
});

test("distinct simultaneous explicit requests cannot race publication", async t => {
  const f = fixture(t);
  const results = await Promise.allSettled([randomUUID(), randomUUID()].map(revoiceRequestId => f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId })));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const rejection = results.find(result => result.status === "rejected");
  assert.equal(rejection.reason.code, "CONFLICT");
  assert.deepEqual(f.store.getExternalAudioStats().states, { queued: 1 });
});

for (const state of ["failed", "cancelled"]) test(`manual retry cannot race a newer ElevenLabs job (${state})`, async t => {
  const f = fixture(t);
  const original = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() });
  f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state=?,attempts=3 WHERE id=?").run(state,original.id));
  const newer = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() });
  assert.throws(() => f.store.retryExternalAudio(original.id), { code: "CONFLICT" });
  assert.equal(f.store.getExternalAudio(original.id).state, state);
  assert.equal(f.store.getExternalAudio(newer.id).state, "queued");
  f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state='failed' WHERE id=?").run(newer.id));
  const retried = f.store.retryExternalAudio(original.id);
  assert.equal(retried.id, original.id);
  assert.equal(retried.state, "queued");
  const claim = f.store.claimExternalAudio({ workerId: "fixture", requestId: randomUUID(), profileIds: [profileId] });
  assert.equal(claim.id, original.id);
  assert.equal(claim.cacheNamespace, `external-revoice:${original.id}`);
});

test("manual retry guard covers newer catalog text rows", async t => {
  const f = fixture(t);
  const old = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() });
  const changedStory = { ...story, title: "Новый заголовок" };
  const changed = f.store.approvePlaceText(placeId, changedStory);
  const newer = await f.store.enqueueExternalAudio({ ...f.input, sourceJobId: `place-text:${changed.text.id}`, story: changedStory });
  assert.throws(() => f.store.retryExternalAudio(old.id), { code: "CONFLICT" });
  assert.equal(f.store.getExternalAudio(old.id).state, "cancelled");
  assert.equal(f.store.getExternalAudio(newer.id).state, "queued");
});

test("manual F5 retry keeps its previous behavior", async t => {
  const f = fixture(t, { generated: true });
  const input = { ...f.input, profileId: "f5-ru-v1" };
  const old = await f.store.enqueueExternalAudio(input);
  f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state='failed',attempts=3 WHERE id=?").run(old.id));
  const newer = await f.store.enqueueExternalAudio({ ...input, sourceRevision: input.sourceRevision + 1 });
  assert.notEqual(newer.id, old.id);
  assert.equal(f.store.retryExternalAudio(old.id).id, old.id);
  assert.equal(f.store.getExternalAudio(old.id).state, "queued");
});

for (const state of ["succeeded", "failed", "cancelled"]) test(`explicit ${state} replay preserves a newer profile publication target`, async t => {
  const f = fixture(t);
  const requestId = randomUUID();
  const old = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  if (state === "succeeded") f.publish(old);
  else f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state=? WHERE id=?").run(state, old.id));
  const newer = await f.store.enqueueExternalAudio({ ...f.input, profileId: "silero-ru-v1" });
  const replay = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  assert.equal(replay.id, old.id);
  assert.equal(replay.state, state);
  const claim = f.store.claimExternalAudio({ workerId: "silero", requestId: randomUUID(), profileIds: ["silero-ru-v1"] });
  assert.equal(claim.id, newer.id);
  const artifact = { url: `/api/story-audio/${"f".repeat(64)}.mp3`, sha256: "f".repeat(64), bytes: 100, durationSec: 60, provider: "external", voice: "silero" };
  f.store.acceptExternalAudio(newer.id, { workerId: "silero", generation: claim.leaseGeneration, leaseToken: claim.leaseToken, uploadId: randomUUID(), uploadSha256: artifact.sha256, artifact });
  assert.deepEqual(f.published(), artifact);
  assert.deepEqual(f.store.getPlace(placeId).text.audio, artifact);
});

for (const field of ["durationSec", "bytes", "model"]) test(`contradictory published ${field} metadata requires explicit intent`, async t => {
  const f = fixture(t);
  const old = await f.store.enqueueExternalAudio(f.input);
  const artifact = f.publish(old);
  const changed = { ...artifact, [field]: field === "model" ? "different-model" : artifact[field] + 1 };
  f.mutate(db => db.prepare("UPDATE place_texts SET audio_json=? WHERE id=?").run(JSON.stringify(changed),f.input.sourceJobId.slice(11)));
  f.open("v4");
  await assert.rejects(f.store.enqueueExternalAudio(f.input), { code: "CONFLICT" });
  assert.notEqual((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() })).id, old.id);
  assert.deepEqual(f.published(), changed);
});

test("deterministic runtime model mismatch is terminal and request replay cannot revive it", async t => {
  const f = fixture(t);
  const requestId = randomUUID();
  const old = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId });
  const claim = f.store.claimExternalAudio({ workerId: "fixture", requestId: randomUUID(), profileIds: [profileId] });
  const failed = f.store.failExternalAudio(old.id, { workerId: "fixture", generation: claim.leaseGeneration, leaseToken: claim.leaseToken, failureId: randomUUID(), code: "TTS_MODEL_MISMATCH" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.attempts, 1);
  assert.equal((await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: requestId })).state, "failed");
  assert.equal(f.store.claimExternalAudio({ workerId: "another", requestId: randomUUID(), profileIds: [profileId] }), null);
});

for (const generated of [false, true]) test(`manual ElevenLabs retry rejects superseded source before synthesis (${generated ? "generated" : "catalog"})`, async t => {
  const f = fixture(t, { generated });
  const old = await f.store.enqueueExternalAudio({ ...f.input, revoiceRequestId: randomUUID() });
  f.mutate(db => db.prepare("UPDATE external_audio_jobs SET state='failed' WHERE id=?").run(old.id));
  const changed = { ...story, paragraphs: [{ ...story.paragraphs[0], text: story.paragraphs[0].text + " Изменено." }] };
  if (generated) {
    const source = f.store.get(f.input.sourceJobId);
    f.store.update(source.id, { data: { ...source.data, story: changed } }, source.revision);
  } else f.store.approvePlaceText(placeId, changed);
  assert.throws(() => f.store.retryExternalAudio(old.id), { code: "CONFLICT" });
  assert.equal(f.store.getExternalAudio(old.id).state, "failed");
  assert.equal(f.store.claimExternalAudio({ workerId: "fixture", requestId: randomUUID(), profileIds: [profileId] }), null);
});
