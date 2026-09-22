import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./server.mjs";
import { createStore } from "./store.mjs";
import { createAuth } from "./auth.mjs";
import { createAccountStore } from "./account-store.mjs";
import { sessionCsrfToken } from "./auth.mjs";

const origin="https://account.test",secret="account-api-test-secret",sessionId="session-1";
const authFor=role=>({api:{getSession:async()=>({user:{id:`${role}-1`,email:`${role}@example.test`,name:role,role},session:{id:sessionId,createdAt:new Date()}})},handler:async request=>{const valid=JSON.parse(await request.text()).password==="correct-password";return new Response(valid?'{"status":true}':'{"message":"Invalid password"}',{status:valid?200:400,headers:{"Content-Type":"application/json"}});}});

async function listen(t,{role="user",accountStore={},store=createStore(":memory:",{maxDaily:20,maxActive:20})}={}){
  const directory=await mkdtemp(join(tmpdir(),"otg-account-api-"));
  const app=createApp({store,provider:{},origin,audioDirectory:directory,workerEnabled:false,auth:authFor(role),authSecret:secret,accountStore});
  await new Promise(done=>app.server.listen(0,"127.0.0.1",done));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  t.after(async()=>{await app.close();store.close();await rm(directory,{recursive:true,force:true});});
  return {base,store,headers:{Origin:origin,"Content-Type":"application/json","X-CSRF-Token":sessionCsrfToken(secret,sessionId)}};
}

async function realAccountFixture(t) {
  const runtime=await createAuth({databasePath:":memory:",baseURL:origin,secret:"account-http-walk-secret-longer-than-32-characters",production:false});
  const now=new Date().toISOString();
  runtime.database.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("user-1","Пользователь","private@example.test",1,now,now);
  const accountStore=createAccountStore(runtime.database);
  t.after(()=>runtime.close());
  return listen(t,{accountStore});
}

test("ordinary users cannot use editor API while an editor session can",async t=>{
  const user=await listen(t,{role:"user",accountStore:{}});
  assert.equal((await fetch(user.base+"/api/story-admin/jobs")).status,401);
  const editor=await listen(t,{role:"editor",accountStore:{}});
  assert.equal((await fetch(editor.base+"/api/story-admin/jobs")).status,200);
});

test("account deletion requires the current password and cancels private research",async t=>{
  let deleted=false,revoked=null;
  const accountStore={researchJobIds:()=>["research-1"],deleteAccountData:()=>{deleted=true;}};
  const store=createStore(":memory:",{maxDaily:20,maxActive:20});store.revokeWalkResearchAccess=ids=>{revoked=ids;};
  const f=await listen(t,{accountStore,store});
  assert.equal((await fetch(f.base+"/api/me",{method:"DELETE",headers:f.headers,body:JSON.stringify({password:"wrong-password"})})).status,403);assert.equal(deleted,false);
  assert.equal((await fetch(f.base+"/api/me",{method:"DELETE",headers:f.headers,body:JSON.stringify({password:"correct-password"})})).status,200);
  assert.deepEqual(revoked,["research-1"]);assert.equal(deleted,true);
});

test("a valid legacy recovery token claims a research job for the signed-in user",async t=>{
  const store=createStore(":memory:",{maxDaily:20,maxActive:20}),token="11111111-1111-4111-8111-111111111111";
  const job=store.createWalkResearch({start:{address:"Москва, Арбат, 1",location:{lat:55.75,lon:37.61}},mode:"loop",minutes:30,consent:true,recoveryToken:token});
  let owned=false,attached=null;
  const accountStore={ownsRequest:()=>owned,attachRequest:(userId,jobId,operation,key)=>{owned=true;attached={userId,jobId,operation,key};}};
  const f=await listen(t,{accountStore,store});
  const response=await fetch(`${f.base}/api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30&recoveryToken=${token}`);
  assert.equal(response.status,200);assert.equal((await response.json()).id,job.id);
  assert.deepEqual(attached,{userId:"user-1",jobId:job.id,operation:"walk_research",key:token});
});

test("generation idempotency is bound to the normalized request and quota",async t=>{
  const runtime=await createAuth({databasePath:":memory:",baseURL:origin,secret:"account-idempotency-secret-longer-than-32-characters",production:false});
  t.after(()=>runtime.close());const now=new Date().toISOString();
  runtime.database.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("user-1","user","user@example.test",1,now,now);
  const accountStore=createAccountStore(runtime.database),f=await listen(t,{accountStore});
  const post=(address,key)=>fetch(f.base+"/api/story-jobs",{method:"POST",headers:f.headers,body:JSON.stringify({address,idempotencyKey:key})});
  const key="same-request-key",first=await post("Arbat street, 1",key),firstValue=await first.json();
  assert.equal(first.status,200);const repeated=await post("Arbat street, 1",key);
  assert.equal(repeated.status,200);assert.equal((await repeated.json()).id,firstValue.id);
  assert.equal((await post("Arbat street, 2",key)).status,409);
  for(let index=2;index<=6;index++)assert.equal((await post(`Arbat street, ${index}`,`request-key-${index}`)).status,200);
  assert.equal((await post("Arbat street, 7","request-key-7")).status,429);
  assert.equal(runtime.database.prepare("SELECT SUM(units) value FROM user_generation_quota WHERE user_id='user-1'").get().value,6);
  assert.equal(accountStore.listRequests("user-1",50).requests.length,6);
});

test("generation intent survives a lost response and rejects legacy keys",async t=>{
  const runtime=await createAuth({databasePath:":memory:",baseURL:origin,secret:"account-intent-secret-longer-than-32-characters",production:false});t.after(()=>runtime.close());
  const now=new Date().toISOString();runtime.database.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,?,?,?)").run("u1","User","u1@example.test",1,now,now);
  const accountStore=createAccountStore(runtime.database);
  assert.deepEqual(accountStore.beginGeneration("u1","durable-key","create","fingerprint",1,6),{created:true,jobId:null});
  accountStore.completeGeneration("u1","durable-key","job-1");
  assert.deepEqual(accountStore.beginGeneration("u1","durable-key","create","fingerprint",1,6),{created:false,jobId:"job-1"});
  assert.throws(()=>accountStore.beginGeneration("u1","durable-key","create","different",1,6),{code:"CONFLICT"});
  runtime.database.prepare("INSERT INTO user_generation_requests VALUES(?,?,?,?,?,?)").run("old","u1","old-job","create","legacy-key",now);
  assert.throws(()=>accountStore.beginGeneration("u1","legacy-key","create","fingerprint",1,6),{code:"CONFLICT"});
});

test("account walk API returns cards, a safe view and a revocable current shared revision", async t => {
  const f=await realAccountFixture(t);
  const start={address:"Москва, Арбат, 1",location:{lat:55.75,lon:37.60}},stop={address:"Москва, Арбат, 10",location:{lat:55.751,lon:37.601}};
  const job=f.store.createOrGet({key:"account-walk-story",address:stop.address});
  f.store.update(job.id,{stage:"ready",data:{story:{title:"История дома",address:stop.address,paragraphs:[{text:"Проверенный рассказ о доме и его жителях.",factIds:[]}],sources:[],facts:[]},audio:{url:`/api/story-audio/${"a".repeat(64)}.mp3`,sha256:"a".repeat(64),durationSec:34}}},job.revision);
  const snapshot={version:2,id:"11111111-1111-4111-8111-111111111111",title:"Арбатская прогулка",description:"",city:"Москва",mode:"open",minutes:30,start,
    stops:[{id:"22222222-2222-4222-8222-222222222222",place:stop,storyRef:{kind:"job",id:job.id},transition:"",nextHint:""}],route:{geometry:[start.location,stop.location],distanceM:220,walkingMinutes:4,attribution:"OSM"},fieldChecked:false};
  const post=await fetch(`${f.base}/api/me/walks`,{method:"POST",headers:f.headers,body:JSON.stringify({title:snapshot.title,snapshot,idempotencyKey:"http-walk-1"})});
  assert.equal(post.status,201);const created=(await post.json()).walk;
  const list=await (await fetch(`${f.base}/api/me/walks`)).json();assert.equal(list.walks.length,1);assert.equal("snapshot" in list.walks[0],false);assert.equal("shareToken" in list.walks[0],true);
  const view=await fetch(`${f.base}/api/me/walks/${created.id}/view`);assert.equal(view.status,200);const viewValue=await view.json();assert.equal(viewValue.document.id,created.id);assert.equal(viewValue.chapters[0].status,"ready");assert.equal(JSON.stringify(viewValue).includes("private@example.test"),false);
  const shared=await fetch(`${f.base}/api/me/walks/${created.id}/sharing`,{method:"PUT",headers:f.headers,body:JSON.stringify({revision:created.revision,enabled:true})});assert.equal(shared.status,200);const sharedValue=(await shared.json()).walk;assert.match(sharedValue.shareToken,/^[a-f0-9-]{36}$/);
  const publicUrl=`${f.base}/api/story-walks/shared/${sharedValue.shareToken}`;
  const publicView=await fetch(publicUrl);assert.equal(publicView.status,200);const publicValue=await publicView.json();assert.equal(publicValue.document.title,snapshot.title);assert.equal(JSON.stringify(publicValue).includes("private@example.test"),false);assert.equal(JSON.stringify(publicValue).includes("recovery"),false);
  const update=await fetch(`${f.base}/api/me/walks/${created.id}`,{method:"PATCH",headers:f.headers,body:JSON.stringify({title:"Обновлённая прогулка",snapshot:{...created.snapshot,title:"Обновлённая прогулка"},revision:sharedValue.revision})});assert.equal(update.status,200);
  assert.equal((await (await fetch(publicUrl)).json()).document.title,"Обновлённая прогулка");
  assert.equal((await fetch(`${f.base}/api/me/walks/${created.id}/sharing`,{method:"PUT",headers:f.headers,body:JSON.stringify({revision:sharedValue.revision,enabled:false})})).status,409);
  const latest=(await (await fetch(`${f.base}/api/me/walks/${created.id}`)).json()).walk;
  assert.equal((await fetch(`${f.base}/api/me/walks/${created.id}/sharing`,{method:"PUT",headers:f.headers,body:JSON.stringify({revision:latest.revision,enabled:false})})).status,200);
  assert.equal((await fetch(publicUrl)).status,404);
});
