import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp,writeFile,rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createStore } from "./store.mjs";
import { createApp, workerLeaseSecret } from "./server.mjs";
import { createAuth, sessionCsrfToken } from "./auth.mjs";
import { createAccountStore } from "./account-store.mjs";
import { ensurePromoWalksUser } from "./promo-walks.mjs";
import { request as httpRequest } from "node:http";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

async function testAccounts(t,users=["test-user"]) {
  const runtime=await createAuth({databasePath:":memory:",baseURL:"https://otgolosok.test",secret:"server-test-secret-longer-than-32-characters",production:false});
  t.after(()=>runtime.close());
  const time=new Date().toISOString();
  for(const id of users)runtime.database.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run(id,id,`${id}@example.test`,1,time,time);
  return {runtime,accountStore:createAccountStore(runtime.accountDatabase)};
}

async function fixture(t,options={}) {
  const directory=await mkdtemp(join(tmpdir(),"story-api-"));
  // One active job keeps queue-capacity behaviour observable with a couple of requests.
  const store=createStore(":memory:",{maxActive:1});
  const accountStore=options.accountStore??(await testAccounts(t)).accountStore;
  const auth=options.auth??{api:{getSession:async()=>({user:{id:"test-user",email:"test@example.test",name:"Test",role:"editor"},session:{id:"test-session",createdAt:new Date()}})}};
  const app=createApp({store,provider:/** @type {any} */ ({}),origin:"https://otgolosok.test",audioDirectory:directory,workerEnabled:false,auth,accountStore,...options});
  await /** @type {Promise<void>} */ (new Promise(done=>app.server.listen(0,"127.0.0.1",done)));
  const base=`http://127.0.0.1:${/** @type {import("node:net").AddressInfo} */ (app.server.address()).port}`;
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
  const first=/** @type {any} */ (await (await f.post("/api/story-jobs",{address:"Кожевническая улица, 16"})).json());
  const second=/** @type {any} */ (await (await f.post("/api/story-jobs",{address:"Кожевническая улица, 16"})).json());
  assert.equal(first.id,second.id);
  const record=f.store.get(first.id);f.store.update(record.id,{stage:"ready",data:{sources:[{text:"internal"}],usage:[{tokens:100}]}},record.revision);
  const response=await fetch(`${f.base}/api/story-jobs/${first.id}`);const publicValue=/** @type {any} */ (await response.json());
  assert.equal(publicValue.data,undefined);assert.equal(publicValue.sources,undefined);assert.equal(response.headers.get("cache-control"),"no-store");
  // No global daily cap: once the queue slot is free, the next address is accepted.
  assert.equal((await f.post("/api/story-jobs",{address:"Кожевническая улица, 18"})).status,200);
  assert.equal((await f.post("/api/story-jobs",{address:"Кожевническая улица, 20"})).status,429);
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
  const value=/** @type {any} */ (await response.json());
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
  assert.equal(/** @type {any} */ (await response.json()).transport,"worker");
  assert.equal((await f.post("/api/story-admin/content/workers",{name:"GPU",profiles:["silero-ru-v1"]})).status,201);
});

test("admin walk catalog accepts pagination and rejects invalid parameters",async(t)=>{
  const f=await fixture(t);
  const response=await fetch(`${f.base}/api/story-admin/walks?limit=1&offset=0`);
  assert.equal(response.status,200);
  const page=/** @type {any} */ (await response.json());
  assert.equal(page.walks.length,1);
  assert.equal(page.total>=page.walks.length,true);
  assert.equal(typeof page.hasMore,"boolean");
  assert.equal((await fetch(`${f.base}/api/story-admin/walks?limit=0&offset=0`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/walks?limit=1&offset=-1`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/walks?limit=1&limit=2`)).status,400);
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
  const claim=/** @type {any} */ (await (await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"request-0001",profileIds:["silero-ru-v1"]})})).json());
  const lease={...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"upload-0001","X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"};
  const uploaded=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:lease,body:"wave"});
  assert.equal(uploaded.status,200);assert.equal(/** @type {any} */ (await uploaded.json()).job.state,"succeeded");
  assert.deepEqual(f.store.get(ready.id).data.audio,artifact);
  const repeated=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:lease,body:"wave"});
  assert.equal(repeated.status,200);
});

test("invalid worker audio uses 413 and 422 result statuses",async t=>{
  const story={title:"Дом",address:"Москва, дом 1",paragraphs:[{text:("История московского дома. ").repeat(30),factIds:["f1"]},{text:("Архитектура и судьба места. ").repeat(30),factIds:["f2"]}]};
  for(const [code,status] of /** @type {[string, number][]} */ ([["AUDIO_TOO_LARGE",413],["BAD_AUDIO",422]])) {
    const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async()=>{throw Object.assign(new Error(code),{code});}});
    const source=f.store.createOrGet({key:`status-${code}`,address:story.address}),ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story});
    const headers={Authorization:"Bearer worker-secret","X-Worker-Id":`worker-${status}`,"Content-Type":"application/json"};const claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:`status-${status}`,profileIds:["silero-ru-v1"]})}).then(value=>/** @type {any} */ (value.json()));
    const response=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":`upload-${status}`,"X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"},body:"wave"});assert.equal(response.status,status);
  }
});

test("a rejected worker upload never deletes an existing shared artifact",async t=>{
  const hash="b".repeat(64),artifact={url:`/api/story-audio/${hash}.mp3`,sha256:hash,bytes:9,durationSec:60,model:"external",voice:"external",provider:"external",synthetic:true};
  const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async(req,directory,options)=>{for await(const chunk of req){void chunk;}assert.equal(options.expectedUploadSha256,"a".repeat(64));return{uploadSha256:"c".repeat(64),artifact};}});
  await writeFile(join(f.directory,`${hash}.mp3`),"published");
  const story={title:"Дом",address:"Москва, дом 1",paragraphs:[{text:("История дома. ").repeat(40),factIds:["f1"]},{text:("Архитектура дома. ").repeat(40),factIds:["f2"]}]};
  const source=f.store.createOrGet({key:"shared-artifact",address:story.address}),ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story});
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu-shared","Content-Type":"application/json"},claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"shared-artifact-request",profileIds:["silero-ru-v1"]})}).then(value=>/** @type {any} */ (value.json()));
  const response=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"shared-upload","X-Content-SHA256":"a".repeat(64),"Content-Type":"audio/wav"},body:"wave"});
  assert.equal(response.status,422);assert.equal(await (await import("node:fs/promises")).readFile(join(f.directory,`${hash}.mp3`),"utf8"),"published");
});

test("OSM text stays private until approval and approved audio attaches to the place",async(t)=>{
  const artifact={url:`/api/story-audio/${"c".repeat(64)}.mp3`,sha256:"c".repeat(64),bytes:100,durationSec:60,model:"external",voice:"xenia",provider:"external",synthetic:true};
  const f=await fixture(t,{workerToken:"worker-secret",audioIngest:async req=>{for await(const chunk of req){void chunk;}return{uploadSha256:"d".repeat(64),artifact};}});
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}}]});
  f.store.createBatch({requestKey:"content-api-1",placeIds:["osm:node:7"],limit:1,mode:"text-and-audio",ttsProfile:"silero-ru-v1"});
  const paragraph=("Проверенный рассказ о московском парке, его истории, архитектуре и людях. ").repeat(9).trim();
  const job=f.store.claimContentJob(),story={title:"Парк",paragraphs:[{text:paragraph,factIds:["f1","f2","f3"]},{text:paragraph,factIds:["f4","f5"]}]};
  f.store.completeContentJob(job.id,{story,evidence:{facts:[]}});
  assert.equal((await fetch(f.base+"/api/content/places/osm:node:7")).status,404);
  assert.equal((await fetch(f.base+"/api/content/places").then(value=>/** @type {any} */ (value.json()))).places.length,0);
  const approve=await f.post("/api/story-admin/content/places/osm:node:7/approve",{story});assert.equal(approve.status,200,await approve.text());
  assert.equal((await fetch(f.base+"/api/content/places/osm:node:7")).status,200);
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu-1","Content-Type":"application/json"};
  const claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"content-audio-0001",profileIds:["silero-ru-v1"]})}).then(value=>/** @type {any} */ (value.json()));
  const upload=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/result`,{method:"PUT",headers:{...headers,"X-Lease-Token":claim.job.leaseToken,"X-Lease-Generation":String(claim.job.leaseGeneration),"X-Upload-Id":"content-upload-1","X-Content-SHA256":"d".repeat(64),"Content-Type":"audio/wav"},body:"wave"});
  assert.equal(upload.status,200);assert.equal(f.store.getPlace("osm:node:7").text.audio.sha256,artifact.sha256);
});

test("public OSM catalog validates and serves nearby approved places",async t=>{
  const f=await fixture(t);f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:8",osmType:"node",osmId:8,name:"Сад",location:{lat:55.75,lon:37.61},tags:{leisure:"garden"}}]});
  f.store.createBatch({requestKey:"nearby-http",placeIds:["osm:node:8"],limit:1});const job=f.store.claimContentJob(),story={title:"История сада",paragraphs:[{text:"Проверенный текст сада",factIds:["f1"]}]};f.store.completeContentJob(job.id,{story,evidence:{}});f.store.approvePlaceText("osm:node:8");
  const response=await fetch(`${f.base}/api/content/places?status=ready&lat=55.75&lon=37.61&radius=500`);assert.equal(response.status,200);const result=/** @type {any} */ (await response.json());assert.equal(result.places[0].id,"osm:node:8");assert.ok(result.places[0].distanceM<1);
  assert.equal((await fetch(`${f.base}/api/content/places?lat=55.75&lon=37.61`)).status,400);
});

test("admin manages content batches and revocable worker credentials",async t=>{
  const f=await fixture(t);f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:8",osmType:"node",osmId:8,name:"Музей",location:{lat:55.75,lon:37.61},tags:{tourism:"museum"}}]});
  // The place has no address or identifier, so the default selection finds nothing; an explicit list is the editor's choice.
  const none=await f.post("/api/story-admin/content/batches",{requestKey:"content-api-0",name:"API",limit:1,textProfile:"story-v1",mode:"text-only"});
  assert.equal(none.status,409);assert.equal(/** @type {any} */ (await none.json()).error.code,"NO_ELIGIBLE_PLACES");
  const created=await f.post("/api/story-admin/content/batches",{requestKey:"content-api-2",name:"API",placeIds:["osm:node:8"],limit:1,textProfile:"story-v1",mode:"text-only"});assert.equal(created.status,200);
  const batch=/** @type {any} */ (await created.json()).batch;assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}`)).status,200);
  const issued=await f.post("/api/story-admin/content/workers",{name:"GPU",profiles:["silero-ru-v1"]});assert.equal(issued.status,201);
  const worker=/** @type {any} */ (await issued.json()).worker;assert.equal(worker.token.length,64);
  assert.equal((await f.post(`/api/story-admin/content/workers/${worker.id}/revoke`,{})).status,200);
  assert.equal((await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers:{Authorization:`Bearer ${worker.token}`,"X-Worker-Id":"gpu","Content-Type":"application/json"},body:JSON.stringify({requestId:"credential-1",profileIds:["silero-ru-v1"]})})).status,401);
  const items=await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?limit=1&offset=0&status=waiting`);
  assert.equal(items.status,200);const page=/** @type {any} */ (await items.json());
  assert.deepEqual(page,{items:[{placeId:"osm:node:8",name:"Музей",address:null,state:"queued",error:null}],total:1,hasMore:false,errors:[{code:null,count:1}]});
  const byError=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=ADDRESS_UNCLEAR`)).json());
  assert.equal(byError.total,0);assert.deepEqual(byError.errors,[{code:null,count:1}]);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=none`)).status,200);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?error=%D0%BE%D1%88%D0%B8%D0%B1%D0%BA%D0%B0`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?status=unknown`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items?page=1`)).status,400);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/11111111-1111-4111-8111-111111111111/items`)).status,404);
  const detail=await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items/osm:node:8`);assert.equal(detail.status,200);
  assert.deepEqual(/** @type {any} */ (await detail.json()).item.location,{lat:55.75,lon:37.61});
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items/osm:node:9`)).status,404);
  assert.equal((await fetch(`${f.base}/api/story-admin/content/batches/${batch.id}/items/osm:node:8?full=1`)).status,400);
  const places=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/places?limit=1&offset=0&status=all`)).json());
  assert.equal(places.total,1);assert.equal(places.places[0].textStatus,"none");
});

test("the audio retry route matches a job id instead of falling through to the admin 404",async t=>{
  const f=await fixture(t);
  // A bare regex literal with ${UUID} once made this route unreachable: the desk's retry button always 404ed.
  const matched=await f.post("/api/story-admin/content/audio/11111111-1111-4111-8111-111111111111/retry",{});
  assert.equal(matched.status,404);
  assert.equal(/** @type {any} */ (await matched.json()).error.message,"Failed audio job not found.");
  const unmatched=await f.post("/api/story-admin/content/audio/not-a-uuid/retry",{});
  assert.equal(unmatched.status,404);
  assert.equal(/** @type {any} */ (await unmatched.json()).error.message,"Admin endpoint not found.");
});

test("admin can start a bounded bulk audio backfill", async t => {
  const f = await fixture(t, {
    localTts: { transport: "http", defaultProfile: "f5-ru-v1", profiles: { "f5-ru-v1": { engine: "f5" } } },
  });
  f.store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), rulesVersion: "v1", coverage: "fixture", places: [
    { placeId: "osm:node:8", osmType: "node", osmId: 8, name: "Музей", location: { lat: 55.75, lon: 37.61 }, tags: { tourism: "museum" } },
  ] });
  const batch = f.store.createBatch({ requestKey: "bulk-audio-api", name: "Audio", placeIds: ["osm:node:8"], limit: 1, mode: "text-only" });
  const job = f.store.claimContentJob();
  const story = {
    title: "История музея",
    paragraphs: [
      { text: ("Это подтверждённый рассказ о музее для проверки административной постановки озвучки. ").repeat(12), factIds: [] },
      { text: ("Дополнительный абзац содержит достаточно текста для валидного аудиозадания. ").repeat(12), factIds: [] },
    ],
  };
  f.store.completeContentJob(job.id, { story, evidence: {}, autoApprove: false });
  f.store.approvePlaceText("osm:node:8");

  const response = await f.post("/api/story-admin/content/audio/bulk", { profileId: "f5-ru-v1", limit: 1 });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { queued: 1, alreadyQueued: 0, retried: 0, skipped: 0, failed: 0, inspected: 1, hasMore: false, awaitingApproval: 0 });
  assert.equal(f.store.getContentStats().external.queued, 1);
  assert.equal(f.store.getBatch(batch.id).counts.ready, 1);
});

test("place lookup has no generation side effect and reports bounded errors",async(t)=>{
  const inputs=[];
  const f=await fixture(t,{resolvePlace:async input=>{inputs.push(input);if(input.q==='busy')throw Object.assign(new Error('private'),{code:'PLACE_BUSY'});return {address:'Москва, Арбат, 10',location:{lat:55.75,lon:37.6}};}});
  const response=await fetch(f.base+'/api/story-place?lat=55.75&lon=37.6');
  assert.equal(response.status,200);assert.deepEqual(inputs[0],{lat:55.75,lon:37.6});
  const busy=await fetch(f.base+'/api/story-place?q=busy');assert.equal(busy.status,429);assert.equal(busy.headers.get('retry-after'),'2');assert.equal((await busy.text()).includes('private'),false);
  assert.equal((await fetch(f.base+'/api/story-place?q=one&q=two')).status,400);
  // Address lookup allocates no job, so the single queue slot is still free.
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
  for(const [code,status] of [['WALK_INVALID',400],['WALK_BUSY',429],['WALK_RATE_LIMITED',429],['WALK_NOT_FOUND',404],['WALK_STOPS_NOT_FOUND',404],['WALK_DISCOVERY_UNAVAILABLE',503],['WALK_UNAVAILABLE',503],['PRIVATE_ERROR',503]]) {
    const res=await f.post('/api/walk-plan',{code});assert.equal(res.status,status);assert.equal((await res.text()).includes('secret'),false);
    if(status===429)assert.equal(res.headers.get('retry-after'),'2');
  }
  assert.equal((await f.post('/api/walk-plan',{text:'я'.repeat(2000)})).status,200);
  const before=calls;
  assert.equal((await f.post('/api/walk-plan',{text:'x'.repeat(8200)})).status,400);assert.equal(calls,before);
  assert.equal((await f.post('/api/story-jobs',{address:'x'.repeat(2100)})).status,400);
  const malformed=await fetch(f.base+'/api/walk-plan',{method:'POST',headers:{Origin:'https://otgolosok.test','Content-Type':'application/json'},body:'{'});
  assert.equal(malformed.status,400);assert.equal(/** @type {any} */ (await malformed.json()).error.code,'WALK_INVALID');
});

test("guest walk resolves published OSM stories without an account",async t=>{
  const f=await fixture(t);f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[{placeId:"osm:node:9",osmType:"node",osmId:9,name:"Дом",location:{lat:55.75,lon:37.61},tags:{building:"yes"}}]});
  f.store.createBatch({requestKey:"guest-walk",placeIds:["osm:node:9"],limit:1});const job=f.store.claimContentJob(),story={title:"История дома",paragraphs:[{text:"Проверенный текст о доме",factIds:["f1"]}]};f.store.completeContentJob(job.id,{story,evidence:{}});f.store.approvePlaceText("osm:node:9");
  const stop=(id,placeId,lat)=>({id,place:{address:"Москва, дом",location:{lat,lon:37.61}},storyRef:{kind:"osm",id:placeId},transition:"",nextHint:""});
  const document={version:2,id:"22222222-2222-4222-8222-222222222222",title:"Моя прогулка",description:"",city:"Москва",mode:"loop",minutes:30,start:{address:"Старт",location:{lat:55.749,lon:37.61}},destination:null,
    stops:[stop("33333333-3333-4333-8333-000000000001","osm:node:9",55.75),stop("33333333-3333-4333-8333-000000000002","osm:node:404",55.751),stop("33333333-3333-4333-8333-000000000003","osm:node:9",55.76)],route:null,fieldChecked:false};
  const resolve=(value,origin="https://otgolosok.test")=>fetch(f.base+"/api/story-walks/resolve",{method:"POST",headers:{Origin:origin,"Content-Type":"application/json"},body:JSON.stringify(value)});
  const response=await resolve({document,revision:4});assert.equal(response.status,200);assert.equal(response.headers.get("cache-control"),"no-store");
  const view=/** @type {any} */ (await response.json());
  assert.equal(view.revision,4);assert.deepEqual(view.document,document);
  assert.deepEqual(view.chapters.map(item=>item.status),["text_ready","unavailable","unavailable"]);assert.equal(view.chapters[0].story.title,"История дома");
  for(const invalid of [{document,revision:-1},{document,revision:1,extra:true},{document:{...document,version:1},revision:0},{revision:0}]) assert.equal((await resolve(invalid)).status,400,JSON.stringify(invalid).slice(0,80));
  assert.equal((await resolve({document:{...document,description:"я".repeat(60000)},revision:0})).status,400);
  assert.equal((await resolve({document,revision:0},"https://other.test")).status,403);
  assert.equal((await fetch(f.base+"/api/story-walks/resolve",{method:"POST",headers:{Origin:"https://otgolosok.test","Content-Type":"text/plain"},body:JSON.stringify({document,revision:0})})).status,400);
});

test("worker failure body cannot replace the authenticated lease identity",async t=>{
  const f=await fixture(t);
  const story={title:"Дом",address:"Москва, дом 1",paragraphs:[{text:("История московского дома. ").repeat(30),factIds:["f1"]},{text:("Архитектура и судьба места. ").repeat(30),factIds:["f2"]}]};
  const source=f.store.createOrGet({key:"lease-identity",address:story.address}),ready=f.store.update(source.id,{stage:"failed",data:{story}},source.revision);
  await f.store.enqueueExternalAudio({sourceJobId:ready.id,sourceRevision:ready.revision,story,profileId:"silero-ru-v1"});
  const owner=f.store.createWorkerCredential({name:"Owner",profiles:["silero-ru-v1"]}),other=f.store.createWorkerCredential({name:"Other",profiles:["silero-ru-v1"]});
  const ownerHeaders={Authorization:`Bearer ${owner.token}`,"X-Worker-Id":"gpu","Content-Type":"application/json"};
  const claim=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers:ownerHeaders,body:JSON.stringify({requestId:"lease-identity-1",profileIds:["silero-ru-v1"]})}).then(value=>/** @type {any} */ (value.json()));
  const otherHeaders={Authorization:`Bearer ${other.token}`,"X-Worker-Id":"gpu","Content-Type":"application/json","X-Lease-Generation":"1","X-Lease-Token":"forged"};
  const response=await fetch(`${f.base}/api/worker/v1/jobs/${claim.job.id}/fail`,{method:"POST",headers:otherHeaders,
    body:JSON.stringify({failureId:"failure-0001",code:"CRASHED",workerId:`${owner.id}:gpu`,generation:claim.job.leaseGeneration,leaseToken:claim.job.leaseToken})});
  assert.equal(response.status,400);
  assert.equal(f.store.getExternalAudio(claim.job.id).state,"leased");
});

test("worker claim rejects malformed profile lists as a client error",async t=>{
  const f=await fixture(t,{workerToken:"worker-secret"});
  const headers={Authorization:"Bearer worker-secret","X-Worker-Id":"gpu","Content-Type":"application/json"};
  for(const profileIds of [undefined,"silero-ru-v1",{0:"silero-ru-v1"},[1]]) {
    const response=await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers,body:JSON.stringify({requestId:"malformed-1",profileIds})});
    assert.equal(response.status,400,JSON.stringify(profileIds));
  }
  assert.equal((await fetch(f.base+"/api/worker/v1/claim",{method:"POST",headers:{...headers,Authorization:"Bearer worker-secreT"},body:JSON.stringify({requestId:"malformed-2",profileIds:["silero-ru-v1"]})})).status,401);
});

test("worker lease secret is mandatory wherever worker leases can be issued",()=>{
  const strong="s".repeat(32),random=()=>"random-development-secret";
  for(const [name,env,transport,expected] of /** @type {[string, NodeJS.ProcessEnv, string, string | ErrorConstructor][]} */ ([
    ["production worker transport without secret",{NODE_ENV:"production"},"worker",Error],
    ["production worker transport with short secret",{NODE_ENV:"production",WORKER_LEASE_SECRET:"short"},"worker",Error],
    ["static worker token without secret",{WORKER_API_TOKEN:"token"},"worker",Error],
    ["production worker transport with strong secret",{NODE_ENV:"production",WORKER_LEASE_SECRET:strong},"worker",strong],
    ["production HTTP transport does not lease jobs",{NODE_ENV:"production"},"http","random-development-secret"],
    ["development without secret gets a process-local secret",{},"worker","random-development-secret"],
  ])) {
    if(expected===Error)assert.throws(()=>workerLeaseSecret({env,transport,randomSecret:random}),/WORKER_LEASE_SECRET/,name);
    else assert.equal(workerLeaseSecret({env,transport,randomSecret:random}),expected,name);
  }
});

test("admin lists weak identity candidates and starts only a bounded paused pilot",async t=>{
  const f=await fixture(t),name="Музей-квартира Александра Солженицына";
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:9",osmType:"node",osmId:9,name,location:{lat:55.75,lon:37.61},tags:{name,tourism:"museum"}}]});
  const contentHash=f.store.listPlaces().places[0].contentHash;
  f.store.replaceIdentityCandidates([{placeId:"osm:node:9",contentHash,tier:"auto",score:95,category:"tourism:museum",reasons:[],signals:["inside_address_building"],location:{status:"matched"}}]);
  const list=await fetch(`${f.base}/api/story-admin/content/identity-candidates?tier=auto&limit=10&offset=0`);assert.equal(list.status,200);
  const page=/** @type {any} */ (await list.json());assert.equal(page.total,1);assert.equal(page.items[0].placeId,"osm:node:9");assert.deepEqual(page.tiers,{auto:1,enrich:0,manual:0});assert.equal(page.pilotLimit,50);
  for(const query of ["tier=maybe","limit=-1","page=2","tier=auto&tier=manual","category=%D0%BC"])assert.equal((await fetch(`${f.base}/api/story-admin/content/identity-candidates?${query}`)).status,400,query);
  assert.equal((await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-1",limit:1},"https://other.test")).status,403);
  assert.equal((await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-1",limit:51})).status,400);
  assert.equal((await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-1",limit:1,tier:"enrich"})).status,400);
  const created=await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-1",limit:1,mode:"text-only"});assert.equal(created.status,200);
  const pilot=/** @type {any} */ (await created.json());assert.equal(pilot.created,true);assert.equal(pilot.batch.state,"paused");assert.equal(pilot.batch.identityPolicy,"weak_identity");
  const again=/** @type {any} */ (await (await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-1",limit:1})).json());assert.equal(again.batch.id,pilot.batch.id);assert.equal(again.created,false);
  const empty=await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-2",limit:1});assert.equal(empty.status,409);
  assert.match(/** @type {any} */ (await empty.json()).error.message,/Пересчитайте оценку/);
});

test("weak identity candidates are editor-only",async t=>{
  const f=await fixture(t,{auth:{api:{getSession:async()=>null}}});
  assert.equal((await fetch(`${f.base}/api/story-admin/content/identity-candidates`)).status,401);
  assert.equal((await f.post("/api/story-admin/content/identity-candidates/pilot",{requestKey:"identity-http-3",limit:1})).status,401);
});

test("promo walks service API authenticates by token and needs no browser origin",async t=>{
  const token="p".repeat(40),start={address:"метро «Чистые пруды»",location:{lat:55.765,lon:37.6386}};
  const plan={stops:[{address:"Мясницкая, 17",location:{lat:55.764,lon:37.636}}],geometry:[start.location,{lat:55.766,lon:37.64}],distanceM:2400,walkingMinutes:55,attribution:"© OpenStreetMap contributors"};
  const {runtime,accountStore}=await testAccounts(t,[]);
  ensurePromoWalksUser(runtime.accountDatabase);
  const f=await fixture(t,{accountStore,promoWalksToken:token,planWalk:async()=>plan});
  const call=(authorization,{method="POST",value={idempotencyKey:"shorts-run-0001",title:"Прогулка",walk:{start,mode:"loop",minutes:60}},path="/api/service/promo-walks"}={})=>
    fetch(f.base+path,{method,headers:{"Content-Type":"application/json",...(authorization?{Authorization:authorization}:{})},...(method==="POST"?{body:JSON.stringify(value)}:{})});
  for(const authorization of [null,"Bearer wrong-token",`Basic ${token}`]){const res=await call(authorization);assert.equal(res.status,401);assert.equal(res.headers.get("www-authenticate"),"Bearer");}
  const wrongMethod=await call(`Bearer ${token}`,{method:"GET"});assert.equal(wrongMethod.status,405);assert.equal(wrongMethod.headers.get("allow"),"POST");
  assert.equal((await call(`Bearer ${token}`,{path:"/api/service/promo-walks?x=1"})).status,400);
  const created=await call(`Bearer ${token}`);
  assert.equal(created.status,201);
  const body=/** @type {any} */ (await created.json());
  assert.equal(body.walk.shareUrl,`https://otgolosok.test/walk?share=${body.walk.shareToken}`);
  const shared=await fetch(`${f.base}/api/story-walks/shared/${body.walk.shareToken}`);
  assert.equal(shared.status,200);assert.equal(/** @type {any} */ (await shared.json()).document.id,body.walk.id);
  assert.equal((await call(`Bearer ${token}`)).status,200);
  assert.equal((await call(`Bearer ${token}`,{value:{idempotencyKey:"shorts-run-0001",title:"Прогулка",walk:{start,mode:"loop",minutes:90}}})).status,409);
  // The public planner keeps its same-origin gate.
  assert.equal((await fetch(f.base+"/api/walk-plan",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({start,mode:"loop",minutes:60})})).status,403);
});

test("promo walks endpoint is hidden without a token and rate limits failed attempts",async t=>{
  const hidden=await fixture(t,{promoWalksToken:""});
  assert.equal((await fetch(hidden.base+"/api/service/promo-walks",{method:"POST",headers:{Authorization:"Bearer anything"}})).status,404);
  const f=await fixture(t,{promoWalksToken:"q".repeat(40)});
  const statuses=[];
  for(let attempt=0;attempt<21;attempt++)statuses.push((await fetch(f.base+"/api/service/promo-walks",{method:"POST",headers:{Authorization:"Bearer wrong"}})).status);
  assert.deepEqual(statuses,[...Array(20).fill(401),429]);
});

test("a short promo walks token stops the server from starting",t=>{
  const store=createStore(":memory:",{maxActive:1});t.after(()=>store.close());
  assert.throws(()=>createApp({store,provider:null,origin:"https://otgolosok.test",audioDirectory:tmpdir(),workerEnabled:false,promoWalksToken:"short"}),/PROMO_WALKS_TOKEN must contain at least 32 characters/);
});

test("drafts list unapproved texts with their paragraphs and leave once approved",async(t)=>{
  const f=await fixture(t);
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[
    {placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}},
    {placeId:"osm:node:8",osmType:"node",osmId:8,name:"Сквер",location:{lat:55.76,lon:37.62},tags:{leisure:"park"}}]});
  f.store.createBatch({requestKey:"drafts-api-1",placeIds:["osm:node:7","osm:node:8"],limit:2});
  const story=title=>({title,paragraphs:[{text:`${title}: первый абзац`,factIds:["f1"]},{text:`${title}: второй абзац`,factIds:["f2"]}]});
  // Claim order is not guaranteed: each job gets the story of its own place.
  for(let index=0;index<2;index++){const job=f.store.claimContentJob();f.store.completeContentJob(job.id,{story:story(job.place.name),evidence:{facts:[]}});}
  const list=async()=>/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts?limit=10&offset=0`)).json());
  const drafts=await list();
  assert.equal(drafts.total,2);
  assert.deepEqual(drafts.counts,{plain:2});
  assert.deepEqual(drafts.items.find(item=>item.placeId==="osm:node:7"),{placeId:"osm:node:7",name:"Парк",address:null,location:{lat:55.75,lon:37.61},research:"plain",
    text:{id:drafts.items.find(item=>item.placeId==="osm:node:7").text.id,title:"Парк",paragraphs:["Парк: первый абзац","Парк: второй абзац"],verification:"automatic",
      createdAt:drafts.items.find(item=>item.placeId==="osm:node:7").text.createdAt}});
  assert.equal(/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts?limit=10&offset=0&research=plain`)).json()).total,2);
  assert.equal(/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts?limit=10&offset=0&research=perplexity`)).json()).total,0);
  assert.equal(/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/stats`)).json()).drafts,2);
  assert.equal((await f.post("/api/story-admin/content/places/osm:node:7/approve",{story:story("Парк")})).status,200);
  assert.deepEqual((await list()).items.map(item=>item.placeId),["osm:node:8"]);
  assert.equal(/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/stats`)).json()).drafts,1);
  for(const query of ["limit=0","limit=101","offset=-1","limit=abc","status=draft","research=bogus","research="])
    assert.equal((await fetch(`${f.base}/api/story-admin/content/drafts?${query}`)).status,400,query);
});

test("drafts can be queued for Perplexity re-research only when the search model is configured",async(t)=>{
  const searchProvider=/** @type {any} */ ({searchModel:"perplexity-web/pplx-auto",searchSources:async()=>({sources:[]})});
  const disabled=await fixture(t);
  assert.equal(/** @type {any} */ (await (await fetch(`${disabled.base}/api/story-admin/content/drafts`)).json()).researchAvailable,false);
  const off=await disabled.post("/api/story-admin/content/drafts/research",{requestKey:"research-api-0",limit:5});
  assert.equal(off.status,409);assert.equal(/** @type {any} */ (await off.json()).error.code,"SEARCH_DISABLED");

  const f=await fixture(t,{provider:searchProvider});
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[
    {placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}}]});
  f.store.createBatch({requestKey:"research-api-batch",placeIds:["osm:node:7"],limit:1,identityPolicy:"weak_identity"});
  const job=f.store.claimContentJob();f.store.completeContentJob(job.id,{story:{title:"Парк",paragraphs:[{text:"Абзац",factIds:["f1"]}]},evidence:{facts:[]}});
  const drafts=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts`)).json());
  assert.equal(drafts.researchAvailable,true);assert.equal(drafts.unresearched,1);
  for(const body of [{requestKey:"research-api-1",limit:0},{requestKey:"research-api-1",placeIds:["bad"]},{requestKey:"research-api-1",extra:true},{requestKey:"x",limit:1}])
    assert.equal((await f.post("/api/story-admin/content/drafts/research",body)).status,400,JSON.stringify(body));
  assert.equal((await f.post("/api/story-admin/content/drafts/research",{requestKey:"research-api-1",limit:1},"https://evil.example")).status,403);
  const csrf=await fetch(`${f.base}/api/story-admin/content/drafts/research`,{method:"POST",headers:{Origin:"https://otgolosok.test","Content-Type":"application/json"},body:JSON.stringify({requestKey:"research-api-1",limit:1})});
  assert.equal(csrf.status,403);
  const queued=await f.post("/api/story-admin/content/drafts/research",{requestKey:"research-api-1",placeIds:["osm:node:7"]});
  assert.equal(queued.status,200);assert.equal(/** @type {any} */ (await queued.json()).count,1);
  const inFlight=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts?research=queued`)).json());
  assert.deepEqual(inFlight.counts,{queued:1});
  assert.deepEqual(inFlight.items.map(item=>[item.placeId,item.research]),[["osm:node:7","queued"]]);
  const none=await f.post("/api/story-admin/content/drafts/research",{requestKey:"research-api-2",limit:20});
  assert.equal(none.status,409);assert.equal(/** @type {any} */ (await none.json()).error.code,"NO_DRAFTS_TO_RESEARCH");
});

test("place revoicing accepts only configured audio profiles and offers ElevenLabs when it is set up",async t=>{
  const elevenLabsTts=/** @type {any} */ ({ttsProvider:"elevenlabs",voice:"RuVoice1",voices:[{id:"RuVoice1",label:"Отголосок (ru)"}],speech:async()=>Buffer.from("")});
  /** @type {[object, string[]][]} */
  const cases=[[{},["silero-ru-v1"]],[{elevenLabsTts},["silero-ru-v1","elevenlabs-v3"]]];
  for(const [options,profiles] of cases){
    const f=await fixture(t,options);
    f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[{placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}}]});
    f.store.createBatch({requestKey:"revoice-profile",placeIds:["osm:node:7"],limit:1,mode:"text-only"});
    const paragraph=("Проверенный рассказ о московском парке, его истории, архитектуре и людях. ").repeat(9).trim();
    const job=f.store.claimContentJob(),story={title:"Парк",paragraphs:[{text:paragraph,factIds:["f1"]},{text:paragraph,factIds:["f2"]}]};
    f.store.completeContentJob(job.id,{story,evidence:{facts:[]}});
    assert.equal((await f.post("/api/story-admin/content/places/osm:node:7/approve",{story})).status,200);
    const workers=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/workers`)).json());
    assert.deepEqual(workers.audioProfiles.map(profile=>profile.id),profiles);
    for(const profileId of ["unknown-profile",...(profiles.includes("elevenlabs-v3")?[]:["elevenlabs-v3"])])
      assert.equal((await f.post("/api/story-admin/content/places/osm:node:7/audio",{profileId})).status,400,profileId);
    for(const profileId of profiles){
      const response=await f.post("/api/story-admin/content/places/osm:node:7/audio",{profileId});
      assert.equal(response.status,200);assert.equal(/** @type {any} */ (await response.json()).audioJob.profileId,profileId);
    }
  }
});

test("deep research API exposes availability and queues only one explicit draft",async t=>{
  const provider=/** @type {any} */ ({deepResearchSources:async()=>({sources:[]})});
  const f=await fixture(t,{provider});
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),rulesVersion:"v1",coverage:"fixture",places:[
    {placeId:"osm:node:7",osmType:"node",osmId:7,name:"Парк",location:{lat:55.75,lon:37.61},tags:{leisure:"park"}}]});
  f.store.createBatch({requestKey:"deep-api-fixture",placeIds:["osm:node:7"],limit:1,identityPolicy:"weak_identity"});
  const job=f.store.claimContentJob();f.store.completeContentJob(job.id,{story:{title:"Старый черновик",paragraphs:[{text:"Абзац",factIds:["f1"]}]},evidence:{facts:[]}});
  const drafts=/** @type {any} */ (await (await fetch(`${f.base}/api/story-admin/content/drafts`)).json());
  assert.equal(drafts.deepResearchAvailable,true);
  assert.equal(drafts.researchAvailable,false);
  const input={requestKey:"deep-api-request",mode:"deep",placeIds:["osm:node:7"]};
  assert.equal((await f.post("/api/story-admin/content/drafts/research",{requestKey:input.requestKey,mode:"deep",limit:1})).status,400);
  assert.equal((await f.post("/api/story-admin/content/drafts/research",input,"https://evil.example")).status,403);
  assert.equal((await f.post("/api/story-admin/content/drafts/research",input)).status,200);
  assert.equal((await f.post("/api/story-admin/content/drafts/research",input)).status,200);
  assert.equal(f.store.claimContentJob().checkpoint.researchMode,"perplexity_deep_required");
  assert.equal(f.store.getPlace("osm:node:7").text.draft.title,"Старый черновик");
  const disabled=await fixture(t);
  assert.equal((await disabled.post("/api/story-admin/content/drafts/research",input)).status,409);
});


test("public catalog accepts only complete finite non-wrapping bounds", async t => {
  const f = await fixture(t);
  f.store.importPlaces({ source: "fixture", sourceSha256: "a".repeat(64), places: [1, 2].map(id => ({ placeId: `osm:node:${id}`, osmType: "node", osmId: id, name: `Место ${id}`, location: { lat: 55.75, lon: 37.61 }, tags: {} })) });
  f.store.createBatch({ requestKey: "bounds-http", placeIds: ["osm:node:1"], limit: 1 });
  const job = f.store.claimContentJob();
  f.store.completeContentJob(job.id, { story: { title: "История", paragraphs: [{ text: "Проверенный текст", factIds: ["f1"] }] }, evidence: {} });
  f.store.approvePlaceText("osm:node:1");
  const response = await fetch(`${f.base}/api/content/places?west=37&south=55&east=38&north=56`);
  assert.equal(response.status, 200);
  const result = /** @type {any} */ (await response.json());
  assert.equal(result.total, 1); assert.equal(result.hasMore, false);
  assert.deepEqual(result.places.map(place => place.id), ["osm:node:1"]);
  const outside = await fetch(`${f.base}/api/content/places?west=37.7&south=55&east=38&north=56`);
  assert.deepEqual(await outside.json(), { total: 0, places: [], hasMore: false });
  for (const query of [
    "west=37&south=55&east=38", "west=&south=55&east=38&north=56",
    "west=NaN&south=55&east=38&north=56", "west=38&south=55&east=37&north=56",
    "west=37&south=55&east=38&north=56&west=36",
    "west=37&south=55&east=38&north=56&lat=55.75&lon=37.61&radius=200",
  ]) assert.equal((await fetch(`${f.base}/api/content/places?${query}`)).status, 400, query);
});

/** Raw HTTP: fetch would decompress the body and add its own Accept-Encoding. */
function raw(base,path,headers={},method="GET") {
  return new Promise((resolve,reject)=>{
    const req=httpRequest(base+path,{method,headers},res=>{const chunks=[];res.on("data",chunk=>chunks.push(chunk));res.on("end",()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks)}));});
    req.on("error",reject);req.end();
  });
}

async function mapFixture(t) {
  const f=await fixture(t);
  f.store.importPlaces({source:"fixture",sourceSha256:"a".repeat(64),places:[
    {placeId:"osm:node:8",osmType:"node",osmId:8,name:"Сад",location:{lat:55.75,lon:37.61},tags:{leisure:"garden"}},
    {placeId:"osm:node:9",osmType:"node",osmId:9,name:"Парк",location:{lat:56.1,lon:37.2},tags:{leisure:"park"}},
  ]});
  f.store.createBatch({requestKey:"map-http",placeIds:["osm:node:8","osm:node:9"],limit:2});
  for(let job=f.store.claimContentJob();job;job=f.store.claimContentJob())
    f.store.completeContentJob(job.id,{story:{title:`История: ${job.place.name}`,paragraphs:[{text:"Проверенный текст",factIds:["f1"]}],facts:[{id:"f1"}],sources:[]},evidence:{},autoApprove:true});
  return f;
}

test("map manifest and cells are cacheable, compressed and revalidated by ETag",async t=>{
  const f=await mapFixture(t);
  const manifest=await raw(f.base,"/api/content/map-cells");
  assert.equal(manifest.status,200);
  assert.equal(manifest.headers["cache-control"],"no-cache");assert.equal(manifest.headers.vary,"Accept-Encoding");
  assert.equal(manifest.headers["content-type"],"application/json; charset=utf-8");assert.equal(manifest.headers["content-encoding"],undefined);
  const value=JSON.parse(manifest.body.toString());
  assert.deepEqual({...value,cells:value.cells.map(({lat,lon,count})=>({lat,lon,count}))},{version:1,cellSize:1,cells:[{lat:55,lon:37,count:1},{lat:56,lon:37,count:1}]});

  const identity=await raw(f.base,"/api/content/map-cells/55/37");
  assert.equal(identity.status,200);
  // The manifest's per-cell etag is exactly the cell endpoint's ETag.
  assert.equal(identity.headers.etag,`"${value.cells[0].etag}"`);
  assert.equal(identity.headers["content-length"],String(identity.body.length));
  const cell=JSON.parse(identity.body.toString());
  assert.deepEqual(cell,{lat:55,lon:37,points:[{id:"osm:node:8",lat:55.75,lon:37.61,title:"История: Сад",address:"Сад",durationSec:null,facts:1,sources:0}]});

  /** @type {Record<string, (value: Buffer) => Buffer>} */
  const decoders={br:value=>brotliDecompressSync(value),gzip:value=>gunzipSync(value),identity:value=>value};
  for(const [accept,encoding] of [["br","br"],["gzip, deflate, br","br"],["gzip","gzip"],["br;q=0, gzip","gzip"],["gzip;q=0, br;q=0","identity"],["*","br"],["identity","identity"]]) {
    const decode=decoders[encoding];
    const response=await raw(f.base,"/api/content/map-cells/55/37",{"Accept-Encoding":accept});
    assert.equal(response.headers["content-encoding"],encoding==="identity"?undefined:encoding,accept);
    assert.deepEqual(decode(response.body),identity.body,accept);
    assert.equal(response.headers.etag,identity.headers.etag,accept);
  }

  for(const header of [identity.headers.etag,`W/${identity.headers.etag}`,`"other", ${identity.headers.etag}`,"*"]) {
    const response=await raw(f.base,"/api/content/map-cells/55/37",{"If-None-Match":header});
    assert.equal(response.status,304,header);assert.equal(response.body.length,0,header);
    assert.equal(response.headers.etag,identity.headers.etag);assert.equal(response.headers["cache-control"],"no-cache");assert.equal(response.headers.vary,"Accept-Encoding");
  }
  assert.equal((await raw(f.base,"/api/content/map-cells/55/37",{"If-None-Match":'"other"'})).status,200);
  const head=await raw(f.base,"/api/content/map-cells",{"Accept-Encoding":"br"},"HEAD");
  assert.equal(head.status,200);assert.equal(head.headers["content-encoding"],"br");assert.equal(head.body.length,0);

  assert.deepEqual(JSON.parse((await raw(f.base,"/api/content/map-cells/-1/0")).body.toString()),{lat:-1,lon:0,points:[]});
  for(const path of ["/api/content/map-cells/-0/37","/api/content/map-cells/55/-0","/api/content/map-cells/055/37","/api/content/map-cells/1.5/37",
    "/api/content/map-cells/90/37","/api/content/map-cells/55/-181","/api/content/map-cells/55/180","/api/content/map-cells/55","/api/content/map-cells/55/37/1",
    "/api/content/map-cells/55/37?v=1","/api/content/map-cells?v=1"]) {
    assert.equal((await raw(f.base,path)).status,400,path);
  }
});

test("published place details are revalidated by ETag while a missing place stays uncached",async t=>{
  const f=await mapFixture(t);
  const response=await raw(f.base,"/api/content/places/osm:node:8",{"Accept-Encoding":"gzip"});
  assert.equal(response.status,200);assert.equal(response.headers["cache-control"],"no-cache");assert.equal(response.headers["content-encoding"],"gzip");
  const value=JSON.parse(gunzipSync(response.body).toString());
  assert.equal(value.place.id,"osm:node:8");assert.equal(value.place.text.story.title,"История: Сад");
  assert.equal((await raw(f.base,"/api/content/places/osm:node:8",{"If-None-Match":response.headers.etag})).status,304);
  const missing=await raw(f.base,"/api/content/places/osm:node:404");
  assert.equal(missing.status,404);assert.equal(missing.headers["cache-control"],"no-store");assert.equal(missing.headers.etag,undefined);
});
