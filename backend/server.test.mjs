import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { createApp } from "./server.mjs";
import { sessionCsrfToken } from "./auth.mjs";

async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),"story-api-"));
  const store=createStore(":memory:",{maxDaily:1});
  const accountStore=options.accountStore??{attachRequest(){},ownsRequest(){return true;},reserveGeneration(){},releaseGeneration(){}};
  const auth=options.auth??{api:{getSession:async()=>({user:{id:"test-user",email:"test@example.test",name:"Test",role:"editor"},session:{id:"test-session",createdAt:new Date()}})}};
  const app=createApp({store,provider:{},origin:"https://otgolosok.test",audioDirectory:directory,workerEnabled:false,auth,accountStore,...options});
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();store.close();await rm(directory,{recursive:true,force:true});});
  const post=(path,value,origin="https://otgolosok.test")=>fetch(base+path,{method:"POST",headers:{Origin:origin,"Content-Type":"application/json","X-CSRF-Token":sessionCsrfToken("","test-session")},body:JSON.stringify(path==="/api/story-jobs"?{...value,idempotencyKey:crypto.randomUUID()}:value)});
  return {base,post,directory,store};
}

test("validates origins and address shape before allocating a job",async(t)=>{
  const f=await fixture(t);
  assert.equal((await f.post("/api/story-jobs",{address:"Улица 16"},"https://other.test")).status,403);
  assert.equal((await f.post("/api/story-jobs",{address:"Улица 16",lat:55.1})).status,400);
  assert.equal((await f.post("/api/story-jobs",{address:""})).status,400);
});

test("duplicate POST reuses an ID and GET exposes no internal research or credentials",async(t)=>{
  const f=await fixture(t);
  const first=await (await f.post("/api/story-jobs",{address:"Кожевническая улица, 16"})).json();
  const second=await (await f.post("/api/story-jobs",{address:"Кожевническая улица, 16"})).json();
  assert.equal(first.id,second.id);
  const record=f.store.get(first.id);f.store.update(record.id,{stage:"ready",data:{sources:[{text:"internal"}],usage:[{tokens:100}]}},record.revision);
  const response=await fetch(`${f.base}/api/story-jobs/${first.id}`);const publicValue=await response.json();
  assert.equal(publicValue.data,undefined);assert.equal(publicValue.sources,undefined);assert.equal(response.headers.get("cache-control"),"no-store");
  assert.equal((await f.post("/api/story-jobs",{address:"Кожевническая улица, 18"})).status,429);
});

test("serves complete and partial audio and rejects traversal or invalid range",async(t)=>{
  const f=await fixture(t);const name="a".repeat(64)+".mp3";
  await writeFile(join(f.directory,name),"0123456789");
  const response=await fetch(`${f.base}/api/story-audio/${name}`,{headers:{Range:"bytes=2-5"}});
  assert.equal(response.status,206);assert.equal(await response.text(),"2345");assert.equal(response.headers.get("content-range"),"bytes 2-5/10");
  assert.equal((await fetch(`${f.base}/api/story-audio/${name}`,{headers:{Range:"bytes=10-"}})).status,416);
  assert.equal((await fetch(`${f.base}/api/story-audio/%2e%2e/server.mjs`)).status,404);
});

test("HTTP TTS reports its transport without suggesting an external worker",async(t)=>{
  const f=await fixture(t,{localTts:{transport:"http",defaultProfile:"f5-ru-v1"}});
  const response=await fetch(`${f.base}/api/story-admin/content/workers`);
  assert.equal(response.status,200);
  const value=await response.json();
  assert.equal(value.transport,"http");
  assert.deepEqual(value.workers,[]);
  assert.deepEqual(value.heartbeats,[]);
  assert.equal((await fetch(`${f.base}/api/worker/v1/claim`,{method:"POST"})).status,503);
  const issue=await f.post("/api/story-admin/content/workers",{name:"GPU",profiles:["f5-ru-v1"]});
  assert.equal(issue.status,503);
});

test("worker transport still exposes credentials and allows issuing keys",async(t)=>{
  const f=await fixture(t);
  const response=await fetch(`${f.base}/api/story-admin/content/workers`);
  assert.equal((await response.json()).transport,"worker");
  assert.equal((await f.post("/api/story-admin/content/workers",{name:"GPU",profiles:["silero-ru-v1"]})).status,201);
});

test("external worker API authenticates, leases and accepts an idempotent upload",async(t)=>{
  const artifact={url:`/api/story-audio/${"b".repeat(64)}.mp3`,sha256:"b".repeat(64),bytes:100,durationSec:60,model:"external",voice:"external",provider:"external",synthetic:true};
  const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async req=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    return {uploadSha256:"a".repeat(64),artifact};
  }});
  const story={title:"Дом",address:"Москва, дом 1",wordCount:104,paragraphs:[
    {text:("Первый абзац рассказа об истории московского дома и людях. ").repeat(7),factIds:["f1","f2","f3"]},
    {text:("Второй абзац описывает архитектурные детали и судьбу места. ").repeat(7),factIds:["f4","f5"]}],verification:"editorial",sources:[],facts:[]};
  const source=f.store.createOrGet({key:"external-source",address:story.address});
  const ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);
  await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story,profileId:"silero-ru-v1"});
  assert.equal((await fetch(f.base+"/api/worker/v1/claim",{method:"POST"})).status,401);
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu-1","Content-Type":"application/json"};
  const claim=await (await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"request-0001",profileIds:["silero-ru-v1"]})})).json();
  const lease={...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"upload-0001","X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"};
  const uploaded=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:lease,body:"wave"});
  assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).job.state,"succeeded");
  assert.deepEqual(f.store.get(ready.id).data.audio,artifact);
  const repeated=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:lease,body:"wave"});
  assert.equal(repeated.status,200);
});

test("invalid worker audio uses 413 and 422 result statuses",async t=>{
  const story={title:"Дом",address:"Москва, дом 1",paragraphs:[{text:("История московского дома. ").repeat(30),factIds:["f1"]},{text:("Архитектура и судьба места. ").repeat(30),factIds:["f2"]}]};
  for(const [code,status] of [["AUDIO_TOO_LARGE",413],["BAD_AUDIO",422]]) {
    const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async()=>{throw Object.assign(new Error(code),{code});}});
    const source=f.store.createOrGet({key:`status-${code}`,address:story.address}),ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story});
    const headers={Authorization:"Bearer worker-secret","X-Worker-Id":`worker-${status}`,"Content-Type":"application/json"};const claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:`status-${status}`,profileIds:["silero-ru-v1"]})}).then(value=>value.json());
    const response=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":`upload-${status}`,"X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"},body:"wave"});assert.equal(response.status,status);
  }
});

test("a rejected worker upload never deletes an existing shared artifact",async t=>{
  const hash="b".repeat(64),artifact={url:`/api/story-audio/${hash}.mp3`,sha256:hash,bytes:9,durationSec:60,model:"external",voice:"external",provider:"external",synthetic:true};
  const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async(req,directory,options)=>{for await(const chunk of req){void chunk;}assert.equal(options.expectedUploadSha256,"a".repeat(64));return{uploadSha256:"c".repeat(64),artifact};}});
  await writeFile(join(f.directory,`${hash}.mp3`),"published");
  const story={title:"Дом",address:"Москва, дом 1",paragraphs:[{text:("История дома. ").repeat(40),factIds:["f1"]},{text:("Архитектура дома. ").repeat(40),factIds:["f2"]}]};
  const source=f.store.createOrGet({key:"shared-artifact",address:story.address}),ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story});
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu-shared","Content-Type":"application/json"},claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"shared-artifact-request",profileIds:["silero-ru-v1"]})}).then(value=>value.json());
  const response=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"shared-upload","X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"},body:"wave"});
  assert.equal(response.status,422);assert.equal(await (await import("node:fs/promises")).readFile(join(f.directory,`${hash}.mp3`),"utf8"),"published");
});

test("OSM text stays private until approval and approved audio attaches to the place",async(t)=>{
  const artifact={url:`/api/story-audio/${"c".repeat(64)}.mp3`,sha256:"c".repeat(64),bytes:100,durationSec:60,model:"external",voice:"xenia",provider:"external",synthetic:true};
  const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async req=>{for await(const chunk of req){void chunk;}return{uploadSha256:"d".repeat(64),artifact};}});
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}}]});
  f.store.createBatch({requestKey:"content-api-1",limit:1,mode:"text-and-audio",ttsProfile:"silero-ru-v1"});
  const paragraph=("Проверенный рассказ о московском парке, его истории, архитектуре и людях. ").repeat(9).trim();
  const job=f.store.claimContentJob(),story={title:"Парк",paragraphs:[{text:paragraph,factIds:["f1","f2","f3"]},{text:paragraph,factIds:["f4","f5"]}]};
  f.store.completeContentJob(job.id,{story,evidence:{facts:[]}});
  assert.equal((await fetch(f.base+"/api/content/places/osm:node:7")).status,404);
  assert.equal((await fetch(f.base+"/api/content/places").then(value=>value.json())).places.length,0);
  const approve=await f.post("/api/story-admin/content/places/osm:node:7/approve",{story});assert.equal(approve.status,200,await approve.text());
  assert.equal((await fetch(f.base+"/api/content/places/osm:node:7")).status,200);
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu-1","Content-Type":"application/json"};
  const claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"content-audio-0001",profileIds:["silero-ru-v1"]})}).then(value=>value.json());
  const upload=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"content-upload-1","X-Content-SHA256":"d".repeat(64),"Content-Type":"audio/wav"},body:"wave"});
  assert.equal(upload.status,200);assert.equal(f.store.getPlace("osm:node:7").text.audio.sha256,artifact.sha256);
});

test("public OSM catalog validates and serves nearby approved places",async t=>{
  const f=await fixture(t);f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:8",osmType:"node",osmId:8,name:"Сад",location:{lat:55.75,lon:37.61},tags:{leisure:"garden"}}]});
  f.store.createBatch({requestKey:"nearby-http",limit:1});const job=f.store.claimContentJob(),story={title:"История сада",paragraphs:[{text:"Проверенный текст сада",factIds:["f1"]}]};f.store.completeContentJob(job.id,{story,evidence:{}});f.store.approvePlaceText("osm:node:8");
  const response=await fetch(`${f.base}/api/content/places?status=ready&lat=55.75&lon=37.61&radius=500`);assert.equal(response.status,200);const result=await response.json();assert.equal(result.places[0].id,"osm:node:8");assert.ok(result.places[0].distanceM<1);
  assert.equal((await fetch(`${f.base}/api/content/places?lat=55.75&lon=37.61`)).status,400);
});

test("admin manages content batches and revocable worker credentials",async t=>{
  const f=await fixture(t);f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:8",osmType:"node",osmId:8,name:"Музей",location:{lat:55.75,lon:37.61},tags:{tourism:"museum"}}]});
  const created=await f.post("/api/story-admin/content/batches",{requestKey:"content-api-2",name:"API",limit:1,textProfile:"story-v1",mode:"text-only"});assert.equal(created.status,200);
  const batch=(await created.json()).batch;assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}`)).status,200);
  const issued=await f.post("/api/story-admin/content/workers",{name:"GPU",profiles:["silero-ru-v1"]});assert.equal(issued.status,201);
  const worker=(await issued.json()).worker;assert.equal(worker.token.length,64);
  assert.equal((await f.post(`/api/story-admin/content/workers/${worker.id}/revoke`,{})).status,200);
  assert.equal((await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers:{Authorization:`Bearer ${worker.token}`,"X-Worker-Id":"gpu","Content-Type":"application/json"},body:JSON.stringify({requestId:"credential-1",profileIds:["silero-ru-v1"]})})).status,401);
  const items=await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?limit=1&offset=0&status=waiting`);
  assert.equal(items.status,200);const page=await items.json();
  assert.deepEqual(page,{items:[{placeId:"osm:node:8",name:"Музей",address:null,state:"queued",error:null}],total:1,hasMore:false,errors:[{code:null,count:1}]});
  const byError=await (await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=ADDRESS_UNCLEAR`)).json();
  assert.equal(byError.total,0);assert.deepEqual(byError.errors,[{code:null,count:1}]);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=none`)).status,200);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=%D0%BE%D1%88%D0%B8%D0%B1%D0%BA%D0%B0`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?status=unknown`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?page=1`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/11111111-1111-4111-8111-111111111111/items`)).status,404);
  const places=await (await fetch(`${f.base}/api/story-admin/content/places?limit=1&offset=0&status=all`)).json();
  assert.equal(places.total,1);assert.equal(places.places[0].textStatus,"none");
});

test("the audio retry route matches a job id instead of falling through to the admin 404",async t=>{
  const f=await fixture(t);
  // A bare regex literal with ${UUID} once made this route unreachable: the desk's retry button always 404ed.
  const matched=await f.post("/api/story-admin/content/audio/11111111-1111-4111-8111-111111111111/retry",{});
  assert.equal(matched.status,404);
  assert.equal((await matched.json()).error.message,"Failed audio job not found.");
  const unmatched=await f.post("/api/story-admin/content/audio/not-a-uuid/retry",{});
  assert.equal(unmatched.status,404);
  assert.equal((await unmatched.json()).error.message,"Admin endpoint not found.");
});

test("place lookup has no generation side effect and reports bounded errors",async(t)=>{
  const inputs=[];
  const f=await fixture(t,{resolvePlace:async input=>{inputs.push(input);if(input.q==='busy')throw Object.assign(new Error('private'),{code:'PLACE_BUSY'});return {address:'Москва, Арбат, 10',location:{lat:55.75,lon:37.6}};}});
  const response=await fetch(f.base+'/api/story-place?lat=55.75&lon=37.6');
  assert.equal(response.status,200);assert.deepEqual(inputs[0],{lat:55.75,lon:37.6});
  const busy=await fetch(f.base+'/api/story-place?q=busy');assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'2');assert.equal((await busy.text()).includes('private'),false);
  assert.equal((await fetch(f.base+'/api/story-place?q=one&q=two')).status,400);
  // The one-job daily allowance is untouched by address lookup.
  assert.equal((await f.post('/api/story-jobs',{address:'Москва, Арбат, 10'})).status,200);
});

test('walk planning is independent of story provider and protected by origin',async(t)=>{
  const inputs=[];const result={stops:[],geometry:[],distanceM:100,walkingMinutes:2,attribution:'test'};
  const f=await fixture(t,{provider:null,planWalk:async input=>{inputs.push(input);return result;}});
  const input={start:{address:'Москва, Арбат, 1',location:{lat:55.75,lon:37.6}},mode:'loop',minutes:30};
  assert.equal((await f.post('/api/walk-plan',input,'https://evil.test')).status,403);
  assert.equal((await fetch(f.base+'/api/walk-plan',{method:'POST',headers:{Origin:'https://otgolosok.test','Sec-Fetch-Site':'cross-site','Content-Type':'application/json'},body:JSON.stringify(input)})).status,403);
  assert.equal(inputs.length,0);
  const response=await f.post('/api/walk-plan',input);
  assert.equal(response.status,200);assert.deepEqual(await response.json(),result);assert.deepEqual(inputs,[input]);
  assert.equal((await f.post('/api/story-jobs',{address:'Москва, Арбат, 1'})).status,503);
});

test('walk errors are sanitized and walk-only body allowance is bounded',async(t)=>{
  let calls=0;
  const f=await fixture(t,{planWalk:async input=>{calls++;if(input.code)throw Object.assign(new Error('secret'),{code:input.code});return {};}});
  for(const [code,status] of [['WALK_INVALID',400],['WALK_BUSY',429],['WALK_NOT_FOUND',404],['WALK_STOPS_NOT_FOUND',404],['WALK_DISCOVERY_UNAVAILABLE',503],['WALK_UNAVAILABLE',503],['PRIVATE_ERROR',503]]) {
    const res=await f.post('/api/walk-plan',{code});assert.equal(res.status,status);assert.equal((await res.text()).includes('secret'),false);
    if(status===429)assert.equal(res.headers.get('retry-after'),'2');
  }
  assert.equal((await f.post('/api/walk-plan',{text:'я'.repeat(2000)})).status,200);
  const before=calls;
  assert.equal((await f.post('/api/walk-plan',{text:'x'.repeat(8200)})).status,400);assert.equal(calls,before);
  assert.equal((await f.post('/api/story-jobs',{address:'x'.repeat(2100)})).status,400);
  const malformed=await fetch(f.base+'/api/walk-plan',{method:'POST',headers:{Origin:'https://otgolosok.test','Content-Type':'application/json'},body:'{'});
  assert.equal(malformed.status,400);assert.equal((await malformed.json()).error.code,'WALK_INVALID');
});
