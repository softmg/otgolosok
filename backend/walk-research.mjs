import { addressKey, failure, normalizeAddress, sha256 } from './domain.mjs';
import { createWalkPlanner } from './walks.mjs';

const keys = (v, allowed) => v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k));
const inBox = p => keys(p, ['lat', 'lon']) && Number.isFinite(p.lat) && Number.isFinite(p.lon) && p.lat >= 55.48 && p.lat <= 55.98 && p.lon >= 37.30 && p.lon <= 37.95;
const clean = (v, max) => typeof v === 'string' && v.length <= max && !/[\p{Cc}\p{Cf}<>]/u.test(v) ? v.trim().replace(/\s+/g, ' ') : '';
const distance = (a, b) => {
  const rad = Math.PI / 180;
  return 12742000 * Math.asin(Math.sqrt(Math.min(1, Math.sin((b.lat-a.lat)*rad/2)**2 + Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin((b.lon-a.lon)*rad/2)**2)));
};

export function validateRecoveryToken(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(token)) throw failure('BAD_REQUEST');
  return token.toLowerCase();
}

export function validateWalkResearch(input, lookup = false) {
  if (!keys(input, lookup ? ['start', 'mode', 'minutes', 'destination'] : ['start', 'mode', 'minutes', 'destination', 'consent', 'recoveryToken']) || (!lookup && input.consent !== true)
    || !['loop', 'open'].includes(input.mode) || ![30, 60, 90].includes(input.minutes)
    || !keys(input.start, ['address', 'location']) || !inBox(input.start.location)
    || (!lookup && !clean(input.start.address, 240))) throw failure('BAD_REQUEST');
  if (input.destination != null && (input.mode !== 'open' || !keys(input.destination,['address','location']) || !inBox(input.destination.location) || (!lookup && !clean(input.destination.address,240)) || distance(input.start.location,input.destination.location)<25)) throw failure('BAD_REQUEST');
  const destination = input.destination ? { address: 'Финиш прогулки', location: {lat:Number(input.destination.location.lat.toFixed(6)),lon:Number(input.destination.location.lon.toFixed(6))} } : null;
  const { lat, lon } = input.start.location;
  if (!lookup) validateRecoveryToken(input.recoveryToken);
  return { start: { address: 'Начало прогулки', location: { lat: Number(lat.toFixed(6)), lon: Number(lon.toFixed(6)) } }, mode: input.mode, minutes: input.minutes, ...(destination?{destination}:{}) };
}

export function walkResearchKey(request) {
  const r = validateWalkResearch(request, true);
  return `walk-research:v1:${sha256(JSON.stringify([r.start.location.lat, r.start.location.lon, r.mode, r.minutes, ...(r.destination?[r.destination.location.lat,r.destination.location.lon]:[])]))}`;
}

export const canRetryWalk = job => job.stage === 'failed' && job.attempts < 3 && !['WALK_NOT_FOUND', 'STORY_UNAVAILABLE'].includes(job.error?.code);

export function publicWalkResearch(job) {
  const candidates = job.data.candidates ?? [];
  return { id: job.id, stage: job.stage, revision: job.revision, request: { ...job.request, start: { ...job.request.start, address: 'Начало прогулки' } },
    phase: job.data.phase, progress: { checked: candidates.filter(c => c.checked).length, total: candidates.length, accepted: candidates.filter(c => c.accepted).length },
    route: job.data.route ?? null, stories: job.data.stories ?? [], error: job.error, canRetry: canRetryWalk(job) };
}

export function createResearchDiscovery({ fetchImpl = fetch, endpoint = process.env.WALK_OVERPASS_URL ?? 'https://overpass-api.de/api/interpreter', timeoutMs = 12000 } = {}) {
  return async (request, { signal } = {}) => {
    const controller = new AbortController();
    const deadline = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]);
    let timer;
    const run = async () => {
      const radius = Math.min(1800, request.minutes * 20), { lat, lon } = request.start.location;
      const query = `[out:json][timeout:8];nwr(around:${radius},${lat},${lon})[building]["addr:street"]["addr:housenumber"];out center tags 160;`;
      const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error', signal: deadline,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'User-Agent': 'Otgolosok/0.1' }, body: new URLSearchParams({ data: query }).toString() });
      if (!response.ok || !response.body?.getReader) { await response.body?.cancel(); throw failure('WALK_DISCOVERY_UNAVAILABLE'); }
      const reader = response.body.getReader(), chunks = []; let size = 0;
      const cancel = () => { void reader.cancel().catch(() => {}); };
      deadline.addEventListener('abort', cancel, { once: true });
      let data;
      try {
        while (true) {
          deadline.throwIfAborted();
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 1024 * 1024) throw failure('WALK_DISCOVERY_UNAVAILABLE');
          chunks.push(value);
        }
        data = JSON.parse(Buffer.concat(chunks).toString());
      } finally { deadline.removeEventListener('abort', cancel); cancel(); }
      if (!Array.isArray(data?.elements) || data.elements.length > 160 || data.remark) throw failure('WALK_DISCOVERY_UNAVAILABLE');
      const candidates = [];
      for (const e of data.elements) {
        const t = e?.tags, p = e?.center ?? e;
        const location = { lat: p?.lat, lon: p?.lon };
        if (!['node', 'way', 'relation'].includes(e?.type) || !Number.isSafeInteger(e.id) || e.id <= 0 || !inBox(location)
          || !clean(t?.building, 80) || t.building === 'no') continue;
        const street = clean(t['addr:street'], 160), house = clean(t['addr:housenumber'], 40);
        if (!street || !/^\d[\p{L}\p{N}\s/.,-]*$/u.test(house) || distance(request.start.location, location) > radius || distance(request.start.location, location) < 60) continue;
        let address;
        try { address = normalizeAddress(`Москва, ${street}, ${house}`); } catch { continue; }
        candidates.push({ place: { address, location }, provenance: { source: 'OpenStreetMap', type: e.type, id: e.id,
          url: `https://www.openstreetmap.org/${e.type}/${e.id}`, fetchedAt: new Date().toISOString(), radius } });
      }
      const cost = p => distance(request.start.location,p) + (request.destination ? distance(p,request.destination.location) : 0);
      candidates.sort((a,b) => cost(a.place.location)-cost(b.place.location) || a.provenance.id-b.provenance.id);
      const selected = [];
      for (const c of candidates) {
        if (request.destination && (cost(c.place.location)>request.minutes*90 || distance(c.place.location,request.destination.location)<25)) continue;
        if (!selected.some(s => addressKey(s.place.address) === addressKey(c.place.address) || distance(s.place.location, c.place.location) < 40)) selected.push(c);
        if (selected.length === 3) break;
      }
      return selected;
    };
    try {
      return await Promise.race([run(), new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(failure('WALK_DISCOVERY_UNAVAILABLE')); }, timeoutMs); })]);
    } catch { throw failure('WALK_DISCOVERY_UNAVAILABLE'); }
    finally { clearTimeout(timer); controller.abort(); }
  };
}

const discoverDefault = createResearchDiscovery();
const plannerDefault = createWalkPlanner({ minIntervalMs: 0 });

export async function runWalkResearchJob(initial, options, runAddressJob) {
  const { store, discoverResearch = discoverDefault, planResearchWalk = plannerDefault } = options;
  let job = initial;
  const signal = AbortSignal.any([AbortSignal.timeout(options.walkTimeoutMs ?? 2400000), ...(options.signal ? [options.signal] : [])]);
  const update = (patch = {}, stage = job.stage, error = null) => {
    job = store.update(job.id, { stage, error, data: { ...job.data, ...patch } }, job.revision);
  };
  const saveCandidate = (index, candidate) => {
    const candidates = [...job.data.candidates]; candidates[index] = candidate; update({ candidates });
  };
  const process = async (index, researchOnly) => {
    let c = job.data.candidates[index];
    const cached = store.walkAddressCheckpoint(c.place.address);
    if (cached?.blocked) { saveCandidate(index, { ...c, checked: true, accepted: false, blocked: true }); return; }
    let checkpoint = c.checkpoint ?? cached;
    if (cached?.data?.audio || (!checkpoint?.data?.story && cached?.data?.story)) checkpoint = cached;
    if (['insufficient_evidence', 'review_required'].includes(checkpoint?.stage) && !checkpoint.data?.evidence && !checkpoint.data?.story) {
      saveCandidate(index, { ...c, checkpoint, checked: true, accepted: false, error: checkpoint.error });
      if (!researchOnly) throw failure('STORY_UNAVAILABLE');
      return;
    }
    checkpoint = { id: `${job.id}:${index}`, address: c.place.address, stage: 'researching', revision: 0,
      createdAt: job.createdAt, attempts: job.attempts, data: {}, ...checkpoint, kind: 'address', stage: 'researching', error: null };
    const proxy = { update(id, patch, revision) {
      if (checkpoint.id !== id || checkpoint.revision !== revision) throw failure('CONFLICT');
      checkpoint = { ...checkpoint, ...patch, revision: revision + 1 };
      c = { ...c, checkpoint }; saveCandidate(index, c);
      store.saveWalkCheckpoint(c.place.address, checkpoint);
      return checkpoint;
    } };
    checkpoint = await runAddressJob(checkpoint, { ...options, store: proxy, signal, researchOnly });
    const accepted = Boolean(checkpoint.data.evidence || checkpoint.data.story);
    c = { ...c, checkpoint, checked: true, accepted, error: checkpoint.error };
    saveCandidate(index, c);
    if (checkpoint.stage === 'failed') throw failure(checkpoint.error?.code ?? 'PREPARATION_FAILED');
    if (!researchOnly && checkpoint.stage !== 'ready') throw failure('STORY_UNAVAILABLE');
  };
  try {
    signal.throwIfAborted();
    if (!job.data.candidates) {
      update({ phase: 'discovery' }, 'researching');
      const candidates = await discoverResearch(job.request, { signal });
      if (!Array.isArray(candidates) || candidates.length > 3) throw failure('WALK_DISCOVERY_UNAVAILABLE');
      update({ candidates, phase: 'research' });
    }
    if (!job.data.route) {
      update({ phase: 'research' });
      for (let i = 0; i < job.data.candidates.length; i++) {
        signal.throwIfAborted();
        const c = job.data.candidates[i];
        if (!c.checked || c.checkpoint?.stage === 'failed') await process(i, true);
      }
      const accepted = job.data.candidates.filter(c => c.accepted);
      if (!job.request.destination && accepted.length < 2) throw failure('INSUFFICIENT_EVIDENCE');
      update({ phase: 'routing' }, 'verifying');
      const subsets = [accepted, ...(accepted.length === 3 ? [[accepted[0], accepted[1]], [accepted[0], accepted[2]], [accepted[1], accepted[2]]] : []), ...(job.request.destination ? [...accepted.map(item=>[item]), []] : [])];
      for (const subset of subsets) {
        signal.throwIfAborted();
        try {
          const route = await planResearchWalk({ ...job.request, stops: subset.map(c => c.place) });
          update({ route }); break;
        } catch (error) { if (error.code !== 'WALK_NOT_FOUND') throw error; }
      }
      if (!job.data.route) throw failure('WALK_NOT_FOUND');
    }
    update({ phase: 'narration' }, 'writing');
    for (const place of job.data.route.stops) {
      signal.throwIfAborted();
      const existingStory = job.data.stories.find(s => addressKey(s.place.address) === addressKey(place.address));
      if (existingStory) {
        store.validateWalkPublication(existingStory);
        continue;
      }
      const index = job.data.candidates.findIndex(c => addressKey(c.place.address) === addressKey(place.address));
      if (index < 0) throw failure('WALK_NOT_FOUND');
      await process(index, false);
      const c = job.data.candidates[index];
      if (c.blocked) throw failure('STORY_UNAVAILABLE');
      const published = store.publishWalkStory(place.address, c.checkpoint);
      update({ stories: [...job.data.stories, { place, id: published.id, stage: published.stage }] }, 'voicing');
    }
    for (const story of job.data.stories) store.validateWalkPublication(story);
    update({ phase: 'complete' }, 'ready');
  } catch (error) {
    const code = signal.aborted ? 'INTERRUPTED' : error.code ?? 'PREPARATION_FAILED';
    const messages = { INSUFFICIENT_EVIDENCE: 'Рядом не хватило домов с подтверждённой историей. Попробуйте другой старт.',
      WALK_NOT_FOUND: 'Не удалось соединить подтверждённые остановки пешеходным маршрутом. Попробуйте другой старт или длительность.',
      STORY_UNAVAILABLE: 'Одна из историй недоступна для публикации. Попробуйте другую прогулку.' };
    update({}, code === 'INSUFFICIENT_EVIDENCE' ? 'insufficient_evidence' : 'failed',
      { code, message: messages[code] ?? 'Подготовка временно прервалась. Сохранённые этапы можно продолжить.' });
  }
  return job;
}
