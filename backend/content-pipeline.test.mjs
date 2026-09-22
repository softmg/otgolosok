import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";
import { contentFailureMessage, runContentJob, startContentWorker } from "./content-pipeline.mjs";
import { errorMessages } from "./pipeline.mjs";

const catalog={source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:1",osmType:"node",osmId:1,name:"Памятник без адреса",location:{lat:55.75,lon:37.61},tags:{historic:"memorial",wikidata:"Q1"}}]};
function fixture(t,{audio=false}={}){const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces(catalog);store.createBatch({requestKey:`pipeline-${audio?"audio":"text"}`,limit:1,mode:audio?"text-and-audio":"text-only",ttsProfile:audio?"silero-ru-v1":null});const url="https://one.example/place",page="Памятник установлен в Москве и создан известным архитектором. ".repeat(12);const facts=[1,2,3].map(index=>({claim:`Факт ${index}`,kind:"content",subjectRelation:"object",contentReason:"Раскрывает историю памятника",topic:"place_history",scope:"building",location:"Памятник",distanceMeters:null,evidence:[{sourceId:"s1",quote:"Памятник установлен в Москве и создан известным архитектором."}]}));const part="Памятник установлен в Москве и связан с историей города. Источник рассказывает о его создании и работе архитектора. ".repeat(3).trim(),text=`${part}\n\n${part}`;const queue=[{text:"Найден официальный источник",sources:[{url,title:"Источник"}]},{value:{addressConfirmed:true,identityNote:"Источник описывает памятник",placeName:"Памятник",resolvedAddress:"Памятник, Москва",facts}},{text},{value:{approved:true,issues:[],checks:{substantive:true,subjectAligned:true,audioClear:true},paragraphFacts:[{paragraph:1,factIds:["f1","f2"]},{paragraph:2,factIds:["f2","f3"]}],claims:[{paragraph:1,text:"Памятник установлен в Москве",factIds:["f1","f2"],supported:true,address:false},{paragraph:2,text:"Памятник установлен в Москве",factIds:["f2","f3"],supported:true,address:false}]}}];const provider={writerModel:"writer",response:async()=>({usage:{total_tokens:1},...queue.shift()})};return{store,provider,url,page,queue};}

test("OSM place uses plain writer text and one source",async t=>{const f=fixture(t);const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,fetchPage:async url=>({url,contentType:"text/html",html:f.page})});assert.equal(result.story.title,"Памятник");assert.equal(result.story.facts.length,3);});

test("auto approval queues audio only for full stories",async t=>{const f=fixture(t,{audio:true});const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,autoApprove:true,fetchPage:async url=>({url,contentType:"text/html",html:f.page})});assert.equal(result.story.audioDisposition,"eligible");assert.ok(f.store.claimExternalAudio({workerId:"gpu",requestId:"audio-request-0001",profileIds:["silero-ru-v1"]}));});

test("source access failure is distinct from missing evidence",async t=>{const f=fixture(t);const result=await runContentJob(f.store.claimContentJob(),{store:f.store,provider:f.provider,fetchPage:async()=>{throw Object.assign(new Error(),{code:"SOURCE_BLOCKED"});}});assert.equal(result.error.code,"SOURCE_ACCESS_FAILED");assert.equal(result.state,"retry_wait");});

test("content worker honors concurrency",async t=>{const places=Array.from({length:2},(_,index)=>({...catalog.places[0],placeId:`osm:node:${index+1}`,osmId:index+1,name:`Место ${index+1}`}));const store=createStore(":memory:",{maxDaily:100,maxActive:100});t.after(()=>store.close());store.importPlaces({...catalog,places});store.createBatch({requestKey:"pipeline-concurrency",limit:2});let active=0,peak=0,release;const gate=new Promise(resolve=>{release=resolve;});const provider={writerModel:"writer",response:async()=>{active++;peak=Math.max(peak,active);await gate;active--;throw Object.assign(new Error(),{code:"INSUFFICIENT_EVIDENCE"});}};const worker=startContentWorker({store,provider,concurrency:2});await new Promise(resolve=>setTimeout(resolve,20));assert.equal(peak,2);release();await worker.stop();});

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
  f.queue[1].value.addressConfirmed = false;
  f.queue[1].value.identityNote = "В источнике описан другой памятник";
  const result = await runContentJob(f.store.claimContentJob(), { store: f.store, provider: f.provider,
    fetchPage: async url => ({ url, contentType: "text/html", html: f.page }) });
  assert.equal(result.state, "review_required");
  assert.equal(result.error.code, "ADDRESS_UNCLEAR");
  // The code drives filtering; the message is what the editor reads, so it must not be the code again.
  assert.equal(result.error.message, errorMessages.ADDRESS_UNCLEAR);
  assert.equal(f.queue.length, 2);
  assert.equal(f.store.getPlace(catalog.places[0].placeId).text, null);
});

test("offline location context is persisted and reaches both model stages without changing the place address",async t=>{
  const f=fixture(t),prompts=[];
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
