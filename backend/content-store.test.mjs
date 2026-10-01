import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "./store.mjs";
import { etagOf, serializeCell } from "./map-cells.mjs";
import { placeImageInputHash } from "./place-images.mjs";

const catalog={source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[
  {placeId:"osm:node:1",osmType:"node",osmId:1,name:"Памятник",location:{lat:55.75,lon:37.61},tags:{historic:"memorial",wikidata:"Q1"}},
  {placeId:"osm:way:2",osmType:"way",osmId:2,name:"Музей",location:{lat:55.76,lon:37.62},tags:{tourism:"museum","addr:street":"Арбат","addr:housenumber":"1"}},
]};

test("import retains full and locality addresses without treating a street alone as postal address", t => {
  const store = createStore(":memory:");
  t.after(() => store.close());
  for (const [tags, expected] of [
    [{ "addr:full": "Москва, Арбат, 1" }, "Москва, Арбат, 1"],
    [{ "addr:place": "территория музея", "addr:housenumber": "2" }, "Москва, территория музея, 2"],
    [{ "addr:street": "Арбат" }, null],
  ]) {
    store.importPlaces({ ...catalog, places: [{ ...catalog.places[0], tags }] });
    assert.equal(store.getPlace("osm:node:1").address, expected);
  }
});

test("catalog imports idempotently and batches deduplicate text jobs",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());
  assert.equal(store.importPlaces(catalog).count,2);store.importPlaces(catalog);
  assert.equal(store.listPlaces().places.length,2);assert.equal(store.getPlace("osm:node:1").address,null);
  assert.deepEqual(store.getPlace("osm:node:1").geometry,{type:"Point",coordinates:[37.61,55.75]});
  const first=store.createBatch({requestKey:"request-0001",name:"Pilot",limit:2});
  const repeated=store.createBatch({requestKey:"request-0001",name:"Ignored",limit:2});
  assert.equal(repeated.id,first.id);assert.equal(first.counts.total,2);
  const second=store.createBatch({requestKey:"request-0002",name:"Second",placeIds:["osm:node:1","osm:way:2"],limit:2});
  assert.equal(second.counts.total,2);
  const job=store.claimContentJob();assert.ok(["Музей","Памятник"].includes(job.place.name));
  store.completeContentJob(job.id,{story:{title:"Музей",paragraphs:[{text:"Текст",factIds:["f1"]}]},evidence:{facts:[]}});
  assert.equal(store.getPlace(job.place.id).text.draft.title,"Музей");assert.equal(store.getPlace(job.place.id).text.story,null);
  assert.equal(store.approvePlaceText(job.place.id).text.verification,"editorial");
  assert.equal(store.getBatch(first.id).counts.ready,1);assert.equal(store.getBatch(second.id).counts.ready,1);
});

test("paused batches are not claimed and interrupted jobs recover",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"request-0003",name:"Paused",placeIds:["osm:node:1"],limit:1});
  store.setBatchState(batch.id,"paused");assert.equal(store.claimContentJob(),null);
  store.setBatchState(batch.id,"running");const job=store.claimContentJob();assert.ok(job);
  assert.equal(store.recoverContentJobs(),1);assert.equal(store.getBatch(batch.id).items[0].state,"retry_wait");
  assert.ok(store.retryBatchItem(batch.id,"osm:node:1"));
});

test("batch priority changes claim order without touching active jobs",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const low=store.createBatch({requestKey:"priority-low",placeIds:["osm:node:1"],limit:1}),high=store.createBatch({requestKey:"priority-high",placeIds:["osm:way:2"],limit:1});
  assert.ok(store.setBatchPriority(high.id,100));assert.equal(store.claimContentJob().place.id,"osm:way:2");assert.equal(store.setBatchPriority("missing",1),null);assert.throws(()=>store.setBatchPriority(low.id,-1),{code:"BAD_REQUEST"});
});

test("a complete import archives absent places while partial imports preserve them",t=>{
  const store=createStore(":memory:");t.after(()=>store.close());store.importPlaces(catalog,{complete:true});
  store.importPlaces({...catalog,sourceSha256:"b".repeat(64),places:[catalog.places[0]]});assert.equal(store.listPlaces().places.length,2);
  store.importPlaces({...catalog,sourceSha256:"c".repeat(64),places:[catalog.places[0]]},{complete:true});assert.equal(store.listPlaces().places.length,1);
});

test("catalog nearby query returns approved cards ordered by distance",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"nearby-query",placeIds:["osm:node:1"],limit:1});const job=store.claimContentJob();const story={title:"Готовая история",paragraphs:[{text:"Проверенный текст",factIds:["f1"]}]};
  store.completeContentJob(job.id,{story,evidence:{}});store.approvePlaceText("osm:node:1");
  const nearby=store.listPlaces({status:"ready",lat:55.7501,lon:37.6101,radius:1000});assert.equal(nearby.places[0].id,"osm:node:1");assert.ok(nearby.places[0].distanceM<20);
  assert.deepEqual(store.listWalkCandidates({lat:55.75,lon:37.61,radius:2000}).map(item=>[item.id,item.readiness]),[["osm:node:1","story"],["osm:way:2","none"]]);
  // Published-only filtering happens before the limit: a nearer place without a story must not crowd it out.
  assert.deepEqual(store.listWalkCandidates({lat:55.76,lon:37.62,radius:2000,limit:1}).map(item=>item.id),["osm:way:2"]);
  assert.deepEqual(store.listWalkCandidates({lat:55.76,lon:37.62,radius:2000,limit:1,published:true}).map(item=>[item.id,item.readiness]),[["osm:node:1","story"]]);
  assert.equal(store.listPlaces({status:"ready",lat:55.9,lon:37.9,radius:100}).places.length,0);assert.equal(store.getBatch(batch.id).counts.ready,1);
});

test("bulk audio backfill queues only approved texts without audio, reports unapproved ones and is idempotent", async t => {
  const store = createStore(":memory:", {
    externalTtsProfiles: { "f5-ru-v1": { engine: "f5", language: "ru" } },
    normalizeExternalText: Object.assign(async text => text, { version: "plain-v1" }),
  });
  t.after(() => store.close());
  store.importPlaces(catalog);
  const batch = store.createBatch({ requestKey: "bulk-audio", name: "Audio", limit: 2, mode: "text-only" });
  const job = store.claimContentJob();
  const story = {
    title: "История места",
    paragraphs: [
      { text: ("Это подтверждённый рассказ о месте для проверки массовой постановки озвучки. ").repeat(12), factIds: [] },
      { text: ("Второй абзац содержит достаточно материала для валидного аудиозадания и публикации. ").repeat(12), factIds: [] },
    ],
  };
  store.completeContentJob(job.id, { story, evidence: {}, autoApprove: false });
  const unapproved = store.claimContentJob();
  store.completeContentJob(unapproved.id, { story, evidence: {}, autoApprove: false });
  assert.equal(store.getContentStats().awaitingApproval, 2);
  store.approvePlaceText(job.place.id);
  assert.equal(store.getContentStats().awaitingApproval, 1);

  const first = await store.enqueueMissingPlaceAudio({ profileId: "f5-ru-v1", limit: 500 });
  assert.equal(first.queued, 1);
  assert.equal(first.inspected, 1);
  assert.equal(first.awaitingApproval, 1);
  assert.equal(first.hasMore, false);
  assert.equal(store.getExternalAudioStats().states.queued, 1);

  const second = await store.enqueueMissingPlaceAudio({ profileId: "f5-ru-v1", limit: 500 });
  assert.equal(second.queued, 0);
  assert.equal(second.inspected, 0);
  assert.equal(second.awaitingApproval, 1);
  assert.equal(store.getExternalAudioStats().states.queued, 1);
  assert.equal(store.getBatch(batch.id).counts.ready, 2);
});

test("bulk audio backfill skips approved short references without planned narration", async t => {
  const store = createStore(":memory:", {
    externalTtsProfiles: { "f5-ru-v1": { engine: "f5", language: "ru" } },
    normalizeExternalText: Object.assign(async text => text, { version: "plain-v1" }),
  });
  t.after(() => store.close());
  store.importPlaces(catalog);
  store.createBatch({ requestKey: "short-reference", placeIds: ["osm:node:1"], limit: 1, mode: "text-only" });
  const job = store.claimContentJob();
  store.completeContentJob(job.id, {
    story: { title: "Короткая справка", audioDisposition: "not_applicable_short_text",
      paragraphs: [{ text: "Подтверждённых сведений достаточно только для короткой справки.", factIds: [] }] },
    evidence: {}, autoApprove: false,
  });
  store.approvePlaceText(job.place.id);
  const result = await store.enqueueMissingPlaceAudio({ profileId: "f5-ru-v1" });
  assert.equal(result.inspected, 0);
  assert.equal(result.queued, 0);
  assert.deepEqual(store.getContentStats().external, {});
});

test("job migrations add profile versions and priorities to existing databases",t=>{
  const directory=mkdtempSync(join(tmpdir(),"content-migration-")),file=join(directory,"jobs.sqlite");t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const db=new DatabaseSync(file);db.exec(`CREATE TABLE content_jobs (id TEXT PRIMARY KEY,input_key TEXT NOT NULL UNIQUE,place_id TEXT NOT NULL,state TEXT NOT NULL,
    profile TEXT NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,max_attempts INTEGER NOT NULL DEFAULT 3,next_attempt_at TEXT NOT NULL,
    checkpoint_json TEXT,error_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);db.close();
  const store=createStore(file);store.close();const migrated=new DatabaseSync(file,{readOnly:true});
  const columns=new Set(migrated.prepare("PRAGMA table_info(content_jobs)").all().map(column=>column.name));migrated.close();
  assert.ok(columns.has("profile_version"));assert.ok(columns.has("priority"));
});

test("catalog pages report totals and whether a text exists for each place",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const first=store.listPlaces({limit:1,offset:0});
  assert.equal(first.total,2);assert.equal(first.places.length,1);assert.equal(first.hasMore,true);
  assert.deepEqual(first.places.map(place=>place.textStatus),["none"]);
  const second=store.listPlaces({limit:1,offset:1});
  assert.equal(second.hasMore,false);assert.notEqual(second.places[0].id,first.places[0].id);
  assert.equal(store.listPlaces({q:"Музей"}).total,1);
  store.createBatch({requestKey:"catalog-page-1",name:"Pages",limit:2});
  const job=store.claimContentJob();
  store.completeContentJob(job.id,{story:{title:"Текст",paragraphs:[{text:"Абзац",factIds:["f1"]}]},evidence:{facts:[]}});
  assert.equal(store.listPlaces().places.find(place=>place.id===job.place.id).textStatus,"draft");
  assert.deepEqual(store.listPlaces({status:"draft"}).places.map(place=>place.id),[job.place.id]);
  assert.equal(store.listPlaces({status:"draft",q:"несуществующее место"}).total,0);
  store.approvePlaceText(job.place.id);
  assert.equal(store.listPlaces().places.find(place=>place.id===job.place.id).textStatus,"approved");
  assert.equal(store.listPlaces({status:"draft"}).total,0);
  assert.equal(store.listPlaces({status:"ready"}).total,1);
  assert.equal(store.listPlaces({status:"missing"}).total,1);
});

test("batch items are paged and filtered by the same status buckets the editor offers",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"items-page-1",name:"Items",limit:2});
  assert.equal(store.listBatchItems("00000000-0000-4000-8000-000000000000"),null);
  const all=store.listBatchItems(batch.id,{limit:1,offset:0});
  assert.equal(all.total,2);assert.equal(all.items.length,1);assert.equal(all.hasMore,true);
  assert.equal(store.listBatchItems(batch.id,{limit:1,offset:1}).hasMore,false);
  assert.equal(store.listBatchItems(batch.id,{status:"waiting"}).total,2);
  assert.equal(store.listBatchItems(batch.id,{status:"ready"}).total,0);
  const job=store.claimContentJob();
  assert.equal(store.listBatchItems(batch.id,{status:"working"}).total,1);
  store.completeContentJob(job.id,{story:{title:"Текст",paragraphs:[{text:"Абзац",factIds:["f1"]}]},evidence:{facts:[]},autoApprove:true});
  assert.deepEqual(store.listBatchItems(batch.id,{status:"ready"}).items.map(item=>item.state),["ready"]);
  store.setBatchState(batch.id,"cancelled");
  assert.equal(store.listBatchItems(batch.id,{status:"stopped"}).total,1);
  for(const invalid of [{limit:0},{limit:201},{offset:-1},{status:"unknown"}]) {
    assert.throws(()=>store.listBatchItems(batch.id,invalid),{code:"BAD_REQUEST"});
  }
});

test("a stopped batch item explains itself: coordinates, found pages lined up with fetch failures, and the model's verdict",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"item-detail-1",name:"Detail",placeIds:["osm:node:1"],limit:1});
  assert.equal(store.getBatchItemDetail(batch.id,"osm:way:2"),null);
  assert.equal(store.getBatchItemDetail("00000000-0000-4000-8000-000000000000","osm:node:1"),null);
  const fresh=store.getBatchItemDetail(batch.id,"osm:node:1");
  assert.deepEqual(fresh.location,{lat:55.75,lon:37.61});assert.equal(fresh.tags.historic,"memorial");
  assert.deepEqual(fresh.sources,[]);assert.equal(fresh.model,null);
  const job=store.claimContentJob();
  store.updateContentCheckpoint(job.id,{
    research:{sources:[{url:"https://a.example/1",title:"Первый"},{url:"https://b.example/2",title:"Второй"},{url:"https://c.example/3",title:"Третий"}]},
    sources:[{id:"s2",url:"https://b.example/2?r=1",title:"Второй",publisher:"b.example",text:"x".repeat(1200)}],
    sourceFailures:["SOURCE_EMPTY","FETCH_TIMEOUT"],
    factsRejection:{code:"PLACE_UNCLEAR",addressConfirmed:false,identityConfirmed:false,identityNote:"Источники о человеке, а не о доске",
      placeName:"Левон Айрапетян",resolvedAddress:"Москва",facts:[{claim:"Родился в 1911 году",kind:"content",subjectRelation:"site_context",evidence:[{sourceId:"s2",quote:"родился в 1911 году"}]}]},
  });
  store.failContentJob(job.id,{code:"PLACE_UNCLEAR",message:"PLACE_UNCLEAR"},"review_required");
  const item=store.getBatchItemDetail(batch.id,"osm:node:1");
  assert.equal(item.state,"review_required");assert.equal(item.error.code,"PLACE_UNCLEAR");
  assert.deepEqual(item.sources,[
    {url:"https://a.example/1",title:"Первый",sourceId:null,publisher:null,chars:0,failure:"SOURCE_EMPTY",openData:null,origin:null},
    {url:"https://b.example/2?r=1",title:"Второй",sourceId:"s2",publisher:"b.example",chars:1200,failure:null,openData:null,origin:null},
    {url:"https://c.example/3",title:"Третий",sourceId:null,publisher:null,chars:0,failure:"FETCH_TIMEOUT",openData:null,origin:null},
  ]);
  assert.equal(JSON.stringify(item).includes("x".repeat(100)),false);
  assert.equal(item.model.outcome,"rejected");assert.equal(item.model.identityConfirmed,false);
  assert.equal(item.model.identityNote,"Источники о человеке, а не о доске");assert.equal(item.model.facts[0].evidence[0].sourceId,"s2");
});

test("a batch item past the facts step reports the accepted identification",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"item-detail-2",name:"Detail",placeIds:["osm:node:1"],limit:1});
  const job=store.claimContentJob();
  store.updateContentCheckpoint(job.id,{sources:[{id:"s1",url:"https://a.example/1",title:"Первый",publisher:"a.example",text:"текст"}],
    evidence:{placeName:"Памятник",resolvedAddress:"Москва, Тверская",addressConfirmed:true,identityNote:"Совпадают название и место",
      facts:[{id:"f1",claim:"Открыт в 1950 году",kind:"identity",subjectRelation:"object",topic:"place_history",evidence:[{sourceId:"s1",quote:"открыт в 1950 году"}]}]}});
  store.failContentJob(job.id,{code:"REVIEW_REQUIRED",message:"REVIEW_REQUIRED"},"review_required");
  const item=store.getBatchItemDetail(batch.id,"osm:node:1");
  // Without a search step on record the fetched pages are listed as they are.
  assert.deepEqual(item.sources,[{url:"https://a.example/1",title:"Первый",sourceId:"s1",publisher:"a.example",chars:5,failure:null,openData:null,origin:null}]);
  assert.deepEqual(item.model,{outcome:"accepted",identityConfirmed:true,addressConfirmed:true,placeName:"Памятник",resolvedAddress:"Москва, Тверская",
    identityNote:"Совпадают название и место",facts:[{claim:"Открыт в 1950 году",kind:"identity",subjectRelation:"object",evidence:[{sourceId:"s1",quote:"открыт в 1950 году"}]}]});
});

test("batch items filter by error code and report the codes present in the current status bucket",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"items-error-1",name:"Errors",limit:2});
  const unclear=store.claimContentJob();store.failContentJob(unclear.id,{code:"ADDRESS_UNCLEAR",message:"ADDRESS_UNCLEAR"},"review_required");
  const review=store.claimContentJob();store.failContentJob(review.id,{code:"REVIEW_REQUIRED",message:"REVIEW_REQUIRED"},"review_required");
  const all=store.listBatchItems(batch.id);
  assert.deepEqual(all.errors,[{code:"ADDRESS_UNCLEAR",count:1},{code:"REVIEW_REQUIRED",count:1}]);
  const unclearOnly=store.listBatchItems(batch.id,{error:"ADDRESS_UNCLEAR"});
  assert.equal(unclearOnly.total,1);
  assert.deepEqual(unclearOnly.items.map(item=>item.error.code),["ADDRESS_UNCLEAR"]);
  // The code list ignores the error filter, so the editor can switch straight to another code.
  assert.deepEqual(unclearOnly.errors,all.errors);
  assert.equal(store.listBatchItems(batch.id,{error:"none"}).total,0);
  assert.equal(store.listBatchItems(batch.id,{status:"ready",error:"ADDRESS_UNCLEAR"}).total,0);
  assert.deepEqual(store.listBatchItems(batch.id,{status:"ready"}).errors,[]);
  assert.equal(store.listBatchItems(batch.id,{error:"NEVER_HAPPENED"}).total,0);
  store.retryBatchItem(batch.id,unclear.place.id,{restartFrom:"auto"});
  assert.deepEqual(store.listBatchItems(batch.id,{status:"waiting"}).errors,[{code:null,count:1}]);
  assert.equal(store.listBatchItems(batch.id,{status:"waiting",error:"none"}).total,1);
  for(const invalid of [{error:""},{error:"lowercase"},{error:"WITH SPACE"},{error:"A".repeat(65)},{error:5}]) {
    assert.throws(()=>store.listBatchItems(batch.id,/** @type {any} */ (invalid)),{code:"BAD_REQUEST"});
  }
});

test("a batch without an explicit list takes only the next eligible places without a text job",t=>{
  const store=createStore(":memory:");t.after(()=>store.close());
  const point={lat:55.75,lon:37.61};
  store.importPlaces({...catalog,places:[
    {placeId:"osm:node:21",osmType:"node",osmId:21,name:"А. Б. Иванову",location:point,tags:{historic:"memorial"}},
    {placeId:"osm:node:22",osmType:"node",osmId:22,name:"Бобёр",location:point,tags:{tourism:"artwork"}},
    {placeId:"osm:node:23",osmType:"node",osmId:23,name:"Галерея на Арбате",location:point,tags:{tourism:"gallery","addr:street":"Арбат","addr:housenumber":"3"}},
    {placeId:"osm:node:24",osmType:"node",osmId:24,name:"Дом с идентификатором",location:point,tags:{historic:"building",wikidata:"Q24"}},
  ]});
  const first=store.createBatch({requestKey:"eligible-0001",name:"Next",limit:1});
  assert.deepEqual(store.getBatch(first.id).items.map(item=>item.placeId),["osm:node:23"],"weakly identified places come first alphabetically but are skipped");
  const second=store.createBatch({requestKey:"eligible-0002",name:"Next",limit:5});
  assert.deepEqual(store.getBatch(second.id).items.map(item=>item.placeId),["osm:node:24"],"already queued places are not taken again");
  assert.throws(()=>store.createBatch({requestKey:"eligible-0003",name:"Next",limit:5}),{code:"NO_ELIGIBLE_PLACES"});
  assert.equal(store.createBatch({requestKey:"eligible-0002",name:"Repeat",limit:5}).id,second.id,"a repeated request still returns the first batch");
});

test("restart from facts keeps fetched sources and drops everything derived from them", t => {
  const store = createStore(":memory:", { maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
  const batch = store.createBatch({ requestKey: "restart-facts", placeIds: ["osm:node:1"], limit: 1 });
  const job = store.claimContentJob();
  const checkpoint = { research: { sources: [{ url: "https://one.example" }] }, sources: [{ id: "s1", text: "Текст" }], sourceFailures: [], locationContext: { status: "matched" },
    evidence: { facts: [] }, editorialVersion: 2, factsRejection: { code: "PLACE_UNCLEAR" }, draft: { title: "Черновик" }, draftCandidateRaw: { text: "Черновик" },
    review: { approved: false }, reviewRounds: [{ round: 1 }] };
  store.updateContentCheckpoint(job.id, checkpoint);
  store.failContentJob(job.id, { code: "REVIEW_REQUIRED", message: "Проверка" }, "review_required");
  assert.ok(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "facts" }));
  const retried = store.claimContentJob();
  assert.deepEqual(Object.keys(retried.checkpoint).sort(), ["locationContext", "research", "sourceFailures", "sources"]);
  assert.equal(retried.attempts, 1);
});

test("a queued item can be reset to an earlier stage, but auto retry leaves it alone", t => {
  const store = createStore(":memory:", { maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
  const batch = store.createBatch({ requestKey: "restart-queued", placeIds: ["osm:node:1"], limit: 1 });
  const job = store.claimContentJob();
  store.updateContentCheckpoint(job.id, { sources: [{ id: "s1" }], evidence: { facts: [] } });
  store.failContentJob(job.id, { code: "REVIEW_REQUIRED", message: "Проверка" }, "review_required");
  assert.ok(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "auto" }));
  assert.equal(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "auto" }), null);
  assert.ok(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "facts" }));
  assert.deepEqual(store.claimContentJob().checkpoint, { sources: [{ id: "s1" }] });
  assert.throws(() => store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "draft" }), { code: "BAD_REQUEST" });
});

test("restart from facts on a job without a checkpoint starts clean", t => {
  const store = createStore(":memory:", { maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
  const batch = store.createBatch({ requestKey: "restart-empty", placeIds: ["osm:node:1"], limit: 1 });
  assert.ok(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "facts" }));
  assert.equal(store.claimContentJob().checkpoint, null);
});

function clockedStore(t, requestKey) {
  let time = Date.parse("2026-09-27T12:00:00Z");
  const store = createStore(":memory:", { maxActive: 100, now: () => time }); t.after(() => store.close()); store.importPlaces(catalog);
  store.createBatch({ requestKey, placeIds: ["osm:node:1"], limit: 1 });
  return { store, later: () => { time += 10 * 60000; } };
}

test("a provider outage gives the attempt back, while the job's own failure still counts", t => {
  const { store, later } = clockedStore(t, "outage-refund");
  // Far more outages than max_attempts (3): the job must keep waiting, not fail.
  for (let round = 0; round < 5; round++) {
    const job = store.claimContentJob();
    assert.ok(job, `round ${round}: the job is claimable again`);
    assert.equal(store.failContentJob(job.id, { code: "PROVIDER_BUSY", message: "Занят" }, "failed", { countAttempt: false }).state, "retry_wait");
    later();
  }
  const job = store.claimContentJob();
  assert.equal(job.attempts, 6);
  assert.equal(store.failContentJob(job.id, { code: "INVALID_DRAFT", message: "Черновик" }, "failed").state, "failed");
});

test("a counted retryable failure stops at max_attempts", t => {
  const { store, later } = clockedStore(t, "outage-counted");
  const states = [];
  for (let round = 0; round < 3; round++) { const job = store.claimContentJob(); states.push(store.failContentJob(job.id, { code: "TIMEOUT", message: "Долго" }).state); later(); }
  assert.deepEqual(states, ["retry_wait", "retry_wait", "failed"]);
  assert.equal(store.claimContentJob(), null);
});

test("a refund does not turn a non-retryable failure into a retry", t => {
  const { store } = clockedStore(t, "outage-nonretry");
  const job = store.claimContentJob();
  assert.equal(store.failContentJob(job.id, { code: "INVALID_DRAFT", message: "Черновик" }, "failed", { countAttempt: false }).state, "failed");
});

test("content stats sum model tokens across checkpoints and ignore jobs without usage", t => {
  const store = createStore(":memory:", { maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
  store.createBatch({ requestKey: "usage-stats", placeIds: ["osm:node:1", "osm:way:2"], limit: 2 });
  assert.equal(store.getContentStats().textUsageTokens, 0);
  const first = store.claimContentJob(), second = store.claimContentJob();
  store.updateContentCheckpoint(first.id, { usageTokens: 1200, sources: [{ id: "s1", text: "Текст ".repeat(1000) }] });
  store.updateContentCheckpoint(second.id, { sources: [] });
  assert.equal(store.getContentStats().textUsageTokens, 1200);
  store.updateContentCheckpoint(second.id, { usageTokens: 35.5 });
  assert.equal(store.getContentStats().textUsageTokens, 1235.5);
});

test("open-data matches are replaced per dataset and go stale when the place changes",t=>{
  const store=createStore(":memory:");t.after(()=>store.close());store.importPlaces(catalog,{complete:true});
  const item=(placeId,datasetId,recordId)=>({placeId,record:{datasetId,recordId,kind:datasetId===2801?"plaque":"sculpture",name:"Доска",fields:{Name:"Доска"}},match:{rule:"test",distanceM:5}});
  assert.throws(()=>store.replaceOpenDataMatches([item("osm:node:1",60869,"1")],{datasetId:2801,datasetVersion:"1"}),{code:"BAD_REQUEST"});
  assert.deepEqual(store.replaceOpenDataMatches([item("osm:node:1",2801,"10"),item("osm:node:404",2801,"11")],{datasetId:2801,datasetVersion:"3.14"}),
    {datasetId:2801,datasetVersion:"3.14",stored:1,skipped:1,importedAt:store.getOpenDataSources("osm:node:1")[0].importedAt});
  store.replaceOpenDataMatches([item("osm:node:1",60869,"20")],{datasetId:60869,datasetVersion:"1.16"});
  assert.deepEqual(store.getOpenDataSources("osm:node:1").map(row=>[row.datasetId,row.record.recordId]),[[2801,"10"],[60869,"20"]]);
  // A new import of one dataset leaves the other dataset's matches alone.
  store.replaceOpenDataMatches([],{datasetId:2801,datasetVersion:"3.15"});
  assert.deepEqual(store.getOpenDataSources("osm:node:1").map(row=>row.datasetId),[60869]);
  // The place changed in a later catalog import: the stored record no longer applies.
  store.importPlaces({...catalog,sourceSha256:"d".repeat(64),places:[{...catalog.places[0],name:"Памятник героям"},catalog.places[1]]},{complete:true});
  assert.deepEqual(store.getOpenDataSources("osm:node:1"),[]);
});

test("open-data records head the item's sources with their dataset, before the search results",t=>{
  const store=createStore(":memory:",{maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"item-detail-open",name:"Detail",placeIds:["osm:node:1"],limit:1});
  const job=store.claimContentJob();
  store.updateContentCheckpoint(job.id,{research:{sources:[{url:"https://a.example/1",title:"Первый"}]},
    sources:[{id:"d1",url:"https://data.mos.ru/opendata/2801",title:"Портал открытых данных",publisher:"data.mos.ru",text:"доска",openData:{datasetId:2801,recordId:"42",datasetVersion:"3.86"}},
      {id:"s1",url:"https://a.example/1",title:"Первый",publisher:"a.example",text:"страница"}],sourceFailures:[]});
  store.failContentJob(job.id,{code:"REVIEW_REQUIRED",message:"REVIEW_REQUIRED"},"review_required");
  assert.deepEqual(store.getBatchItemDetail(batch.id,"osm:node:1").sources,[
    {url:"https://data.mos.ru/opendata/2801",title:"Портал открытых данных",sourceId:"d1",publisher:"data.mos.ru",chars:5,failure:null,openData:{datasetId:2801,recordId:"42",datasetVersion:"3.86"},origin:null},
    {url:"https://a.example/1",title:"Первый",sourceId:"s1",publisher:"a.example",chars:8,failure:null,openData:null,origin:null},
  ]);
});

// Draft re-research through the search model: which drafts are queued, and how completion replaces them.
function draftStore(t, count = 4) {
  let clock = Date.parse("2026-09-29T10:00:00Z");
  const store = createStore(":memory:", { maxActive: 100, now: () => clock += 60000 }); t.after(() => store.close());
  const places = Array.from({ length: count }, (_, index) => ({ ...catalog.places[0], placeId: `osm:node:${index + 1}`, osmId: index + 1, name: `Место ${index + 1}` }));
  store.importPlaces({ ...catalog, places });
  store.createBatch({ requestKey: "draft-drafts-key", placeIds: places.map(place => place.placeId), limit: count, identityPolicy: "weak_identity" });
  const story = title => ({ title, paragraphs: [{ text: `Текст: ${title}`, factIds: ["f1"] }] });
  // Each text gets a later clock tick; the order of claims decides which draft is the oldest.
  const order = [];
  for (let index = 0; index < count; index++) {
    const job = store.claimContentJob(); order.push(job.place.id);
    store.completeContentJob(job.id, { story: story(`старый ${job.place.id}`), evidence: { facts: [] } });
  }
  const draft = placeId => store.listDrafts({ limit: 100 }).items.find(item => item.placeId === placeId);
  return { store, story, order, draft };
}

test("draft re-research takes the oldest unprocessed drafts, skipping approved and busy ones", t => {
  const { store, order } = draftStore(t, 5);
  const [oldest, second, third] = order;
  store.approvePlaceText(oldest);
  assert.equal(store.listDrafts().unresearched, 4);
  const { batch, count } = store.researchDrafts({ requestKey: "draft-bulk-1-key", limit: 1 });
  assert.equal(count, 1);
  assert.equal(batch.identityPolicy, "weak_identity");
  assert.deepEqual(store.getBatch(batch.id).items.map(item => [item.placeId, item.state]), [[second, "queued"]]);
  // A queued draft is not picked again; the next oldest is.
  const next = store.researchDrafts({ requestKey: "draft-bulk-2-key", limit: 1 });
  assert.deepEqual(store.getBatch(next.batch.id).items.map(item => item.placeId), [third]);
  const job = store.claimContentJob();
  assert.equal(job.place.id, second);
  assert.deepEqual(job.checkpoint, { researchMode: "perplexity_required" });
  // A repeated request key returns the first batch without queuing more.
  assert.equal(store.researchDrafts({ requestKey: "draft-bulk-1-key", limit: 5 }).batch.id, batch.id);
});

test("drafts already researched through Perplexity are skipped in bulk but can be repeated one by one", t => {
  const { store, order, story } = draftStore(t, 2);
  store.researchDrafts({ requestKey: "draft-one-key", placeIds: [order[0]] });
  const job = store.claimContentJob();
  store.updateContentCheckpoint(job.id, { ...job.checkpoint, research: { sources: [], perplexity: { status: "ok", count: 3 } } });
  store.completeContentJob(job.id, { story: story("новый"), evidence: { facts: [] }, replaceDraft: true });
  assert.equal(store.listDrafts().unresearched, 1);
  const bulk = store.researchDrafts({ requestKey: "draft-bulk-key", limit: 50 });
  assert.deepEqual(store.getBatch(bulk.batch.id).items.map(item => item.placeId), [order[1]]);
  assert.throws(() => store.researchDrafts({ requestKey: "bulk-again", limit: 50 }), { code: "NO_DRAFTS_TO_RESEARCH" });
  const repeat = store.researchDrafts({ requestKey: "draft-repeat-key", placeIds: [order[0]] });
  assert.equal(repeat.count, 1);
});

test("draft re-research validates its input", t => {
  const { store } = draftStore(t, 1);
  for (const input of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { requestKey: "" }, { placeIds: [] }, { placeIds: ["../etc"] },
    { placeIds: Array.from({ length: 51 }, (_, index) => `osm:node:${index + 1}`) }, { placeIds: "osm:node:1" }]) {
    assert.throws(() => store.researchDrafts(/** @type {any} */ ({ requestKey: "draft-validation", ...input })), { code: "BAD_REQUEST" }, JSON.stringify(input));
  }
  assert.throws(() => store.researchDrafts({ requestKey: "draft-unknown-key", placeIds: ["osm:node:999"] }), { code: "NO_DRAFTS_TO_RESEARCH" });
  assert.equal(store.researchDrafts({ requestKey: "draft-max-key", limit: 50 }).count, 1);
});

test("a completed re-research replaces only an unapproved draft", async t => {
  for (const [approvedBefore, expected] of [[false, "новый"], [true, "старый osm:node:1"]]) {
    await t.test(`approved: ${approvedBefore}`, t => {
      const { store, story, draft } = draftStore(t, 1);
      const before = draft("osm:node:1");
      store.researchDrafts({ requestKey: "draft-redo-key", placeIds: ["osm:node:1"] });
      const job = store.claimContentJob();
      if (approvedBefore) store.approvePlaceText("osm:node:1");
      const result = store.completeContentJob(job.id, { story: story("новый"), evidence: { facts: [{ claim: "Новый факт" }] }, replaceDraft: true });
      assert.equal(result.id, before.text.id);
      if (approvedBefore) assert.equal(store.getPlace("osm:node:1").text.story.title, expected);
      else {
        assert.equal(draft("osm:node:1").text.title, expected);
        assert.ok(draft("osm:node:1").text.createdAt > before.text.createdAt);
      }
    });
  }
});

test("completion without replaceDraft keeps an existing text as before", t => {
  const { store, story, draft } = draftStore(t, 1);
  store.researchDrafts({ requestKey: "draft-redo-key", placeIds: ["osm:node:1"] });
  store.completeContentJob(store.claimContentJob().id, { story: story("новый"), evidence: { facts: [] } });
  assert.equal(draft("osm:node:1").text.title, "старый osm:node:1");
});

test("draft research status follows the latest text's job and filters the list by it", t => {
  const { store, story, draft, order } = draftStore(t, 3);
  assert.deepEqual(store.listDrafts({ limit: 100 }).items.map(item => item.research), ["plain", "plain", "plain"]);
  assert.deepEqual(store.listDrafts().counts, { plain: 3 });
  assert.equal(store.listDrafts({ research: "plain", limit: 100 }).total, 3);
  assert.equal(store.listDrafts({ research: "perplexity", limit: 100 }).total, 0);
  for (const research of /** @type {any[]} */ (["bogus", "", null, 3])) assert.throws(() => store.listDrafts({ research }), { code: "BAD_REQUEST" }, JSON.stringify(research));

  // A queued or working re-research stands in place of the still-current old text.
  store.researchDrafts({ requestKey: "draft-status-1", placeIds: [order[0]] });
  assert.equal(draft(order[0]).research, "queued");
  const job = store.claimContentJob();
  assert.equal(job.place.id, order[0]);
  assert.equal(draft(order[0]).research, "queued");
  assert.deepEqual(store.listDrafts().counts, { plain: 2, queued: 1 });
  assert.deepEqual(store.listDrafts({ research: "queued", limit: 100 }).items.map(item => item.placeId), [order[0]]);

  // A completed re-research through Perplexity marks the replaced draft.
  store.updateContentCheckpoint(job.id, { ...job.checkpoint, research: { sources: [], perplexity: { status: "ok", count: 3 } } });
  store.completeContentJob(job.id, { story: story("новый"), evidence: { facts: [] }, replaceDraft: true });
  assert.equal(draft(order[0]).research, "perplexity");
  assert.deepEqual(store.listDrafts().counts, { plain: 2, perplexity: 1 });

  // A failed re-research keeps the old draft text and reports the failure.
  store.researchDrafts({ requestKey: "draft-status-2", placeIds: [order[1]] });
  const failing = store.claimContentJob();
  store.failContentJob(failing.id, { code: "PERPLEXITY_UNAVAILABLE", message: "Perplexity недоступен" }, "failed", { countAttempt: false });
  assert.equal(draft(order[1]).research, "failed");
  assert.equal(draft(order[1]).text.title, `старый ${order[1]}`);
  assert.deepEqual(store.listDrafts().counts, { plain: 1, perplexity: 1, failed: 1 });
  assert.deepEqual(store.listDrafts({ research: "failed", limit: 100 }).items.map(item => item.placeId), [order[1]]);
});

test("deep draft research is explicit, single-place and idempotent", t => {
  const {store,order}=draftStore(t,2);
  for(const input of [{mode:"deep"},{mode:"deep",placeIds:order},{mode:"unknown",placeIds:[order[0]]}])
    assert.throws(()=>store.researchDrafts({requestKey:"deep-invalid-key",...input}),{code:"BAD_REQUEST"});
  const input={requestKey:"deep-draft-single",placeIds:[order[0]],mode:"deep"};
  const result=store.researchDrafts(input);
  assert.equal(result.count,1);
  assert.equal(store.researchDrafts(input).batch.id,result.batch.id);
  assert.throws(()=>store.researchDrafts({...input,placeIds:[order[1]]}),{code:"BAD_REQUEST"});
  assert.throws(()=>store.researchDrafts({...input,mode:"search"}),{code:"BAD_REQUEST"});
  const job=store.claimContentJob();
  assert.equal(job.place.id,order[0]);
  assert.equal(job.checkpoint.researchMode,"perplexity_deep_required");
  store.failContentJob(job.id,{code:"DEEP_RESEARCH_UNAVAILABLE"},"failed");
  assert.equal(store.listDrafts({research:"failed"}).items[0].placeId,order[0]);
  assert.equal(store.getPlace(order[0]).text.draft.title.includes("новый"),false);
  store.updateContentCheckpoint(job.id,{researchMode:"perplexity_deep_required",deepResearchStarted:true});
  store.retryBatchItem(result.batch.id,order[0],{restartFrom:"research"});
  assert.deepEqual(store.claimContentJob().checkpoint,{researchMode:"perplexity_deep_required"});
});


test("catalog bounds filter before pagination and include rectangle edges", t => {
  const store = createStore(":memory:"); t.after(() => store.close());
  store.importPlaces(catalog);
  const bounds = { west: 37.6, south: 55.74, east: 37.61, north: 55.75 };
  const result = store.listPlaces({ bounds, limit: 1 });
  assert.deepEqual(result.places.map(place => place.id), ["osm:node:1"]);
  assert.equal(result.total, 1); assert.equal(result.hasMore, false);
  assert.equal(store.listPlaces({ bounds, offset: 1 }).places.length, 0);
  assert.equal(store.listPlaces({ bounds: { ...bounds, north: 55.749 } }).total, 0);
  for (const invalid of [
    { ...bounds, west: NaN }, { ...bounds, north: 91 }, { ...bounds, east: 181 },
    { ...bounds, west: 38 }, { ...bounds, south: 56 }, { ...bounds, east: bounds.west },
  ]) assert.throws(() => store.listPlaces({ bounds: invalid }), { code: "BAD_REQUEST" });
  assert.throws(() => store.listPlaces({ bounds, lat: 55.75, lon: 37.61, radius: 200 }), { code: "BAD_REQUEST" });
});

test("map cells expose only ready places with the latest approved story and audio", async t => {
  const store = createStore(":memory:", { maxActive: 100 });
  t.after(() => store.close());
  const places = [
    { placeId: "osm:node:1", osmType: "node", osmId: 1, name: "Памятник", location: { lat: 55.75, lon: 37.61 }, tags: {} },
    { placeId: "osm:node:2", osmType: "node", osmId: 2, name: "Нижняя граница", location: { lat: 55, lon: 37 }, tags: {} },
    { placeId: "osm:node:3", osmType: "node", osmId: 3, name: "Верхняя граница", location: { lat: 56, lon: 37.5 }, tags: {} },
    { placeId: "osm:node:4", osmType: "node", osmId: 4, name: "Архивное", location: { lat: 55.5, lon: 37.5 }, tags: {} },
    { placeId: "osm:node:5", osmType: "node", osmId: 5, name: "Черновик", location: { lat: 55.6, lon: 37.6 }, tags: {} },
  ];
  store.importPlaces({ ...catalog, places }, { complete: true });
  store.createBatch({ requestKey: "map-cells-1", placeIds: places.map(place => place.placeId), limit: 5 });
  const story = title => ({ title, paragraphs: [{ text: "Текст", factIds: [] }], facts: [{ id: "f1" }, { id: "f2" }], sources: [{ id: "s1" }] });
  for (let job = store.claimContentJob(); job; job = store.claimContentJob()) {
    store.completeContentJob(job.id, { story: story(`История ${job.place.name}`), evidence: {}, autoApprove: job.place.id !== "osm:node:5" });
  }
  const etag = () => store.listMapCells().find(cell => cell.lat === 55 && cell.lon === 37)?.etag;
  const ids = () => store.getMapCell(55, 37).points.map(point => point.id).sort();

  // The unapproved draft (node 5) stays off the map; the lower cell edge is inclusive and the upper one exclusive.
  assert.deepEqual(ids(), ["osm:node:1", "osm:node:2", "osm:node:4"]);
  assert.deepEqual(store.getMapCell(56, 37).points.map(point => point.id), ["osm:node:3"]);
  assert.deepEqual(store.listMapCells().map(cell => [cell.lat, cell.lon, cell.count]), [[55, 37, 3], [56, 37, 1]]);
  assert.deepEqual(store.getMapCell(55, 37).points.find(point => point.id === "osm:node:1"),
    { id: "osm:node:1", lat: 55.75, lon: 37.61, title: "История Памятник", address: "Памятник", durationSec: null, facts: 2, sources: 1 });
  for (const cell of store.listMapCells()) {
    const { points } = store.getMapCell(cell.lat, cell.lon);
    assert.equal(cell.etag, etagOf(serializeCell(cell, points)));
  }

  // An editor's newer approved text wins; it changes the cell ETag.
  let before = etag();
  store.approvePlaceText("osm:node:1", story("Новая история"));
  assert.equal(store.getMapCell(55, 37).points.find(point => point.id === "osm:node:1").title, "Новая история");
  assert.notEqual(etag(), before);

  // Approved audio adds the duration.
  before = etag();
  const text = store.getPublishedPlace("osm:node:2").text;
  const queued = await store.enqueueExternalAudio({ sourceJobId: `place-text:${text.id}`, sourceRevision: 0, story: { ...text.story, address: "Москва, Нижняя граница" } });
  const claim = store.claimExternalAudio({ workerId: "map-test", requestId: "map-audio-1", profileIds: [queued.profileId] });
  const artifact = { url: `/api/story-audio/${"b".repeat(64)}.mp3`, sha256: "b".repeat(64), durationSec: 42 };
  store.acceptExternalAudio(queued.id, { workerId: "map-test", generation: claim.leaseGeneration, leaseToken: claim.leaseToken, uploadId: "map-upload-1", uploadSha256: artifact.sha256, artifact });
  assert.equal(store.getMapCell(55, 37).points.find(point => point.id === "osm:node:2").durationSec, 42);
  assert.notEqual(etag(), before);

  // A complete import without a place archives it and drops it from the map.
  before = etag();
  store.importPlaces({ ...catalog, sourceSha256: "c".repeat(64), places: places.filter(place => place.placeId !== "osm:node:4") }, { complete: true });
  assert.deepEqual(ids(), ["osm:node:1", "osm:node:2"]);
  assert.notEqual(etag(), before);

  assert.deepEqual(store.getMapCell(-1, -1), { cell: { lat: -1, lon: -1 }, points: [] });
  for (const [lat, lon] of [[90, 0], [0, 180], [-91, 0], [0, -181], [1.5, 0], [Number.NaN, 0]]) {
    assert.throws(() => store.getMapCell(lat, lon), { code: "BAD_REQUEST" }, `${lat}:${lon}`);
  }
});

test("a newer unapproved draft does not replace the published map title", t => {
  const store = createStore(":memory:", { maxActive: 100 });
  t.after(() => store.close());
  store.importPlaces(catalog);
  store.createBatch({ requestKey: "map-draft-1", placeIds: ["osm:node:1"], limit: 1 });
  const first = store.claimContentJob();
  store.completeContentJob(first.id, { story: { title: "Одобренная", paragraphs: [{ text: "Текст", factIds: [] }] }, evidence: {}, autoApprove: true });
  store.createBatch({ requestKey: "map-draft-2", placeIds: ["osm:node:1"], limit: 1, textProfile: "description-v1" });
  const second = store.claimContentJob();
  store.completeContentJob(second.id, { story: { title: "Черновик", paragraphs: [{ text: "Текст", factIds: [] }] }, evidence: {} });
  assert.equal(store.getPlace("osm:node:1").text.draft.title, "Черновик");
  assert.equal(store.getMapCell(55, 37).points[0].title, "Одобренная");
});

test("place texts are indexed by place for the map queries", () => {
  const directory = mkdtempSync(join(tmpdir(), "map-index-"));
  try {
    const file = join(directory, "store.db");
    createStore(file).close();
    const db = new DatabaseSync(file, { readOnly: true });
    const indexes = db.prepare("PRAGMA index_list(place_texts)").all().map(index => index.name);
    db.close();
    assert.ok(indexes.includes("place_texts_place_idx"));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const photoRow = (overrides = {}) => ({ status: "ready", source: "wikidata", inputHash: "h", entityId: "Q1", commonsTitle: "File:A.jpg", commonsSha1: "a".repeat(40),
  thumbnailUrl: `/api/place-images/${"1".repeat(64)}.jpg`, srcUrl: `/api/place-images/${"2".repeat(64)}.jpg`, width: 960, height: 720, author: "NVO",
  license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg",
  attempts: 0, checkedAt: "2026-10-01T00:00:00.000Z", nextCheckAt: "2026-10-08T00:00:00.000Z", ...overrides });
const editorialPhoto = { thumbnail: "/images/places/node-1-aaaaaaaaaaaa.jpg", src: "/images/places/node-1-bbbbbbbbbbbb.jpg", width: 1280, height: 960,
  alt: "Редакционное фото", author: "Автор", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0" };
/** Both catalog places published (the draft "osm:node:3" stays unpublished). */
function photoStore(t) {
  const store = createStore(":memory:", { maxActive: 100 });t.after(() => store.close());
  store.importPlaces({ ...catalog, places: [...catalog.places, { placeId: "osm:node:3", osmType: "node", osmId: 3, name: "Черновик", location: { lat: 55.77, lon: 37.63 }, tags: { wikidata: "Q3" } }] });
  store.createBatch({ requestKey: "photo-batch-1", placeIds: ["osm:node:1", "osm:way:2", "osm:node:3"], limit: 3 });
  for (let job = store.claimContentJob(); job; job = store.claimContentJob())
    store.completeContentJob(job.id, { story: { title: `История ${job.place.name}`, paragraphs: [{ text: "Текст", factIds: [] }] }, evidence: {}, autoApprove: job.place.id !== "osm:node:3" });
  return store;
}

test("place_images is added to an existing database", t => {
  const directory = mkdtempSync(join(tmpdir(), "photo-migration-")), file = join(directory, "jobs.sqlite");t.after(() => rmSync(directory, { recursive: true, force: true }));
  const first = createStore(file);first.importPlaces(catalog);first.close();
  const db = new DatabaseSync(file);db.exec("DROP TABLE place_images");db.close();
  const store = createStore(file);
  try {
    assert.equal(store.getPlaceImageRow("osm:node:1"), null);
    assert.ok(store.savePlaceImage("osm:node:1", photoRow()));
  } finally { store.close(); }
});

test("the editorial catalog is mirrored, wins over the sync and rejects malformed entries", t => {
  const store = photoStore(t);
  store.savePlaceImage("osm:way:2", photoRow());
  assert.deepEqual(store.syncEditorialPlaceImages({ "osm:node:1": editorialPhoto, "osm:way:2": editorialPhoto }), { editorial: 2, removed: 0 });
  assert.equal(store.getPlaceImageRow("osm:way:2").source, "editorial");
  assert.equal(store.savePlaceImage("osm:node:1", photoRow()), null);
  assert.equal(store.getPublishedPlace("osm:node:1").photo.alt, "Редакционное фото");
  // An entry that left the catalog is handed over to the sync.
  assert.deepEqual(store.syncEditorialPlaceImages({ "osm:node:1": editorialPhoto }), { editorial: 1, removed: 1 });
  assert.equal(store.getPlaceImageRow("osm:way:2"), null);
  for (const broken of [[], { "node:1": editorialPhoto }, { "osm:node:1": { ...editorialPhoto, src: "https://example.org/a.jpg" } },
    { "osm:node:1": { ...editorialPhoto, width: 0 } }, { "osm:node:1": { ...editorialPhoto, author: " " } }, { "osm:node:1": { ...editorialPhoto, sourceUrl: "https://example.org/" } }])
    assert.throws(() => store.syncEditorialPlaceImages(broken), { code: "INVALID_EDITORIAL_CATALOG" }, JSON.stringify(broken).slice(0, 80));
  assert.equal(store.getPlaceImageRow("osm:node:1").source, "editorial");
});

test("due photos are published, non-editorial places, missing rows first", t => {
  const store = photoStore(t), ids = at => store.listDuePlaceImages({ now: at }).map(entry => entry.place.id);
  assert.deepEqual(ids("2026-10-01T00:00:00.000Z"), ["osm:node:1", "osm:way:2"]);
  assert.deepEqual(store.listDuePlaceImages()[0].place.tags, { historic: "memorial", wikidata: "Q1" });
  store.savePlaceImage("osm:node:1", photoRow({ nextCheckAt: "2026-10-05T00:00:00.000Z" }));
  assert.deepEqual(ids("2026-10-01T00:00:00.000Z"), ["osm:way:2"]);
  assert.deepEqual(ids("2026-10-06T00:00:00.000Z"), ["osm:way:2", "osm:node:1"]);
  assert.equal(store.markPlaceImagesDue({ placeIds: ["osm:node:1"], now: "2026-10-01T00:00:00.000Z" }), 1);
  assert.deepEqual(ids("2026-10-01T00:00:00.000Z"), ["osm:way:2", "osm:node:1"]);
  store.syncEditorialPlaceImages({ "osm:way:2": editorialPhoto });
  assert.equal(store.markPlaceImagesDue({ placeIds: null, now: "2026-10-01T00:00:00.000Z" }), 1);
  assert.deepEqual(ids("2026-10-01T00:00:00.000Z"), ["osm:node:1"]);
  assert.deepEqual([...store.listReferencedPlaceImageFiles()].sort(), [`${"1".repeat(64)}.jpg`, `${"2".repeat(64)}.jpg`]);
});

test("a reimport makes a photo due only when the place's identifiers change", t => {
  const store = photoStore(t), later = "2026-12-01T00:00:00.000Z", place = catalog.places[0];
  store.savePlaceImage("osm:node:1", photoRow({ inputHash: placeImageInputHash(place.tags), nextCheckAt: later }));
  store.importPlaces({ ...catalog, places: [{ ...place, name: "Памятник (новое имя)" }, catalog.places[1]] });
  assert.equal(store.getPlaceImageRow("osm:node:1").nextCheckAt, later);
  store.importPlaces({ ...catalog, places: [{ ...place, tags: { ...place.tags, wikidata: "Q7" } }, catalog.places[1]] });
  assert.ok(store.getPlaceImageRow("osm:node:1").nextCheckAt < later);
});

test("map points flag ready photos and the detail carries the photo", t => {
  const store = photoStore(t), etag = () => store.listMapCells()[0].etag, point = id => store.getMapCell(55, 37).points.find(item => item.id === id);
  const before = etag();
  assert.equal("photo" in point("osm:node:1"), false);
  store.savePlaceImage("osm:node:1", photoRow());
  assert.equal(point("osm:node:1").photo, true);
  assert.notEqual(etag(), before);
  assert.deepEqual(store.getPublishedPlace("osm:node:1").photo, { thumbnail: `/api/place-images/${"1".repeat(64)}.jpg`, src: `/api/place-images/${"2".repeat(64)}.jpg`,
    width: 960, height: 720, alt: "История Памятник", author: "NVO", sourceUrl: "https://commons.wikimedia.org/wiki/File:A.jpg", license: "CC BY-SA 4.0", licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0" });
  for (const status of ["none", "failed"]) {
    store.savePlaceImage("osm:node:1", photoRow({ status }));
    assert.equal(store.getPublishedPlace("osm:node:1").photo, null);
    assert.equal("photo" in point("osm:node:1"), false);
  }
  assert.equal(store.getPublishedPlace("osm:way:2").photo, null);
});
