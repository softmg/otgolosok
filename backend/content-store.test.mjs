import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createStore } from "./store.mjs";

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
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());
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
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"request-0003",name:"Paused",placeIds:["osm:node:1"],limit:1});
  store.setBatchState(batch.id,"paused");assert.equal(store.claimContentJob(),null);
  store.setBatchState(batch.id,"running");const job=store.claimContentJob();assert.ok(job);
  assert.equal(store.recoverContentJobs(),1);assert.equal(store.getBatch(batch.id).items[0].state,"retry_wait");
  assert.ok(store.retryBatchItem(batch.id,"osm:node:1"));
});

test("batch priority changes claim order without touching active jobs",t=>{
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const low=store.createBatch({requestKey:"priority-low",placeIds:["osm:node:1"],limit:1}),high=store.createBatch({requestKey:"priority-high",placeIds:["osm:way:2"],limit:1});
  assert.ok(store.setBatchPriority(high.id,100));assert.equal(store.claimContentJob().place.id,"osm:way:2");assert.equal(store.setBatchPriority("missing",1),null);assert.throws(()=>store.setBatchPriority(low.id,-1),{code:"BAD_REQUEST"});
});

test("a complete import archives absent places while partial imports preserve them",t=>{
  const store=createStore(":memory:");t.after(()=>store.close());store.importPlaces(catalog,{complete:true});
  store.importPlaces({...catalog,sourceSha256:"b".repeat(64),places:[catalog.places[0]]});assert.equal(store.listPlaces().places.length,2);
  store.importPlaces({...catalog,sourceSha256:"c".repeat(64),places:[catalog.places[0]]},{complete:true});assert.equal(store.listPlaces().places.length,1);
});

test("catalog nearby query returns approved cards ordered by distance",t=>{
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
  const batch=store.createBatch({requestKey:"nearby-query",placeIds:["osm:node:1"],limit:1});const job=store.claimContentJob();const story={title:"Готовая история",paragraphs:[{text:"Проверенный текст",factIds:["f1"]}]};
  store.completeContentJob(job.id,{story,evidence:{}});store.approvePlaceText("osm:node:1");
  const nearby=store.listPlaces({status:"ready",lat:55.7501,lon:37.6101,radius:1000});assert.equal(nearby.places[0].id,"osm:node:1");assert.ok(nearby.places[0].distanceM<20);
  assert.deepEqual(store.listWalkCandidates({lat:55.75,lon:37.61,radius:2000}).map(item=>[item.id,item.readiness]),[["osm:node:1","story"],["osm:way:2","none"]]);
  assert.equal(store.listPlaces({status:"ready",lat:55.9,lon:37.9,radius:100}).places.length,0);assert.equal(store.getBatch(batch.id).counts.ready,1);
});

test("bulk audio backfill queues only approved texts without audio and is idempotent", async t => {
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
  store.approvePlaceText(job.place.id);

  const first = await store.enqueueMissingPlaceAudio({ profileId: "f5-ru-v1", limit: 500 });
  assert.equal(first.queued, 1);
  assert.equal(first.hasMore, false);
  assert.equal(store.getExternalAudioStats().states.queued, 1);

  const second = await store.enqueueMissingPlaceAudio({ profileId: "f5-ru-v1", limit: 500 });
  assert.equal(second.queued, 0);
  assert.equal(second.inspected, 0);
  assert.equal(store.getExternalAudioStats().states.queued, 1);
  assert.equal(store.getBatch(batch.id).counts.ready, 1);
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
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
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
  store.approvePlaceText(job.place.id);
  assert.equal(store.listPlaces().places.find(place=>place.id===job.place.id).textStatus,"approved");
  assert.equal(store.listPlaces({status:"ready"}).total,1);
  assert.equal(store.listPlaces({status:"missing"}).total,1);
});

test("batch items are paged and filtered by the same status buckets the editor offers",t=>{
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
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

test("batch items filter by error code and report the codes present in the current status bucket",t=>{
  const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);
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
    assert.throws(()=>store.listBatchItems(batch.id,invalid),{code:"BAD_REQUEST"});
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
  const store = createStore(":memory:", { maxDaily: 100, maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
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
  const store = createStore(":memory:", { maxDaily: 100, maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
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
  const store = createStore(":memory:", { maxDaily: 100, maxActive: 100 }); t.after(() => store.close()); store.importPlaces(catalog);
  const batch = store.createBatch({ requestKey: "restart-empty", placeIds: ["osm:node:1"], limit: 1 });
  assert.ok(store.retryBatchItem(batch.id, "osm:node:1", { restartFrom: "facts" }));
  assert.equal(store.claimContentJob().checkpoint, null);
});
