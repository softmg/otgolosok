import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from './store.mjs';
import { createApp } from './server.mjs';
import { runJob } from './pipeline.mjs';
import { addressKey, failure } from './domain.mjs';
import { createResearchDiscovery, publicWalkResearch, validateWalkResearch, walkResearchKey } from './walk-research.mjs';

const input = { start: { address: 'Москва, Стартовая улица, 1', location: { lat: 55.75, lon: 37.61 } }, mode: 'loop', minutes: 30, consent: true, recoveryToken: '12345678-1234-4234-8234-123456789abc' };
const candidates = Array.from({ length: 3 }, (_, i) => ({ place: { address: `Москва, Тестовая улица, ${i+2}`, location: { lat: 55.752+i*.001, lon: 37.61 } }, provenance: { source: 'OpenStreetMap', type: 'way', id: i+1 } }));

test('destination participates in research identity and survives normalized requests', () => {
  const destination={address:'Москва, Финишная улица, 2',location:{lat:55.755,lon:37.61}};
  const request={...input,mode:'open',destination};
  const normalized=validateWalkResearch(request);
  assert.deepEqual(normalized.destination.location,destination.location);
  assert.notEqual(walkResearchKey(normalized),walkResearchKey({...normalized,destination:undefined}));
  assert.notEqual(walkResearchKey(normalized),walkResearchKey({...normalized,destination:{...destination,location:{...destination.location,lat:55.756}}}));
  assert.throws(()=>validateWalkResearch({...request,mode:'loop'}));
  assert.throws(()=>validateWalkResearch({...request,destination:input.start}));
});

function fixture(t, config = {}) {
  const store = createStore(':memory:', { maxDaily: 60, ...config });
  t.after(() => store.close());
  const events = [], calls = { research: 0, facts: 0, draft: 0, review: 0, audio: 0, discovery: 0, route: 0 };
  const text = 'Это описание здания с проверяемыми сведениями об архитектуре и истории. '.repeat(10);
  const urls = ['https://first.example/history', 'https://second.example/history'];
  const facts = Array.from({ length: 5 }, (_, i) => ({ id: `f${i+1}`, claim: `Факт ${i+1}`, kind:'content', subjectRelation:'object', contentReason:'Раскрывает архитектуру здания', topic: 'architecture', scope: 'building', location: 'Москва, Тестовая улица, 2',
    evidence: [{ sourceId: i%2 ? 's2' : 's1', quote: 'Это описание здания с проверяемыми сведениями об архитектуре и истории.' }] }));
  const paragraph = 'История этого дома помогает понять архитектуру города и заметить детали его прошлого. '.repeat(8).trim();
  const options = { store, audioDirectory: 'unused',
    discoverResearch: async () => { calls.discovery++; return structuredClone(candidates); },
    planResearchWalk: async request => { calls.route++; events.push('route'); return { stops: request.stops, geometry: [request.start.location, ...request.stops.map(p => p.location)], distanceM: 500, walkingMinutes: 10, attribution: 'mock' }; },
    fetchPage: async url => ({ url, html: text }),
    provider: { response: async (prompt, opts) => {
      if (opts.search) { calls.research++; events.push('research'); return { text:'Источники найдены',sources:urls.map(url=>({url,title:'Источник'})),model:'mock',usage:{},citedUrls:urls }; }
      if (opts.maxTokens === 5500) { calls.facts++; return { value:{ addressConfirmed: true, identityNote:'Источник описывает этот дом', placeName: 'Дом', resolvedAddress: candidates[0].place.address, facts },model:'mock',usage:{} }; }
      if (opts.maxTokens === 3200) { calls.draft++; events.push('draft'); return { text:`${paragraph}\n\n${paragraph}`,model:'mock',usage:{} }; }
      calls.review++; return { value:{ approved: true, issues: [], checks:{substantive:true,subjectAligned:true,audioClear:true},paragraphFacts:[{paragraph:1,factIds:['f1','f2','f3']},{paragraph:2,factIds:['f4','f5']}],claims:[{paragraph:1,text:'История этого дома',factIds:['f1','f2','f3'],supported:true,address:false},{paragraph:2,text:'История этого дома',factIds:['f4','f5'],supported:true,address:false}] },model:'mock',usage:{} };
    } },
    narrate: async () => { calls.audio++; events.push('audio'); assert.ok(events.includes('route')); return { url: `/api/story-audio/${'a'.repeat(64)}.mp3`, durationSec: 100 }; },
  };
  const create = (request = input) => store.createWalkResearch(structuredClone(request));
  const run = () => runJob(store.claimNext(), options);
  return { store, options, calls, events, create, run };
}

test('strict consent and deterministic normalized coordinate key excluding address', () => {
  const request = validateWalkResearch(input);
  assert.equal(walkResearchKey(request), walkResearchKey({ ...request, start: { address: 'another label', location: { lat: 55.7500001, lon: 37.61 } } }));
  assert.notEqual(walkResearchKey(request), walkResearchKey({ ...request, minutes: 60 }));
  for (const patch of [{ consent: false }, { consent: 'true' }, { consent: undefined }, { minutes: '30' }, { minutes: 45 }, { mode: 'auto' }, { extra: 1 }, { start: { ...input.start, location: { lat: '55.75', lon: 37.61 } } }, { start: { ...input.start, location: { lat: 90, lon: 37.61 } } }, { start: { ...input.start, address: '<script>' } }]) {
    assert.throws(() => validateWalkResearch({ ...input, ...patch }), { code: 'BAD_REQUEST' });
  }
});

test('three units reserved transactionally; dedup and lookup allocate nothing; kinds isolated', t => {
  const f = fixture(t, { maxDaily: 3 });
  assert.equal(f.store.lookupWalkResearch(validateWalkResearch(input), input.recoveryToken), null);
  const job = f.create();
  assert.equal(f.create().id, job.id);
  assert.equal(f.store.lookupWalkResearch(validateWalkResearch(input), input.recoveryToken).id, job.id);
  assert.equal(f.store.listAdmin().jobs.length, 0);
  assert.equal(f.store.claimNext({ audioOnly: true }), null);
  assert.throws(() => f.store.retry(job.id, 0), { code: 'CONFLICT' });
  assert.throws(() => f.store.createOrGet({ key: job.key, address: 'Москва, дом 1' }), { code: 'CONFLICT' });
  assert.throws(() => f.store.setRelevanceAdmin(job.id, 0, true), { code: 'CONFLICT' });
  assert.throws(() => f.store.createOrGet({ key: 'other', address: 'Москва, дом 1' }), { code: 'DAILY_LIMIT' });
});

test('failed reservations leave no parent or ledger entries; retry capacity failure preserves checkpoints', t => {
  const f = fixture(t, { maxDaily: 2 });
  assert.throws(() => f.create(), { code: 'DAILY_LIMIT' });
  assert.equal(f.store.lookupWalkResearch(validateWalkResearch(input), input.recoveryToken), null);
  const a = f.store.createOrGet({ key: 'a', address: 'Москва, дом 1' });
  f.store.update(a.id, { stage: 'ready' }, a.revision);
  assert.ok(f.store.createOrGet({ key: 'b', address: 'Москва, дом 2' }));
  const g = fixture(t, { maxDaily: 5 });
  g.create(); let job = g.store.claimNext();
  job = g.store.update(job.id, { stage: 'failed', error: { code: 'INTERRUPTED', message: 'test' } }, job.revision);
  assert.throws(() => g.store.retryWalkResearch(job.id, job.revision), { code: 'DAILY_LIMIT' });
  assert.deepEqual(g.store.get(job.id), job);
  const h = fixture(t, { maxActive: 0 });
  assert.throws(() => h.create(), { code: 'QUEUE_FULL' });
});

test('full strict pipeline researches three before routing and only then writes, voices, publishes actual address jobs', async t => {
  const f = fixture(t); f.create();
  const job = await f.run();
  assert.equal(job.stage, 'ready');
  assert.deepEqual(f.calls, { research: 3, facts: 3, draft: 3, review: 3, audio: 3, discovery: 1, route: 1 });
  assert.ok(f.events.indexOf('route') > f.events.lastIndexOf('research'));
  assert.ok(f.events.indexOf('draft') > f.events.indexOf('route'));
  const result = publicWalkResearch(job);
  assert.equal(result.phase, 'complete');
  assert.deepEqual(result.progress, { checked: 3, total: 3, accepted: 3 });
  assert.equal(result.stories.length, 3);
  for (const story of result.stories) {
    const address = f.store.get(story.id);
    assert.equal(address.kind, 'address'); assert.equal(address.stage, 'ready');
    assert.ok(address.data.story); assert.ok(address.data.audio);
    assert.equal(f.store.createOrGet({ key: addressKey(story.place.address), address: story.place.address }).id, story.id);
  }
  assert.equal('data' in result, false);
});

test('cross-neighborhood cache reuses evidence, text and audio; no extra provider calls', async t => {
  const f = fixture(t); f.create(); await f.run();
  const before = { ...f.calls };
  f.create({ ...input, start: { ...input.start, location: { lat: 55.7505, lon: 37.61 } } });
  const second = await f.run();
  assert.equal(second.stage, 'ready');
  for (const key of ['research', 'facts', 'draft', 'review', 'audio']) assert.equal(f.calls[key], before[key]);
});

test('research checkpoints of discarded stops are reused and irrelevant publications stay blocked', async t => {
  const f = fixture(t), plan = f.options.planResearchWalk;
  f.options.planResearchWalk = async request => { if (request.stops.length === 3) throw failure('WALK_NOT_FOUND'); return plan(request); };
  f.create(); const first = await f.run();
  assert.equal(f.calls.audio, 2);
  f.options.planResearchWalk = plan;
  f.create({ ...input, minutes: 60 });
  const second = await f.run();
  assert.equal(second.stage, 'ready'); assert.equal(f.calls.research, 3); assert.equal(f.calls.audio, 3);
  const publication = f.store.get(first.data.stories[0].id);
  f.store.setRelevanceAdmin(publication.id, publication.revision, true);
  f.create({ ...input, minutes: 90 });
  const third = await f.run();
  assert.equal(third.stage, 'ready'); assert.equal(third.data.stories.length, 2);
  assert.ok(third.data.stories.every(s => s.id !== publication.id));
  assert.equal(f.calls.research, 3); assert.equal(f.calls.audio, 3);
});

test('bounded subsets route two stops and do not narrate discarded candidate', async t => {
  const f = fixture(t);
  const plan = f.options.planResearchWalk;
  let attempts = 0;
  f.options.planResearchWalk = async request => { attempts++; if (request.stops.length === 3) throw failure('WALK_NOT_FOUND'); return plan(request); };
  f.create(); const job = await f.run();
  assert.equal(job.stage, 'ready'); assert.equal(attempts, 2);
  assert.equal(f.calls.research, 3); assert.equal(f.calls.audio, 2); assert.equal(job.data.stories.length, 2);
});

test('no route is friendly terminal and no narration; temporary router outage can retry without research', async t => {
  const f = fixture(t); const plan = f.options.planResearchWalk;
  f.options.planResearchWalk = async () => { throw failure('WALK_UNAVAILABLE'); };
  f.create(); let job = await f.run();
  assert.equal(job.error.code, 'WALK_UNAVAILABLE'); assert.equal(publicWalkResearch(job).canRetry, true);
  assert.equal(f.calls.audio, 0); assert.equal(f.calls.draft, 0);
  f.store.retryWalkResearch(job.id, job.revision);
  f.options.planResearchWalk = plan; job = await f.run();
  assert.equal(job.stage, 'ready'); assert.equal(f.calls.research, 3);
  f.create({ ...input, minutes: 60 });
  let attempts = 0;
  f.options.planResearchWalk = async () => { attempts++; throw failure('WALK_NOT_FOUND'); };
  job = await f.run();
  assert.equal(attempts, 4); assert.equal(job.error.code, 'WALK_NOT_FOUND'); assert.equal(publicWalkResearch(job).canRetry, false);
  assert.throws(() => f.store.retryWalkResearch(job.id, job.revision), { code: 'RETRY_LIMIT' });
});

test('insufficient evidence persists failures and never routes or voices', async t => {
  const f = fixture(t);
  f.options.provider.response = async () => ({ value: { sources: [] }, citedUrls: [] });
  f.create(); const job = await f.run();
  assert.equal(job.stage, 'insufficient_evidence'); assert.equal(publicWalkResearch(job).canRetry, false);
  assert.deepEqual(publicWalkResearch(job).progress, { checked: 3, total: 3, accepted: 0 });
  assert.equal(f.calls.route, 0); assert.equal(f.calls.audio, 0);
  assert.ok(job.data.candidates.every(c => c.checkpoint.error.code === 'INSUFFICIENT_EVIDENCE'));
});

test('retry reserves all three units, preserves completed audio and publication', async t => {
  const f = fixture(t, { maxDaily: 6 }); const narrate = f.options.narrate;
  let attempts = 0;
  f.options.narrate = async (...args) => { if (++attempts === 2) throw failure('TTS_FAILED'); return narrate(...args); };
  f.create(); let job = await f.run();
  assert.equal(job.stage, 'failed'); assert.equal(job.data.stories.length, 1);
  const first = job.data.stories[0].id;
  assert.throws(() => f.store.retryWalkResearch(job.id, job.revision-1), { code: 'CONFLICT' });
  f.store.retryWalkResearch(job.id, job.revision);
  assert.throws(() => f.store.createOrGet({ key: 'extra', address: 'Москва, дом 1' }), { code: 'DAILY_LIMIT' });
  job = await f.run();
  assert.equal(job.stage, 'ready'); assert.equal(job.data.stories[0].id, first);
  assert.equal(f.calls.research, 3); assert.equal(f.calls.draft, 3); assert.equal(f.calls.audio, 3);
});

test('existing user job is not overwritten; irrelevant address excluded', async t => {
  const f = fixture(t);
  const existing = f.store.createOrGet({ key: addressKey(candidates[0].place.address), address: candidates[0].place.address });
  f.store.update(existing.id, { stage: 'failed', data: { marker: 'user' } }, existing.revision);
  const irrelevant = f.store.createOrGet({ key: addressKey(candidates[2].place.address), address: candidates[2].place.address });
  f.store.update(irrelevant.id, { stage: 'failed' }, irrelevant.revision);
  f.store.setRelevanceAdmin(irrelevant.id, 1, true);
  const before = f.store.get(existing.id);
  f.create(); const job = await f.run();
  assert.equal(job.stage, 'ready'); assert.equal(job.data.stories.length, 2);
  assert.deepEqual(f.store.get(existing.id), before);
  assert.notEqual(job.data.stories[0].id, existing.id);
  assert.equal(f.calls.research, 2);
});

test('restart recovery requires explicit retry and preserves durable candidate checkpoints', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'walk-research-'));
  t.after(() => { try { store?.close(); } catch {} rmSync(directory, { recursive: true, force: true }); });
  const path = join(directory, 'jobs.sqlite');
  let store = createStore(path, { maxDaily: 6 });
  const created = store.createWalkResearch(input); let job = store.claimNext();
  job = store.update(job.id, { data: { ...job.data, phase: 'research', candidates: [{ ...candidates[0], checked: true, accepted: false, checkpoint: { stage: 'insufficient_evidence', data: {} } }] } }, job.revision);
  store.close(); store = createStore(path, { maxDaily: 6 });
  assert.equal(store.recoverInterrupted(), 1);
  job = store.get(created.id);
  assert.equal(job.error.code, 'INTERRUPTED'); assert.equal(store.claimNext(), null);
  assert.equal(store.lookupWalkResearch(validateWalkResearch(input), input.recoveryToken).id, created.id);
  assert.equal(store.createWalkResearch(input).stage, 'failed');
  store.retryWalkResearch(job.id, job.revision);
  const done = await runJob(store.claimNext(), { store, discoverResearch: () => assert.fail('must reuse discovery'), provider: { response: () => assert.fail('must reuse terminal checkpoint') } });
  assert.equal(done.stage, 'insufficient_evidence');
});

test('discovery accepts unnamed nonhistoric buildings, bounds neighborhood, validates payload and provenance', async () => {
  const elements = Array.from({ length: 5 }, (_, i) => ({ type: 'way', id: i+1, center: { lat: 55.752+i*.001, lon: 37.61 }, tags: { building: 'apartments', 'addr:street': 'Тестовая улица', 'addr:housenumber': `${i+2}` } }));
  let query;
  const discover = createResearchDiscovery({ fetchImpl: async (url, opts) => { query = new URLSearchParams(opts.body).get('data'); return Response.json({ elements }); } });
  const result = await discover(validateWalkResearch(input));
  assert.equal(result.length, 3); assert.match(query, /around:600,/); assert.doesNotMatch(query, /historic|\[name\]/);
  assert.equal(result[0].provenance.url, 'https://www.openstreetmap.org/way/1');
  for (const data of [{}, { elements: [], remark: 'timed out' }, { elements: Array(161).fill({}) }]) {
    await assert.rejects(createResearchDiscovery({ fetchImpl: async () => Response.json(data) })(input), { code: 'WALK_DISCOVERY_UNAVAILABLE' });
  }
  const invalid = elements.map(e => ({ ...e, center: { lat: 56, lon: 37.61 } }));
  assert.deepEqual(await createResearchDiscovery({ fetchImpl: async () => Response.json({ elements: invalid }) })(input), []);
  await assert.rejects(createResearchDiscovery({ timeoutMs: 5, fetchImpl: () => new Promise(() => {}) })(input), { code: 'WALK_DISCOVERY_UNAVAILABLE' });
  await assert.rejects(createResearchDiscovery({ fetchImpl: async () => new Response('x'.repeat(1024*1024+1)) })(input), { code: 'WALK_DISCOVERY_UNAVAILABLE' });
});

test('HTTP consent, origin, lost POST lookup, provider-down GET and address/admin isolation', async t => {
  const f = fixture(t), origin = 'http://localhost:3000';
  const app = createApp({ store: f.store, provider: {}, origin, workerEnabled: false, adminToken: 'test-admin-token', audioDirectory: 'unused' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (value, headers = {}) => fetch(`${base}/api/walk-research-jobs`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(value) });
  assert.equal((await post(input, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(input, { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
  assert.equal((await post({ ...input, consent: false })).status, 400);
  assert.equal((await fetch(`${base}/api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30&recoveryToken=${input.recoveryToken}`)).status, 404);
  assert.equal(f.store.lookupWalkResearch(validateWalkResearch(input), input.recoveryToken), null);
  const job = await (await post(input)).json();
  assert.equal((await (await post(input)).json()).id, job.id);
  assert.equal((await (await fetch(`${base}/api/walk-research-jobs?lat=55.7500001&lon=37.61&mode=loop&minutes=30&recoveryToken=${input.recoveryToken}`)).json()).id, job.id);
  assert.equal((await fetch(`${base}/api/walk-research-jobs?lat=55.75&lat=55.75&lon=37.61&mode=loop&minutes=30`)).status, 400);
  assert.equal((await fetch(`${base}/api/story-jobs/${job.id}`)).status, 404);
  assert.equal((await fetch(`${base}/api/story-admin/jobs/${job.id}`, { headers: { Authorization: 'Bearer test-admin-token' } })).status, 404);
  const down = createApp({ store: f.store, provider: null, origin, workerEnabled: false, audioDirectory: 'unused' });
  await new Promise(resolve => down.server.listen(0, '127.0.0.1', resolve)); t.after(() => down.close());
  const downBase = `http://127.0.0.1:${down.server.address().port}`;
  const revision = f.store.get(job.id).revision;
  assert.equal((await fetch(`${downBase}/api/walk-research-jobs/${job.id}`)).status, 200);
  assert.equal((await fetch(`${downBase}/api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30&recoveryToken=${input.recoveryToken}`)).status, 200);
  assert.equal(f.store.get(job.id).revision, revision);
  const otherToken = '87654321-4321-4321-8321-cba987654321';
  const lookup = token => `${base}/api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30&recoveryToken=${token}`;
  assert.equal((await fetch(`${base}/api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30`)).status, 400);
  for (const token of ['', 'not-a-uuid', '00000000-0000-0000-0000-000000000000']) {
    assert.equal((await fetch(lookup(token))).status, 400);
    assert.equal((await post({ ...input, recoveryToken: token })).status, 400);
  }
  assert.equal((await post({ ...input, recoveryToken: undefined })).status, 400);
  assert.equal((await fetch(lookup(otherToken))).status, 404);
  const shared = await (await post({ ...input, recoveryToken: otherToken, start: { ...input.start, address: 'Private second label' } })).json();
  assert.equal(shared.id, job.id);
  assert.equal(shared.request.start.address, 'Начало прогулки');
  assert.equal(JSON.stringify(shared).includes(input.start.address), false);
  assert.equal(JSON.stringify(shared).includes(otherToken), false);
  assert.equal((await (await fetch(lookup(otherToken))).json()).id, job.id);
  assert.equal((await (await fetch(lookup(input.recoveryToken))).json()).id, job.id);
  assert.equal((await fetch(lookup(otherToken).replace('lat=55.75', 'lat=55.76'))).status, 404);
  assert.equal(f.store.get(job.id).revision, revision);
});

test('deduplicated grants bypass quota and provider availability without storing private labels or raw tokens', t => {
  const f = fixture(t, { maxDaily: 3 });
  const first = f.create();
  const token = '87654321-4321-4321-8321-cba987654321';
  const second = f.store.createWalkResearch({ ...input, recoveryToken: token }, { allowCreate: false });
  assert.equal(second.id, first.id);
  assert.equal(f.store.lookupWalkResearch(validateWalkResearch(input), token).id, first.id);
  assert.equal(first.request.start.address, 'Начало прогулки');
  assert.equal(JSON.stringify(first).includes(input.recoveryToken), false);
  assert.equal(publicWalkResearch({ ...first, request: { ...first.request, start: input.start } }).request.start.address, 'Начало прогулки');
});

test('retry refuses a previously published story made irrelevant or unready', async t => {
  for (const change of ['irrelevant', 'unready', 'blocked-address']) {
    const f = fixture(t), narrate = f.options.narrate;
    let attempts = 0;
    f.options.narrate = async (...args) => { if (++attempts === 2) throw failure('TTS_FAILED'); return narrate(...args); };
    f.create(); let job = await f.run();
    const story = f.store.get(job.data.stories[0].id);
    if (change === 'irrelevant') f.store.setRelevanceAdmin(story.id, story.revision, true);
    else if (change === 'unready') f.store.update(story.id, { stage: 'failed' }, story.revision);
    else {
      // A separate user address record can block an otherwise ready publication.
      const original = f.store.walkAddressCheckpoint;
      f.store.walkAddressCheckpoint = address => address === story.address ? { blocked: true } : original(address);
    }
    f.store.retryWalkResearch(job.id, job.revision);
    job = await f.run();
    assert.equal(job.stage, 'failed'); assert.equal(job.error.code, 'STORY_UNAVAILABLE');
    assert.equal(attempts, 2);
  }
});

test('completion revalidates stories changed while later narration was running', async t => {
  const f = fixture(t), narrate = f.options.narrate;
  let parent, attempts = 0;
  f.options.narrate = async (...args) => {
    if (++attempts === 3) {
      const story = f.store.get(f.store.get(parent.id).data.stories[0].id);
      f.store.setRelevanceAdmin(story.id, story.revision, true);
    }
    return narrate(...args);
  };
  parent = f.create(); const job = await f.run();
  assert.equal(job.stage, 'failed'); assert.equal(job.error.code, 'STORY_UNAVAILABLE');
});

test('terminal research failures are reused across neighborhoods without provider calls', async t => {
  for (const stage of ['insufficient_evidence', 'review_required']) {
    const f = fixture(t);
    for (const c of candidates) f.store.saveWalkCheckpoint(c.place.address, { stage, data: {}, error: { code: stage.toUpperCase(), message: 'cached' } });
    f.options.provider.response = async () => assert.fail('terminal cache must not call provider');
    f.create(); let job = await f.run();
    assert.equal(job.stage, 'insufficient_evidence');
    assert.ok(job.data.candidates.every(c => c.checked && !c.accepted && c.checkpoint.stage === stage));
    f.create({ ...input, minutes: 60 }); job = await f.run();
    assert.equal(job.stage, 'insufficient_evidence');
    assert.equal(f.calls.route, 0); assert.equal(f.calls.audio, 0);
  }
});
