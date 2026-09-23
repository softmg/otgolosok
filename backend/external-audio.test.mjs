import test from "node:test";
import assert from "node:assert/strict";
import { createStore } from "./store.mjs";

const story={title:"Дом",address:"Москва, дом 1",wordCount:104,paragraphs:[
  {text:("Первый абзац рассказа об истории московского дома и людях, которые были с ним связаны. ").repeat(4).trim(),factIds:["f1","f2","f3"]},
  {text:("Второй абзац продолжает рассказ и описывает архитектурные детали здания и дальнейшую судьбу места. ").repeat(4).trim(),factIds:["f4","f5"]}],verification:"editorial",sources:[],facts:[]};

async function fixture(t,{enqueueBase=true}={}) {
  let clock=Date.UTC(2026,8,16,12);const tick=()=>++clock;
  const store=createStore(":memory:",{now:()=>clock,maxActive:20,maxDaily:20,workerLeaseSecret:"test-secret"});
  t.after(()=>store.close());
  const original=store.createOrGet({key:"source",address:"Москва, дом 1"});
  const source=store.update(original.id,{stage:"failed",data:{story}},original.revision);
  const queued=enqueueBase?await store.enqueueExternalAudio({sourceJobId:source.id,sourceRevision:source.revision,story,profileId:"silero-ru-v1"}):null;
  return {store,source,queued,advance:ms=>clock+=ms,tick};
}

test("external audio claims are exclusive and idempotent",async t=>{
  const f=await fixture(t);
  assert.equal(f.queued.profileId,"silero-ru-v1");
  const first=f.store.claimExternalAudio({workerId:"gpu-1",requestId:"request-0001",profileIds:["silero-ru-v1"]});
  assert.equal(first.spokenText,story.paragraphs.map(paragraph=>paragraph.text).join("\n\n"));
  assert.deepEqual(f.store.claimExternalAudio({workerId:"gpu-1",requestId:"request-0001",profileIds:["silero-ru-v1"]}),first);
  assert.equal(f.store.claimExternalAudio({workerId:"gpu-2",requestId:"request-0002",profileIds:["silero-ru-v1"]}),null);
  assert.equal(f.store.heartbeatExternalAudio(first.id,{workerId:"gpu-1",generation:first.leaseGeneration,leaseToken:first.leaseToken}).state,"leased");
});

test("expired leases retry and stale workers cannot publish",async t=>{
  const f=await fixture(t);
  const stale=f.store.claimExternalAudio({workerId:"gpu-1",requestId:"request-0001",profileIds:["silero-ru-v1"],leaseMs:1000});
  f.advance(1001);
  const current=f.store.claimExternalAudio({workerId:"gpu-2",requestId:"request-0002",profileIds:["silero-ru-v1"]});
  assert.equal(current.leaseGeneration,2);
  assert.throws(()=>f.store.acceptExternalAudio(stale.id,{workerId:"gpu-1",generation:stale.leaseGeneration,leaseToken:stale.leaseToken,uploadId:"upload-stale",uploadSha256:"a".repeat(64),artifact:{url:"x"}}),{code:"LEASE_LOST"});
});

test("expired idempotency keys conflict and one worker cannot hold two leases",async t=>{
  const f=await fixture(t),first=f.store.claimExternalAudio({workerId:"gpu",requestId:"same-request",profileIds:["silero-ru-v1"],leaseMs:1000});
  assert.ok(first);assert.throws(()=>f.store.claimExternalAudio({workerId:"gpu",requestId:"other-request",profileIds:["silero-ru-v1"]}),{code:"WORKER_BUSY"});
  f.advance(1001);assert.throws(()=>f.store.claimExternalAudio({workerId:"gpu",requestId:"same-request",profileIds:["silero-ru-v1"]}),{code:"CLAIM_EXPIRED"});
});

test("accepted uploads publish once and duplicate receipts are safe",async t=>{
  const f=await fixture(t),claim=f.store.claimExternalAudio({workerId:"gpu",requestId:"request-0001",profileIds:["silero-ru-v1"]});
  const artifact={url:`/api/story-audio/${"b".repeat(64)}.mp3`,sha256:"b".repeat(64),bytes:100,durationSec:60,model:"silero",voice:"xenia",provider:"external",synthetic:true};
  const input={workerId:"gpu",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,uploadId:"upload-0001",uploadSha256:"a".repeat(64),artifact};
  const accepted=f.store.acceptExternalAudio(claim.id,input);
  assert.equal(accepted.state,"succeeded");
  assert.deepEqual(f.store.acceptExternalAudio(claim.id,input),accepted);
  assert.deepEqual(f.store.get(f.source.id).data.audio,artifact);
  assert.throws(()=>f.store.acceptExternalAudio(claim.id,{...input,uploadSha256:"c".repeat(64)}),{code:"CONFLICT"});
});

test("worker failures retry without changing the source text",async t=>{
  const f=await fixture(t),claim=f.store.claimExternalAudio({workerId:"gpu",requestId:"request-0001",profileIds:["silero-ru-v1"]});
  const failed=f.store.failExternalAudio(claim.id,{workerId:"gpu",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,failureId:"failure-0001",code:"SYNTHESIS_FAILED",message:"model error"});
  assert.equal(failed.state,"retry_wait");
  assert.equal(f.store.get(f.source.id).data.story.title,"Дом");
  assert.deepEqual(f.store.failExternalAudio(claim.id,{workerId:"gpu",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,failureId:"failure-0001",code:"SYNTHESIS_FAILED"}),failed);
});

test("manual audio retry starts a fresh bounded attempt series",async t=>{
  const f=await fixture(t),claim=f.store.claimExternalAudio({workerId:"gpu",requestId:"manual-retry-1",profileIds:["silero-ru-v1"]});
  f.store.failExternalAudio(claim.id,{workerId:"gpu",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,failureId:"manual-failure",code:"MODEL_FAILED"});
  const row=f.store.getExternalAudio(claim.id);assert.equal(row.state,"retry_wait");
  // Exhaustion is covered by maxAttempts; a terminal row can be manually reset without changing text.
  f.advance(150001);let current=f.store.claimExternalAudio({workerId:"gpu2",requestId:"manual-retry-2",profileIds:["silero-ru-v1"]});f.store.failExternalAudio(current.id,{workerId:"gpu2",generation:current.leaseGeneration,leaseToken:current.leaseToken,failureId:"manual-failure-2",code:"MODEL_FAILED"});
  f.advance(150001);current=f.store.claimExternalAudio({workerId:"gpu3",requestId:"manual-retry-3",profileIds:["silero-ru-v1"]});f.store.failExternalAudio(current.id,{workerId:"gpu3",generation:current.leaseGeneration,leaseToken:current.leaseToken,failureId:"manual-failure-3",code:"MODEL_FAILED"});
  assert.equal(f.store.retryExternalAudio(claim.id).attempts,0);assert.equal(f.store.getExternalAudio(claim.id).state,"queued");
});

test("worker credentials are profile-scoped and revocable",async t=>{
  const f=await fixture(t);const issued=f.store.createWorkerCredential({name:"GPU",profiles:["silero-ru-v1"]});
  assert.equal(issued.token.length,64);assert.deepEqual(f.store.authenticateWorkerToken(issued.token).profiles,["silero-ru-v1"]);
  assert.equal(f.store.listWorkerCredentials()[0].name,"GPU");f.store.revokeWorkerCredential(issued.id);
  assert.equal(f.store.authenticateWorkerToken(issued.token),null);
});

test("worker heartbeat records version, progress and current job",async t=>{
  const f=await fixture(t),issued=f.store.createWorkerCredential({name:"GPU",profiles:["silero-ru-v1"]});
  f.store.recordWorkerHeartbeat({credentialId:issued.id,workerName:"desktop",version:"worker-2",profileIds:["silero-ru-v1"]});
  const claim=f.store.claimExternalAudio({workerId:`${issued.id}:desktop`,requestId:"heartbeat-0001",profileIds:["silero-ru-v1"]});
  f.store.heartbeatExternalAudio(claim.id,{workerId:`${issued.id}:desktop`,generation:claim.leaseGeneration,leaseToken:claim.leaseToken,progress:{stage:"synthesis",percent:50}});
  const heartbeat=f.store.listWorkerHeartbeats()[0];assert.equal(heartbeat.currentJobId,claim.id);assert.equal(heartbeat.progress.percent,50);
});

test("external audio stores the immutable normalized script and profile contract",async t=>{
  const store=createStore(":memory:",{workerLeaseSecret:"test",normalizeExternalText:Object.assign(async text=>`НОРМАЛИЗОВАНО: ${text}`,{version:"test-normalizer"})});t.after(()=>store.close());
  const source=store.createOrGet({key:"normalized-source",address:story.address});const ready=store.update(source.id,{stage:"failed",data:{story}},source.revision);
  await store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story,profileId:"silero-ru-v1"});
  const claim=store.claimExternalAudio({workerId:"gpu",requestId:"normalized-0001",profileIds:["silero-ru-v1"]});
  assert.match(claim.spokenText,/^НОРМАЛИЗОВАНО:/);assert.equal(claim.normalizerVersion,"test-normalizer");assert.equal(claim.profile.chunking,"sentence-v1");assert.equal(claim.profile.maximumBytes,64*1024*1024);assert.equal(claim.profile.minimumPublicationDurationSec,30);
});

test("raw profile bypasses server normalization and requires a capable worker",async t=>{
  const version="html-unescape-v1_ru-normalizr-0.3.0_silero-stress-1.5_typography-v1";
  const store=createStore(":memory:",{workerLeaseSecret:"test",normalizeExternalText:async()=>{throw new Error("must not normalize");},
    externalTtsProfiles:{"f5-ru-v1":{engine:"f5",modelSha256:"a",speaker:"voice",configSha256:"b",textPreparation:{input:"raw",version}}}});t.after(()=>store.close());
  const source=store.createOrGet({key:"raw-source",address:story.address}),ready=store.update(source.id,{stage:"failed",data:{story}},source.revision);
  await store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story,profileId:"f5-ru-v1"});
  assert.equal(store.claimExternalAudio({workerId:"old",requestId:"raw-old-0001",profileIds:["f5-ru-v1"]}),null);
  const claim=store.claimExternalAudio({workerId:"new",requestId:"raw-new-0001",profileIds:["f5-ru-v1"],textPreparationVersions:[version]});
  assert.equal(claim.spokenText,story.paragraphs.map(value=>value.text).join("\n\n"));assert.equal(claim.profile.configSha256,"b");
});

test("editing approved place text invalidates a leased older audio version",async t=>{
  const f=await fixture(t,{enqueueBase:false});f.tick();f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:1",osmType:"node",osmId:1,name:"Дом",location:{lat:55.7,lon:37.6},tags:{historic:"yes"}}]});
  const batch=f.store.createBatch({requestKey:"place-audio",placeIds:["osm:node:1"],limit:1,mode:"text-and-audio",ttsProfile:"silero-ru-v1"});const content=f.store.claimContentJob();f.store.completeContentJob(content.id,{story,evidence:{}});const approved=f.store.approvePlaceText("osm:node:1",story);
  assert.equal(approved.text.story.title,story.title);
  await f.store.enqueueExternalAudio({sourceJobId:`place-text:${approved.text.id}`,sourceRevision:0,story,profileId:"silero-ru-v1"});const claim=f.store.claimExternalAudio({workerId:"unique-edit-worker",requestId:"unique-edit-lease-0001",profileIds:["silero-ru-v1"]});
  f.tick();f.store.approvePlaceText("osm:node:1",{...story,title:"Новая версия",paragraphs:story.paragraphs.map((p,i)=>i? p:{...p,text:p.text+" Дополнение."})});
  assert.throws(()=>f.store.acceptExternalAudio(claim.id,{workerId:"unique-edit-worker",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,uploadId:"edited-upload",uploadSha256:"a".repeat(64),artifact:{sha256:"b".repeat(64),durationSec:60}}),{code:"LEASE_LOST"});assert.equal(f.store.getBatch(batch.id).counts.ready,1);
  assert.equal(f.store.getPublishedPlace("osm:node:1").text.story.title,"Новая версия");assert.notEqual(f.store.getPublishedPlace("osm:node:1").text.id,approved.text.id);
});

test("a new approved place text keeps old audio until its replacement succeeds",async t=>{
  const f=await fixture(t,{enqueueBase:false});f.tick();f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:9",osmType:"node",osmId:9,name:"Дом",location:{lat:55.7,lon:37.6},tags:{historic:"yes"}}]});
  f.store.createBatch({requestKey:"audio-fallback",placeIds:["osm:node:9"],limit:1});const content=f.store.claimContentJob();f.store.completeContentJob(content.id,{story,evidence:{}});const old=f.store.approvePlaceText("osm:node:9",story);
  assert.equal(old.text.story.title,story.title);
  await f.store.enqueueExternalAudio({sourceJobId:`place-text:${old.text.id}`,sourceRevision:0,story,profileId:"silero-ru-v1"});const claim=f.store.claimExternalAudio({workerId:"fallback-worker",requestId:"fallback-claim-1",profileIds:["silero-ru-v1"]});
  const artifact={url:`/api/story-audio/${"e".repeat(64)}.mp3`,sha256:"e".repeat(64),bytes:100,durationSec:60,model:"silero",voice:"xenia",provider:"external",synthetic:true};
  f.store.acceptExternalAudio(claim.id,{workerId:"fallback-worker",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,uploadId:"fallback-upload",uploadSha256:"f".repeat(64),artifact});
  assert.deepEqual(f.store.getPublishedPlace("osm:node:9").text.audio,artifact);
  const nextStory={...story,title:"Новая версия",paragraphs:story.paragraphs.map((paragraph,index)=>index?paragraph:{...paragraph,text:`${paragraph.text} Дополнение.`})};
  f.tick();const next=f.store.approvePlaceText("osm:node:9",nextStory);assert.notEqual(next.text.id,old.text.id);assert.deepEqual(f.store.getPublishedPlace("osm:node:9").text.audio,artifact);
});

test("only the latest requested profile publishes when engines finish out of order",async t=>{
  const f=await fixture(t,{enqueueBase:false});f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:12",osmType:"node",osmId:12,name:"Дом",location:{lat:55.7,lon:37.6},tags:{historic:"yes"}}]});
  f.store.createBatch({requestKey:"target-profile",placeIds:["osm:node:12"],limit:1});const content=f.store.claimContentJob();f.store.completeContentJob(content.id,{story,evidence:{}});const approved=f.store.approvePlaceText("osm:node:12",story);
  const sourceJobId=`place-text:${approved.text.id}`;await f.store.enqueueExternalAudio({sourceJobId,sourceRevision:0,story,profileId:"silero-ru-v1"});await f.store.enqueueExternalAudio({sourceJobId,sourceRevision:0,story,profileId:"f5-ru-v1"});
  const silero=f.store.claimExternalAudio({workerId:"silero",requestId:"target-silero-1",profileIds:["silero-ru-v1"]});const f5=f.store.claimExternalAudio({workerId:"f5",requestId:"target-f5-0001",profileIds:["f5-ru-v1"]});
  const artifact=(engine,char)=>({url:`/api/story-audio/${char.repeat(64)}.mp3`,sha256:char.repeat(64),bytes:100,durationSec:60,model:engine,voice:"voice",provider:"external",synthetic:true});
  f.store.acceptExternalAudio(silero.id,{workerId:"silero",generation:silero.leaseGeneration,leaseToken:silero.leaseToken,uploadId:"silero-upload",uploadSha256:"c".repeat(64),artifact:artifact("silero","c")});assert.equal(f.store.getPlace("osm:node:12").text.audio,null);
  f.store.acceptExternalAudio(f5.id,{workerId:"f5",generation:f5.leaseGeneration,leaseToken:f5.leaseToken,uploadId:"f5-upload-01",uploadSha256:"d".repeat(64),artifact:artifact("f5","d")});assert.equal(f.store.getPlace("osm:node:12").text.audio.model,"f5");
});

test("publication duration is enforced by the frozen TTS profile",async t=>{
  const f=await fixture(t),claim=f.store.claimExternalAudio({workerId:"duration-worker",requestId:"duration-claim",profileIds:["silero-ru-v1"]});
  assert.throws(()=>f.store.acceptExternalAudio(claim.id,{workerId:"duration-worker",generation:claim.leaseGeneration,leaseToken:claim.leaseToken,uploadId:"duration-upload",uploadSha256:"a".repeat(64),artifact:{sha256:"b".repeat(64),durationSec:10}}),{code:"AUDIO_DURATION"});
});
