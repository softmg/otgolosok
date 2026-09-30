import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { contentFailureMessage, runContentJob, startContentWorker } from "./content-pipeline.mjs";
import { errorMessages, startWorker } from "./pipeline.mjs";
import { normalizeOpenDataRecord } from "./open-data.mjs";

const catalog={source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:1",osmType:"node",osmId:1,name:"Памятник без адреса",location:{lat:55.75,lon:37.61},tags:{historic:"memorial",wikidata:"Q1"}}]};
function fixture(t,{audio=false}={}){const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);store.createBatch({requestKey:`pipeline-${audio?"audio":"text"}`,limit:1,mode:audio?"text-and-audio":"text-only",ttsProfile:audio?"silero-ru-v1":null});const url="https://one.example/place",page="Памятник установлен в Москве и создан известным архитектором. ".repeat(12);const facts=[1,2,3].map(index=>({claim:`Факт ${index}`,kind:"content",subjectRelation:"object",contentReason:"Раскрывает историю памятника",topic:"place_history",scope:"building",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote:"Памятник установлен в Москве и создан известным архитектором."}]}));const part="Памятник установлен в Москве и связан с историей города. Источник рассказывает о его создании и работе архитектора. ".repeat(3).trim(),text=`${part}\n\n${part}`;const queue=[{text:"Найден официальный источник",sources:[{url,title:"Источник"}]},{value:{identityConfirmed:true,addressConfirmed:true,identityNote:"Источник описывает памятник",placeName:"Памятник",resolvedAddress:"Памятник, Москва",facts}},{text},{value:{approved:true,issues:[],checks:{substantive:true,subjectAligned:true,audioClear:true},paragraphFacts:[{paragraph:1,factIds:["f1","f2"]},{paragraph:2,factIds:["f2","f3"]}],claims:[{paragraph:1,text:"Памятник установлен в Москве",factIds:["f1","f2"],supported:true,address:false},{paragraph:2,text:"Памятник установлен в Москве",factIds:["f2","f3"],supported:true,address:false}]}}];const provider={writerModel:"writer",response:/** @type {(prompt?: string, options?: object) => Promise<any>} */ (async()=>({usage:{total_tokens:1},...queue.shift()}))};return{store,provider,url,page,queue};}

test("OSM place uses plain writer text and one source",async t=>{const f=fixture(t);const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,fetchPage:async url=>({url,contentType:"text/html",html:f.page})});assert.equal(result.story.title,"Памятник");assert.equal(result.story.facts.length,3);});

test("auto approval queues audio only for full stories",async t=>{const f=fixture(t,{audio:true});const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,autoApprove:true,fetchPage:async url=>({url,contentType:"text/html",html:f.page})});assert.equal(result.story.audioDisposition,"eligible");assert.ok(f.store.claimExternalAudio({workerId:"gpu",requestId:"audio-request-0001",profileIds:["silero-ru-v1"]}));});

test("source access failure is distinct from missing evidence",async t=>{const f=fixture(t);const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,fetchPage:async()=>{throw Object.assign(new Error(),{code:"SOURCE_BLOCKED"});}});assert.equal(result.error.code,"SOURCE_ACCESS_FAILED");assert.equal(result.state,"retry_wait");});

test("content worker honors concurrency",async t=>{const places=Array.from({length:2},(_,index)=>({...catalog.places[0],placeId:`osm:node:${index+1}`,osmId:index+1,name:`Место ${index+1}`}));const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces({...catalog,places});store.createBatch({requestKey:"pipeline-concurrency",limit:2});let active=0,peak=0,release;const gate=new Promise(resolve=>{release=resolve;});const provider={writerModel:"writer",response:async()=>{active++;peak=Math.max(peak,active);await gate;active--;throw Object.assign(new Error(),{code:"INSUFFICIENT_EVIDENCE"});}};const worker=startContentWorker({store,provider,concurrency:2});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(peak,2);/** @type {() => void} */ (release)();await worker.stop();});

test("imported OSM identity reaches research and verification with nearby address hints", async t => {
  const f = fixture(t);
  const place = { ...catalog.places[0], name: "Г. Галилею", location: { lat: 55.7523087, lon: 37.6086455 }, tags: { historic: "memorial" } };
  f.store.importPlaces({ ...catalog, places: [place] });
  const prompts = [];
  const response = f.provider.response;
  f.provider.response = async (prompt, options) => { prompts.push(prompt); return response(prompt, options); };
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider,
    fetchPage: async url => ({ url, contentType: "text/html", html: f.page }) });
  assert.equal(result.story.facts.length, 3);
  for (const prompt of prompts.slice(0, 2)) {
    const context = JSON.parse(prompt.match(/^OSM PLACE CONTEXT[^:]*: (.+)$/m)[1]);
    assert.equal(context.name, "Г. Галилею");
    assert.equal(context.postalAddress, null);
    assert.ok(context.searchQueries.some(query => query.startsWith("Памятник Г. Галилею ") && query.includes("рядом с")));
    assert.ok(context.nearbyLandmarks.length > 0);
  }
  assert.equal(f.store.getPlace(place.placeId).name, "Г. Галилею");
  assert.equal(f.store.getPlace(place.placeId).address, null);
});

test("enriched search does not bypass failed identity verification", async t => {
  const f = fixture(t);
  f.queue[1].value.identityConfirmed = false;
  f.queue[1].value.identityNote = "В источнике описан другой памятник";
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider,
    fetchPage: async url => ({ url, contentType: "text/html", html: f.page }) });
  assert.equal(result.state, "review_required");
  assert.equal(result.error.code, "PLACE_UNCLEAR");
  // The code drives filtering; the message is what the editor reads, so it must not be the code again.
  assert.equal(result.error.message, contentFailureMessage("PLACE_UNCLEAR"));
  assert.notEqual(result.error.message, contentFailureMessage("PREPARATION_FAILED"));
  assert.equal(f.queue.length, 2);
  assert.equal(f.store.getPlace(catalog.places[0].placeId).text, null);
});

test("offline location context is persisted and reaches both model stages without changing the place address",async t=>{
  const f=fixture(t),prompts=[];
  /** @type {any} */
  let checkpoint;
  const save=f.store.updateContentCheckpoint;
  f.store.updateContentCheckpoint=(id,value)=>{checkpoint=structuredClone(value);save(id,value);};
  const locationContext={version:1,status:"matched",location:catalog.places[0].location,
    source:{source:"fixture",sourceSha256:"b".repeat(64)},containingBuilding:null,
    nearbyAddresses:[{osmId:"osm:way:10",address:"Москва, Тестовая улица, 7",distanceMeters:20,relation:"nearby"}],
    street:{name:"Тестовая улица"},district:null};
  const response=f.provider.response;
  f.provider.response=async(prompt,options)=>{prompts.push(prompt);return response(prompt,options);};
  const job=f.store.claimContentJob();
  const result=await runContentJob(job,{store:f.store,provider:f.provider,resolveLocation:()=>locationContext,
    fetchPage:async url=>({url,contentType:"text/html",html:f.page})});
  assert.ok(result.story);
  for(const prompt of prompts.slice(0,2)) {
    const context=JSON.parse(prompt.match(/^OSM PLACE CONTEXT[^:]*: (.+)$/m)[1]);
    assert.deepEqual(context.locationContext,locationContext);
    assert.equal(context.postalAddress,null);
    assert.ok(context.searchQueries.some(query=>query.includes("Тестовая улица, 7")));
  }
  assert.equal(f.store.getPlace(job.place.id).address,null);
  assert.deepEqual(checkpoint.locationContext,locationContext);
});

test("an unreadable configured address index stops the attempt before paid research",async t=>{
  const f=fixture(t);
  const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,
    resolveLocation:()=>{throw Object.assign(new Error(),{code:"OSM_ADDRESS_LOOKUP_FAILED"});}});
  assert.equal(result.state,"failed");
  assert.equal(result.error.code,"OSM_ADDRESS_LOOKUP_FAILED");
  assert.equal(f.queue.length,4);
  assert.equal(f.store.getPlace(catalog.places[0].placeId).text,null);
});

test("OSM worker invalidates legacy editorial checkpoints without refetching saved sources",async t=>{
  const f=fixture(t),job=f.store.claimContentJob(),checkpoint={sources:[{id:"s1",url:f.url,title:"Источник",publisher:"one.example",text:f.page}],evidence:{placeName:"Старый объект",resolvedAddress:"Москва",facts:[{id:"f1",claim:"Старый факт"}]},draft:{title:"Старый черновик",paragraphs:[]}};
  f.store.updateContentCheckpoint(job.id,checkpoint);job.checkpoint=checkpoint;f.queue.shift();
  let fetched=false;const result=await runContentJob(job,{store:f.store,provider:f.provider,fetchPage:async()=>{fetched=true;throw new Error("unexpected fetch");}});
  assert.equal(result.story.title,"Памятник");assert.equal(result.story.facts.length,3);assert.equal(fetched,false);assert.equal(f.queue.length,0);
});

test("every failure code an OSM job can end with explains itself to the editor",()=>{
  for(const code of ["ADDRESS_UNCLEAR","REVIEW_REQUIRED","INSUFFICIENT_EVIDENCE","SOURCE_ACCESS_FAILED","SOURCE_EMPTY","SOURCE_FAILED",
    "PROVIDER_FAILED","PROVIDER_BUSY","INVALID_MODEL_OUTPUT","INVALID_DRAFT","TIMEOUT","INTERRUPTED","PREPARATION_FAILED","UNKNOWN_FUTURE_CODE"]) {
    const message=contentFailureMessage(code);
    assert.notEqual(message,code);
    assert.match(message,/[а-яё]/i);
  }
  assert.equal(contentFailureMessage("ADDRESS_UNCLEAR"),errorMessages.ADDRESS_UNCLEAR);
});

function recordCheckpoints(store) {
  const saved = [];
  const save = store.updateContentCheckpoint;
  store.updateContentCheckpoint = (id, value) => { saved.push(structuredClone(value)); save(id, value); };
  return () => saved.at(-1);
}
const readPage = page => async url => ({ url, contentType: "text/html", html: page });
const rejectedReview = issue => ({ value: { approved: false, issues: [issue], checks: { substantive: false, subjectAligned: true, audioClear: true }, paragraphFacts: [],
  claims: [{ paragraph: 1, text: "Памятник установлен в Москве", factIds: ["f1"], supported: false, address: false }] } });

test("a facts rejection keeps the model's explanation and quotes for the editor", async t => {
  const f = fixture(t), last = recordCheckpoints(f.store);
  f.queue[1].value.identityConfirmed = false;
  f.queue[1].value.identityNote = "Источник описывает другой памятник";
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.equal(result.error.code, "PLACE_UNCLEAR");
  const rejection = last().factsRejection;
  assert.equal(rejection.code, "PLACE_UNCLEAR");
  assert.equal(rejection.identityNote, "Источник описывает другой памятник");
  assert.equal(rejection.identityConfirmed, false);
  assert.equal(rejection.addressConfirmed, true);
  assert.equal(rejection.facts.length, 3);
  assert.equal(rejection.facts[0].evidence[0].quote, "Памятник установлен в Москве и создан известным архитектором.");
  assert.equal(last().evidence, undefined);
});

test("model-confirmed weak identity proceeds without a lexical naming gate", async t => {
  const f = fixture(t), last = recordCheckpoints(f.store);
  const job = { ...f.store.claimContentJob(), identityPolicy: "weak_identity" };
  const result = await runContentJob(job, { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.equal(result.story.facts.length, 3);
  assert.equal(last().factsRejection, undefined);
  assert.equal(last().evidence.identityPolicy, "weak_identity");
});

test("model output in a rejection is clipped to the evidence limits", async t => {
  const f = fixture(t), last = recordCheckpoints(f.store);
  const fact = f.queue[1].value.facts[0];
  Object.assign(f.queue[1].value, { identityConfirmed: false, identityNote: "я".repeat(5000), placeName: { injected: true },
    facts: Array.from({ length: 20 }, () => ({ ...fact, evidence: Array.from({ length: 6 }, () => ({ sourceId: "s1", quote: "ц".repeat(900) })) })) });
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  const rejection = last().factsRejection;
  assert.equal(rejection.identityNote.length, 1000);
  assert.equal(rejection.placeName, null);
  assert.equal(rejection.facts.length, 8);
  assert.equal(rejection.facts[0].evidence.length, 3);
  assert.equal(rejection.facts[0].evidence[0].quote.length, 500);
});

test("a successful retry drops the previous facts rejection", async t => {
  const f = fixture(t), last = recordCheckpoints(f.store);
  const facts = structuredClone(f.queue[1].value);
  f.queue[1].value.identityConfirmed = false;
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.ok(last().factsRejection);
  const [batch] = f.store.listBatches();
  assert.ok(f.store.retryBatchItem(batch.id, catalog.places[0].placeId, { restartFrom: "auto" }));
  f.queue.unshift({ value: facts });
  const retried = f.store.claimContentJob();
  assert.ok(retried.checkpoint.sources, "retry must reuse saved sources instead of searching again");
  const result = await runContentJob(retried, { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.ok(result.story);
  assert.equal(last().factsRejection, undefined);
  assert.ok(last().evidence);
});

test("both review rounds are kept when the rewrite is rejected again", async t => {
  const f = fixture(t), last = recordCheckpoints(f.store);
  const text = f.queue[2].text;
  f.queue.splice(3, 1, rejectedReview("Первое замечание"), { text }, rejectedReview("Второе замечание"));
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.equal(result.error.code, "REVIEW_REQUIRED");
  const rounds = last().reviewRounds;
  assert.deepEqual(rounds.map(round => [round.round, round.approved, round.issues[0]]), [[1, false, "Первое замечание"], [2, false, "Второе замечание"]]);
  assert.deepEqual(rounds[1].unsupportedClaims, [{ paragraph: 1, text: "Памятник установлен в Москве" }]);
  assert.deepEqual(last().review.issues, ["Второе замечание"]);
});

test("a park identified without an address is written and reviewed by its name, not an address", async t => {
  const f = fixture(t), prompts = [];
  const facts = f.queue[1].value.facts;
  Object.assign(f.queue[1].value, { identityConfirmed: true, addressConfirmed: false, resolvedAddress: "Памятник, Москва",
    facts: [{ ...facts[0], claim: "Памятник стоит в сквере.", kind: "identity", contentReason: undefined },
      { ...facts[1], claim: "Москва, Тестовая улица, 7.", kind: "address" }, facts[2]] });
  // The address fact is dropped, so the remaining facts are f1 (identity) and f2 (content).
  const review = f.queue[3].value;
  review.paragraphFacts = [{ paragraph: 1, factIds: ["f1", "f2"] }, { paragraph: 2, factIds: ["f2"] }];
  review.claims = review.claims.map(claim => ({ ...claim, factIds: ["f1", "f2"] }));
  const response = f.provider.response;
  f.provider.response = async (prompt, options) => { prompts.push(prompt); return response(prompt, options); };
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  assert.ok(result.story);
  assert.equal(result.story.facts.some(fact => fact.claim.includes("Тестовая улица")), false);
  const reviewPrompt = prompts.find(prompt => prompt.startsWith("Audit this Russian text"));
  assert.match(reviewPrompt, /Check requested place "Памятник без адреса \(OSM: historic=memorial\)"/);
  assert.match(reviewPrompt, /Do not reject the text because it does not state or match a postal address/);
});

test("a place with a confirmed address keeps the address-based review", async t => {
  const f = fixture(t), prompts = [];
  const response = f.provider.response;
  f.provider.response = async (prompt, options) => { prompts.push(prompt); return response(prompt, options); };
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(f.page) });
  const review = prompts.find(prompt => prompt.startsWith("Audit this Russian text"));
  assert.doesNotMatch(review, /identified by its name and type/);
  const facts = prompts.find(prompt => prompt.startsWith("You are a careful Russian urban-history researcher"));
  assert.match(facts, /"identityConfirmed":true\|false/);
});

test("a provider outage pauses the queue, probes with one job and resumes without losing attempts", async t => {
  let time = Date.parse("2026-09-27T12:00:00Z"), outage = true;
  const now = () => time;
  const places = Array.from({ length: 3 }, (_, index) => ({ ...catalog.places[0], placeId: `osm:node:${index + 1}`, osmId: index + 1, name: `Место ${index + 1}` }));
  const store = createStore(":memory:", { maxActive: 100, now }); t.after(() => store.close());
  store.importPlaces({ ...catalog, places }); store.createBatch({ requestKey: "pipeline-outage", limit: 3 });
  let calls = 0, probing = false, probeStarted = 0, probeDone = false;
  const provider = { writerModel: "writer", response: async () => {
    calls++; if (probing && !probeDone) probeStarted++;
    await new Promise(resolve => setTimeout(resolve, 5)); if (probing) probeDone = true;
    throw Object.assign(new Error(), { code: outage ? "PROVIDER_BUSY" : "INSUFFICIENT_EVIDENCE" });
  } };
  const warnings = [], warn = console.warn; console.warn = message => warnings.push(message); t.after(() => { console.warn = warn; });
  const worker = startContentWorker({ store, provider, concurrency: 3, now });
  t.after(() => worker.stop());
  await new Promise(resolve => setTimeout(resolve, 50));
  const states = () => places.map(place => store.getBatch(store.listBatches()[0].id).items.find(item => item.placeId === place.placeId).state);
  assert.deepEqual(states(), ["retry_wait", "retry_wait", "retry_wait"], "outage failures wait instead of failing");
  assert.equal(calls, 3);
  assert.ok(warnings.some(message => message.includes("PROVIDER_BUSY")));
  time += 60000; worker.wake(); await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(calls, 3, "no job is claimed while the queue is paused");
  time += 10 * 60000; outage = false; probing = true; worker.wake(); await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(probeStarted, 1, "after the pause a single job probes the provider first");
  assert.deepEqual(states(), ["insufficient_evidence", "insufficient_evidence", "insufficient_evidence"]);
  assert.ok(warnings.some(message => message.includes("available again")));
});

test("a locked database while claiming is logged and does not crash either worker", async t => {
  const locked = () => { throw Object.assign(new Error("database is locked"), { code: "ERR_SQLITE_ERROR" }); };
  const captured = [], logs = { captureException: (_error, context) => captured.push(context.operation), captureMessage: () => {} };
  const error = console.error; console.error = () => {}; t.after(() => { console.error = error; });
  const content = startContentWorker({ store: { claimContentJob: locked }, provider: { response: async () => ({}) }, logs });
  const story = startWorker({ store: { claimNext: locked }, provider: {}, logs });
  content.wake(); story.wake();
  await content.stop(); await story.stop();
  assert.ok(captured.includes("contentWorker.claim"));
  assert.ok(captured.includes("claimNext"));
});

// data.mos.ru records matched offline become the first sources of a job.
const plaqueCells = { Name: "Мемориальная доска Клечковскому Всеволоду Маврикиевичу", Text: "В этом здании с 1929 по 1972 год работал академик В.М. Клечковский",
  Location: "САО, муниципальный округ Тимирязевский, улица Прянишникова, дом 6", InstallationDate: "06.06.1978",
  Authors: [{ AuthorsName: "Смирнов С.И.", Profession: "архитектор" }, { AuthorsName: "Шакаров Г.А.", Profession: "скульптор" }] };
const plaqueFact = (kind, quote, sourceId = "d1") => ({ claim: `Факт: ${quote}`, kind, subjectRelation: "object", ...(kind === "content" ? { contentReason: "Раскрывает историю доски" } : {}),
  topic: "place_history", scope: "building", location: "Мемориальная доска", distanceMeters: null, evidence: [{ sourceId, quote }] });
function openDataFixture(t, { searchSources = [], imported = true } = {}) {
  const store = createStore(":memory:", { maxActive: 100 }); t.after(() => store.close());
  store.importPlaces({ ...catalog, places: [{ ...catalog.places[0], name: "В. М. Клечковскому", tags: { historic: "memorial" } }] });
  const batch = store.createBatch({ requestKey: "open-data", placeIds: ["osm:node:1"], limit: 1, identityPolicy: "weak_identity" });
  const importPlaque = () => store.replaceOpenDataMatches([{ placeId: "osm:node:1", record: normalizeOpenDataRecord(2801, { global_id: 42, Cells: plaqueCells },
    { geometry: { type: "Point", coordinates: [37.61, 55.75] } }), match: { rule: "plaque-name-80m", distanceM: 13 } }], { datasetId: 2801, datasetVersion: "3.86" });
  if (imported) importPlaque();
  const facts = [plaqueFact("identity", "Мемориальная доска Клечковскому Всеволоду Маврикиевичу"), plaqueFact("content", "Дата установки: 06.06.1978."), plaqueFact("content", "Шакаров Г.А. (скульптор)")];
  const part = "Мемориальная доска напоминает о работе академика в этом здании. Её создали архитектор и скульптор. ".repeat(3).trim(), text = `${part}\n\n${part}`;
  const review = { value: { approved: true, issues: [], checks: { substantive: true, subjectAligned: true, audioClear: true }, paragraphFacts: [{ paragraph: 1, factIds: ["f1", "f2"] }, { paragraph: 2, factIds: ["f2", "f3"] }],
    claims: [{ paragraph: 1, text: "Мемориальная доска напоминает", factIds: ["f1", "f2"], supported: true, address: false }, { paragraph: 2, text: "Мемориальная доска напоминает", factIds: ["f2", "f3"], supported: true, address: false }] } };
  const factsAnswer = { value: { identityConfirmed: true, addressConfirmed: false, identityNote: "Запись открытых данных называет доску", placeName: "Мемориальная доска В. М. Клечковскому", resolvedAddress: "Москва, Тимирязевский район", facts } };
  const queue = [{ text: "Поиск", sources: searchSources }, factsAnswer, { text }, review], prompts = [];
  const provider = { writerModel: "writer", response: /** @type {(prompt?: string, options?: object) => Promise<any>} */ (async prompt => { prompts.push(prompt); return { usage: { total_tokens: 1 }, ...queue.shift() }; }) };
  return { store, provider, queue, prompts, batch, importPlaque, factsAnswer, text, review };
}

test("an open-data record alone is enough when the search finds nothing", async t => {
  const f = openDataFixture(t), last = recordCheckpoints(f.store);
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: async () => { throw new Error("no page expected"); } });
  assert.ok(result.story, JSON.stringify(result.error));
  assert.deepEqual(last().sources.map(source => source.id), ["d1"]);
  assert.equal(last().sources[0].url, "https://data.mos.ru/opendata/2801");
  assert.deepEqual(last().evidence.sources.map(source => source.publisher), ["data.mos.ru"]);
  assert.match(f.prompts[1], /Sources d1 are official records of the Moscow open data portal/);
  assert.doesNotMatch(f.prompts[0], /open data portal/);
});

test("an open-data record goes before fetched pages", async t => {
  const f = openDataFixture(t, { searchSources: [{ url: "https://one.example/plaque", title: "Страница" }] }), last = recordCheckpoints(f.store);
  const page = "Мемориальная доска академику установлена на здании академии. ".repeat(12);
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(page) });
  assert.deepEqual(last().sources.map(source => source.id), ["d1", "s1"]);
});

test("a job stopped before the import gets the record on retry and redoes the facts", async t => {
  const f = openDataFixture(t, { searchSources: [{ url: "https://one.example/plaque", title: "Страница" }], imported: false }), last = recordCheckpoints(f.store);
  const page = "Мемориальная доска академику установлена на здании академии. ".repeat(12);
  f.queue.splice(1, 3, { value: { ...f.factsAnswer.value, identityConfirmed: false, facts: [] } });
  const stopped = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(page) });
  assert.equal(stopped.error.code, "PLACE_UNCLEAR");
  f.importPlaque();
  f.store.retryBatchItem(f.batch.id, "osm:node:1", { restartFrom: "auto" });
  f.queue.push(f.factsAnswer, { text: f.text }, f.review);
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: async () => { throw new Error("saved pages must not be refetched"); } });
  assert.ok(result.story, JSON.stringify(result.error));
  assert.deepEqual(last().sources.map(source => source.id), ["d1", "s1"]);
  assert.equal(last().factsRejection, undefined);
});

test("a place without open data keeps the search-only behaviour", async t => {
  const f = openDataFixture(t, { imported: false });
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage("") });
  assert.equal(result.error.code, "INSUFFICIENT_EVIDENCE");
});

// Perplexity source discovery for weak_identity jobs: only its URLs are used, the pipeline fetches and checks them.
const plaquePage = "Мемориальная доска академику установлена на здании академии. ".repeat(12);
const urls = (prefix, count) => Array.from({ length: count }, (_, index) => ({ url: `https://${prefix}.example/${index + 1}`, title: `${prefix} ${index + 1}` }));
/** @param {any} t @param {{found?: {url: string, title?: string}[], search?: {url: string, title?: string}[], fails?: string | null}} [options] */
function searchFixture(t, { found = urls("pplx", 2), search = urls("codex", 2), fails = null } = {}) {
  const f = openDataFixture(t, { searchSources: search }), calls = [], failures = [];
  const provider = { ...f.provider, searchModel: "perplexity-web/pplx-auto", searchSources: async (prompt, options) => {
    calls.push({ prompt, options }); if (fails) throw Object.assign(new Error(), { code: fails }); return { sources: found }; } };
  return { ...f, provider, calls, failures, onSearchFailure: code => failures.push(code), last: recordCheckpoints(f.store) };
}
const draftText = f => f.store.listDrafts().items.find(item => item.placeId === "osm:node:1")?.text;

test("weak_identity research ranks Perplexity URLs first, dedupes and caps the merged list", async t => {
  const f = searchFixture(t, { found: [...urls("pplx", 6), { url: "javascript:alert(1)" }], search: [urls("pplx", 1)[0], ...urls("codex", 5)] });
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage), onSearchFailure: f.onSearchFailure });
  assert.ok(result.story, JSON.stringify(result.error));
  const research = f.last().research;
  assert.deepEqual(research.sources.map(source => `${source.origin}:${source.url}`), [
    ...urls("pplx", 5).map(source => `perplexity:${source.url}`), ...urls("codex", 3).map(source => `search:${source.url}`)]);
  assert.deepEqual(research.perplexity, { status: "ok", count: 5, model: "perplexity-web/pplx-auto" });
  assert.match(f.calls[0].prompt, /В\. М\. Клечковскому/);
  assert.deepEqual(f.failures, []);
  assert.equal(f.last().perplexityResearch, undefined);
  const detail = f.store.getBatchItemDetail(f.batch.id, "osm:node:1");
  assert.deepEqual(detail.perplexity, { status: "ok", code: null, count: 5 });
  assert.deepEqual(detail.sources.slice(1).map(source => source.origin), [...Array(5).fill("perplexity"), ...Array(3).fill("search")]);
});

test("a Perplexity failure falls back to the regular search without stopping the job", async t => {
  for (const code of ["PROVIDER_AUTH", "PROVIDER_REJECTED", "PROVIDER_BUSY", "NO_SEARCH_EVIDENCE"]) {
    await t.test(code, async t => {
      const f = searchFixture(t, { fails: code });
      const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage), onSearchFailure: f.onSearchFailure });
      assert.ok(result.story, JSON.stringify(result.error));
      const research = f.last().research;
      assert.deepEqual(research.sources.map(source => source.url), urls("codex", 2).map(source => source.url));
      assert.deepEqual(research.perplexity, { status: "failed", code, count: 0, model: "perplexity-web/pplx-auto" });
      assert.deepEqual(f.failures, [code]);
    });
  }
});

test("Perplexity URLs that are all unusable count as a failed search", async t => {
  const f = searchFixture(t, { found: [{ url: "ftp://plain.example/" }, { url: "not a url" }, { url: "https://user:pw@secret.example/" }] });
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.deepEqual(f.last().research.perplexity, { status: "failed", code: "NO_SEARCH_EVIDENCE", count: 0, model: "perplexity-web/pplx-auto" });
});

test("standard jobs never call the search model", async t => {
  const f = fixture(t);
  let called = false;
  const provider = { ...f.provider, searchModel: "perplexity-web/pplx-auto", searchSources: async () => { called = true; return { sources: [] }; } };
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider, fetchPage: readPage(f.page) });
  assert.ok(result.story, JSON.stringify(result.error));
  assert.equal(called, false);
});

test("a regular-search outage after Perplexity does not spend the search quota again on retry", async t => {
  const f = searchFixture(t);
  // The first regular search fails with an outage; the scripted answers stay for the retry.
  const response = f.provider.response;
  let outage = true;
  f.provider.response = async (prompt, options) => {
    if (outage) { outage = false; throw Object.assign(new Error(), { code: "PROVIDER_UNAVAILABLE" }); }
    return response(prompt, options);
  };
  const stopped = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.equal(stopped.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(f.last().perplexityResearch.perplexity.status, "ok");
  f.store.retryBatchItem(f.batch.id, "osm:node:1", { restartFrom: "auto" });
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.ok(result.story, JSON.stringify(result.error));
  assert.equal(f.calls.length, 1);
  assert.equal(f.last().research.sources[0].origin, "perplexity");
  assert.equal(f.last().perplexityResearch, undefined);
});

test("draft re-research replaces the unapproved draft or stops without touching it", async t => {
  const f = searchFixture(t);
  const first = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.ok(first.story, JSON.stringify(first.error));
  const before = draftText(f);

  f.store.researchDrafts({ requestKey: "draft-redo-fail", placeIds: ["osm:node:1"] });
  const failing = { ...f.provider, searchSources: async () => { throw Object.assign(new Error(), { code: "PROVIDER_REJECTED" }); } };
  const queued = f.queue.length;
  const stopped = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: failing, fetchPage: readPage(plaquePage) });
  assert.equal(stopped.error.code, "PERPLEXITY_UNAVAILABLE");
  assert.equal(stopped.state, "failed");
  assert.equal(stopped.error.message, contentFailureMessage("PERPLEXITY_UNAVAILABLE"));
  assert.equal(f.queue.length, queued, "the regular search must not run");
  assert.deepEqual(draftText(f), before);

  f.store.researchDrafts({ requestKey: "draft-redo-ok", placeIds: ["osm:node:1"] });
  f.queue.push({ text: "Поиск", sources: urls("codex", 1) }, f.factsAnswer, { text: f.text.replaceAll("Её создали", "Её сделали") }, f.review);
  const redone = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.ok(redone.story, JSON.stringify(redone.error));
  const after = draftText(f);
  assert.equal(after.id, before.id);
  assert.notDeepEqual(after.paragraphs, before.paragraphs);
  assert.equal(f.store.listDrafts().total, 1);
});

test("an approval made while a draft is re-researched is kept", async t => {
  const f = searchFixture(t);
  await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  f.store.researchDrafts({ requestKey: "draft-redo-key", placeIds: ["osm:node:1"] });
  const job = f.store.claimContentJob();
  const approved = f.store.approvePlaceText("osm:node:1");
  f.queue.push({ text: "Поиск", sources: [] }, f.factsAnswer, { text: f.text.replaceAll("Её создали", "Её сделали") }, f.review);
  const result = await runContentJob(job, { store: f.store, provider: f.provider, fetchPage: readPage(plaquePage) });
  assert.ok(result.story, JSON.stringify(result.error));
  assert.deepEqual(f.store.getPlace("osm:node:1").text.story, approved.text.story);
});
