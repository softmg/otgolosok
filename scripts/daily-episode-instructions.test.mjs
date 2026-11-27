import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const root = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('.bb/workflows/daily-episode.js', root),'utf8');
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
const chains = Object.fromEntries(['light','worker','visual','architect','reviewer'].map(role=>[role,[
 {provider:'codex',model:'gpt-6-luna',reasoningLevel:'medium',family:'gpt'},
 {provider:'acp-antigravity-acp',model:'gemini-3.8-flash',family:'gemini'},
]]));
async function run(config = {}) {
 const calls=[], counts=new Map();
 const agent=async(prompt,options)=>{
  const label=options.label, count=(counts.get(label)||0)+1;counts.set(label,count);
  calls.push({prompt,...options});
  if(config.respond) {
   const custom=config.respond(label,count,prompt);
   if(custom !== undefined) return custom;
  }
  if(label==='preflight:oauth-and-infra' || label==='preflight:retry-worker') return {infraOk:true,summary:'fixture'};
  if(label.startsWith('preflight:verify-disk')) return {verified:true,infraOk:true,slotFree:true,alreadyBuilt:config.alreadyBuilt||false,alreadyPublished:false,reason:'fixture'};
  if(label==='architect:episode-brief') return {readyToProduce:true,planType:config.type||'normal',placeName:'fixture',assetsAlreadyReady:false,scriptAlreadyReady:false,candidateUnfit:false,codeBug:{},summary:'fixture'};
  if(label==='assets:researcher') return {ok:true,sourcesCount:3,summary:'fixture'};
  if(label==='assets:media-hunter') return {ok:true,distinctPlacePhotos:3,commonsRequestsUsed:1,summary:'fixture'};
  if(label==='assets:scriptwriter') return {ok:true,scriptPresent:true,summary:'fixture'};
  if(label==='assets:verify-disk') return {verified:true,visualMaterialOk:true,scriptPresent:true,pregateOk:true,reason:'fixture'};
  if(label.startsWith('early:attempt-')) return {ok:true,codeBug:{},candidateUnfit:false,summary:'fixture'};
  if(label.startsWith('early:cross-family-review-')) return {verified:true,earlyOk:true,scriptsClean:true,failedStages:[],blockingFindings:[],reason:'fixture'};
  if(label.startsWith('phase2:')) return {ok:true,measuredOk:true,promoReviewReady:true,audioQcOk:true,blockClass:'none',codeBug:{},summary:'fixture'};
  if(label==='final-gate:independent-verify') return {approved:config.approved??true,issues:[],summary:'fixture'};
  if(label==='publish:youtube-scheduled' || label==='publish:architect-repair') return {ok:true,videoId:'fixture',privacyStatus:'private',publishAt:'2026-11-27T17:30:00Z',summary:'fixture'};
  if(label==='publish:verify-readback') return {verified:config.readback??true,videoId:'fixture',summary:'fixture'};
  throw Error(`Unexpected mock stage ${label}`);
 };
 const result=await new AsyncFunction('args','agent','parallel','phase','log',source.replace('export const meta','const meta'))(
  {date:'2026-11-27',modelChains:chains,...config.args},agent,async tasks=>Promise.all(tasks.map(task=>task())),()=>{},()=>{});
 return {calls,result};
}
const noPublish = calls => assert.ok(!calls.some(c=>c.label.startsWith('publish:')));
for (const config of [{type:'normal'}, {type:'creative'}, {alreadyBuilt:true}, {type:'normal',respond:label=>label==='preflight:verify-disk'?{verified:false,reason:'retry'}:undefined}]) {
 test(`Final Gate rejection blocks publication: ${JSON.stringify({type:config.type,alreadyBuilt:config.alreadyBuilt,retry:!!config.respond})}`,async()=>{
  const {calls,result}=await run({...config,approved:false});
  assert.equal(result.status,'blocked');assert.equal(result.stage,'final-gate');noPublish(calls);
  for(const call of calls) {
   assert.ok(call.prompt.includes('docs/instructions/README.md'),call.label);
   assert.ok(call.prompt.includes('/assets/promo-review/editorial.md'),call.label);
   assert.ok(call.prompt.includes('providers-and-payloads.md'),call.label);
  }
  if(!config.alreadyBuilt) assert.ok(calls.some(c=>c.label==='assets:scriptwriter'));
 });
}
test('early failure routes visual correction and then reaches Final Gate',async()=>{
 const {calls,result}=await run({approved:false,respond:label=>label==='early:cross-family-review-1'?{verified:false,earlyOk:false,scriptsClean:true,failedStages:['composed-frame'],blockingFindings:['fixture'],reason:'fixture'}:undefined});
 assert.ok(calls.some(c=>c.label==='early:attempt-2-visual'));
 assert.equal(result.stage,'final-gate');noPublish(calls);
});
test('early attempt budget is finite and blocks rendering',async()=>{
 const {calls,result}=await run({respond:label=>label.startsWith('early:cross-family-review-')?{verified:false,earlyOk:false,scriptsClean:true,failedStages:['text'],blockingFindings:['fixture'],reason:'fixture'}:undefined});
 assert.equal(result.stage,'early-preproduction');assert.equal(result.status,'blocked');
 assert.equal(calls.filter(c=>c.label.startsWith('early:attempt-')).length,2);
 assert.ok(calls.some(c=>c.label==='early:attempt-2-architect'));
 assert.ok(!calls.some(c=>c.label.startsWith('phase2:')));noPublish(calls);
});
test('locked render audio repair runs architect once',async()=>{
 const {calls,result}=await run({approved:false,respond:label=>label==='phase2:locked-render-and-audit'?{ok:false,blockClass:'audio_defect',summary:'fixture'}:undefined});
 assert.equal(calls.filter(c=>c.label==='phase2:architect-triage').length,1);
 assert.equal(result.stage,'final-gate');noPublish(calls);
});
test('real code bug stops before assets; empty objects in happy scenarios do not',async()=>{
 const {calls,result}=await run({respond:label=>label==='architect:episode-brief'?{codeBug:{file:'scripts/fixture.mjs',symptom:'fixture',reproduction:'fixture'}}:undefined});
 assert.equal(result.blockClass,'code_bug');assert.equal(result.stage,'episode-architect');noPublish(calls);
 assert.ok(!calls.some(c=>c.label.startsWith('assets:')));
});
test('413 is never retried with an unchanged prompt',async()=>{
 let attempts=0;
 await assert.rejects(run({respond:label=>{if(label==='preflight:oauth-and-infra'){attempts++;throw Error('413 Payload Too Large');}}}),/413/);
 assert.equal(attempts,1);
});
test('transient transport failure uses a bounded alternative model',async()=>{
 const {calls,result}=await run({approved:false,alreadyBuilt:true,respond:(label,count)=>{if(label==='preflight:oauth-and-infra'&&count===1)throw Error('503 Service Unavailable');}});
 assert.equal(calls.filter(c=>c.label==='preflight:oauth-and-infra').length,2);
 assert.equal(result.stage,'final-gate');noPublish(calls);
});
test('provider warning banner corrupting JSON triggers quota fallback instead of schema abort',async()=>{
 const {calls,result}=await run({approved:false,alreadyBuilt:true,respond:(label,count)=>{if(label==='preflight:oauth-and-infra'&&count===1)throw Error('Structured output failed after 2 corrective turns: worker JSON response is corrupt: Unexpected token \'⚠\', "⚠ Third-pa"... is not valid JSON');}});
 assert.equal(calls.filter(c=>c.label==='preflight:oauth-and-infra').length,2);
 assert.equal(result.stage,'final-gate');noPublish(calls);
});
test('scheduled publication requires successful independent readback',async()=>{
 const {calls,result}=await run();
 assert.equal(result.status,'published');
 assert.ok(calls.find(c=>c.label==='publish:youtube-scheduled').prompt.includes('private + publishAt'));
 assert.ok(calls.find(c=>c.label==='publish:verify-readback').prompt.includes('privacyStatus'));
 const failed=await run({readback:false});assert.equal(failed.result.status,'blocked');assert.equal(failed.result.blockClass,'publish_blocker');
});
test('publishScheduled=false completes without publishing',async()=>{
 const {calls,result}=await run({args:{publishScheduled:false}});
 assert.equal(result.status,'approved');noPublish(calls);
});
test('all reached normal, creative and retry prompts resolve domains and rule anchors',async()=>{
 const scenarios = [
  {}, {type:'creative'}, {alreadyBuilt:true},
  {respond:label=>label==='early:cross-family-review-1'?{verified:false,earlyOk:false,scriptsClean:true,failedStages:['composed-frame'],blockingFindings:['fixture'],reason:'fixture'}:undefined},
  {respond:label=>label.startsWith('early:cross-family-review-')?{verified:false,earlyOk:false,scriptsClean:true,failedStages:['text'],blockingFindings:['fixture'],reason:'fixture'}:undefined},
  {respond:label=>label==='phase2:locked-render-and-audit'?{ok:false,blockClass:'audio_defect',summary:'fixture'}:undefined},
  {respond:label=>label==='preflight:verify-disk'?{verified:false,reason:'retry'}:undefined},
  {respond:label=>label==='publish:youtube-scheduled'?{ok:false,summary:'retry upload'}:undefined},
 ];
 const calls=(await Promise.all(scenarios.map(config=>run(config)))).flatMap(result=>result.calls);
 const registry=new Map();
 for (const base of [new URL('docs/instructions/',root),new URL('../otgolosok-shorts/assets/promo-review/',root)]) {
  for(const name of fs.readdirSync(base).filter(name=>name.endsWith('.md'))) {
   const body=fs.readFileSync(new URL(name,base),'utf8');
   for(const match of body.matchAll(/^## ([A-Z]+-\d+)$/gm)) registry.set(match[1],{name,body,url:new URL(name,base)});
  }
 }
 for(const call of calls) {
  assert.ok(call.prompt.includes('docs/instructions/README.md'),call.label);
  for(const domain of ['engineering.md','providers-and-payloads.md','orchestration.md','episode-state.md','verification.md','publication.md','operations.md','editorial.md','visual.md','audio.md','packaging.md']) assert.ok(call.prompt.includes(domain),`${call.label}: ${domain}`);
  for(const match of call.prompt.matchAll(/\b(?:ENG|PROV|ORCH|STATE|VERIFY|PUB|OPS|EDIT|VIS|PACK|AUDIO)-\d+\b/g)) assert.ok(registry.has(match[0]),`${call.label}: ${match[0]}`);
  const links = [...call.prompt.matchAll(/\[([A-Z]+-\d+)\]\(([^)]+)\)/g)];
  assert.ok(links.length > 0, `${call.label}: no canonical links`);
  for (const [, ruleId, target] of links) {
   const url = new URL(target, new URL('.bb/workflows/daily-episode.js', root));
   assert.equal(url.hash, `#${ruleId.toLowerCase()}`, `${call.label}: ${target}`);
   url.hash = '';
   const canonical = registry.get(ruleId);
   assert.ok(canonical, `${call.label}: ${ruleId}`);
   assert.equal(url.href, canonical.url.href, `${call.label}: noncanonical path ${target}`);
   const body = fs.readFileSync(url, 'utf8');
   assert.ok(body.split('\n').includes(`## ${ruleId}`), `${call.label}: missing heading ${target}`);
  }
 }
 const expected={'architect:episode-brief':'STATE-01','assets:researcher':'EDIT-01','assets:media-hunter':'VIS-01','assets:scriptwriter':'EDIT-04','early:attempt-1-worker':'STATE-03','early:cross-family-review-1':'VERIFY-01','phase2:locked-render-and-audit':'STATE-04','final-gate:independent-verify':'VERIFY-02','publish:youtube-scheduled':'PUB-01','publish:verify-readback':'PUB-02'};
 for(const [label,rule] of Object.entries(expected)) assert.ok(calls.find(call=>call.label===label)?.prompt.includes(rule),`${label}: ${rule}`);
});

test('real owner approval binds composed-frame to current inputs and never bypasses Final Gate', async t => {
 const {default:os} = await import('node:os');
 const {default:path} = await import('node:path');
 const {createOwnerPreproductionApproval,ownerPreproductionWaiver,recordOwnerWaiver} =
  await import('../../otgolosok-creative/scripts/owner-preproduction-approval.mjs');
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'workflow-waiver-'));
 t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 const date='2026-11-27',work=path.join(project,`tomorrow-${date}`);
 fs.mkdirSync(work);fs.mkdirSync(path.join(project,'scripts'));
 fs.writeFileSync(path.join(project,'scripts/normal-visual-treatment.mjs'),'fixture');
 fs.writeFileSync(path.join(work,'script.json'),'fixture');
 fs.writeFileSync(path.join(work,'prepared.json'),JSON.stringify({storyPhotos:[{photo:{sha1:'fixture'}}]}));
 const review={scores:{composition:6},checks:[{code:'photos',status:'failed'}],corrections:['fixture']};
 const check=()=>ownerPreproductionWaiver({work,project,stage:'composed-frame',review});
 assert.equal(check(),null);
 createOwnerPreproductionApproval({runDir:work,date,instruction:'Synthetic test approval',project});
 const waiver=check();assert.ok(waiver);
 const receipt=recordOwnerWaiver({work,stage:'composed-frame',reviewKey:'fixture',review,waiver});
 assert.equal(JSON.parse(fs.readFileSync(receipt)).approval.approvalSha256,waiver.approvalSha256);
 assert.equal(ownerPreproductionWaiver({work,project,stage:'raw-photo',review}),null);
 for (const code of ['facts','rights','visualEvidence','derivativeBinding']) {
  assert.equal(ownerPreproductionWaiver({work,project,stage:'composed-frame',review:{...review,checks:[{code,status:'failed'}]}}),null,code);
 }
 const preparedFile=path.join(work,'prepared.json');
 const originalPrepared=fs.readFileSync(preparedFile);
 fs.writeFileSync(preparedFile,JSON.stringify({storyPhotos:[{photo:{sha1:'different-photo'}}]}));
 assert.equal(check(),null,'changed photos invalidate approval');
 fs.writeFileSync(preparedFile,originalPrepared);
 const treatmentFile=path.join(project,'scripts/normal-visual-treatment.mjs');
 fs.writeFileSync(treatmentFile,'changed treatment');
 assert.equal(check(),null,'changed treatment invalidates approval');
 fs.writeFileSync(treatmentFile,'fixture');
 assert.ok(check(),'restored current inputs match approval');
 const scenario=()=>run({approved:false,respond:label=>label.startsWith('early:cross-family-review-')?
  {verified:!!check(),earlyOk:!!check(),scriptsClean:true,failedStages:check()?[]:['composed-frame'],blockingFindings:check()?[]:['stale approval'],reason:'real input binding'}:undefined});
 const valid=await scenario();assert.equal(valid.result.stage,'final-gate');noPublish(valid.calls);
 fs.writeFileSync(path.join(work,'script.json'),'changed');
 assert.equal(check(),null);
 const stale=await scenario();assert.equal(stale.result.stage,'early-preproduction');noPublish(stale.calls);
});

test('explicit three-attempt budget is respected for creative editorial repairs',async()=>{
 const {calls,result}=await run({type:'creative',args:{maxEarlyAttempts:3},respond:label=>label.startsWith('early:cross-family-review-')?{verified:false,earlyOk:false,scriptsClean:true,failedStages:['text'],blockingFindings:['fixture'],reason:'fixture'}:undefined});
 assert.equal(result.stage,'early-preproduction');
 assert.equal(calls.filter(c=>c.label.startsWith('early:attempt-')).length,3);
 assert.ok(calls.some(c=>c.label==='early:attempt-3-architect'));noPublish(calls);
});

test('publication repair is bounded and still requires independent readback',async()=>{
 const {calls,result}=await run({respond:label=>label==='publish:youtube-scheduled'?{ok:false,summary:'upload receipt unavailable'}:undefined});
 assert.equal(result.status,'published');
 assert.equal(calls.filter(call=>call.label==='publish:architect-repair').length,1);
 assert.equal(calls.filter(call=>call.label==='publish:verify-readback').length,1);
});

test('scriptsClean failure blocks render even with passed early receipts',async()=>{
 const {calls,result}=await run({respond:label=>label.startsWith('early:cross-family-review-')?{verified:true,earlyOk:true,scriptsClean:false,failedStages:[],blockingFindings:['worker modified scripts'],reason:'dirty worker scripts'}:undefined});
 assert.equal(result.stage,'early-preproduction');
 assert.equal(result.blockClass,'code_bug');
 assert.ok(!calls.some(call=>call.label.startsWith('phase2:')));
 noPublish(calls);
});

// Mock проверяет переходы workflow, но не понимание моделью нормы VIS-02.
// Смысл «фото именно места» проверяется независимым сравнением канона и промптов с HEAD.
for (const [label, stage] of [['architect:episode-brief', 'episode-architect'], ['assets:media-hunter', 'parallel-assets']]) {
 test(`candidateUnfit from ${label} blocks subsequent production and publication`, async () => {
  const {calls,result}=await run({respond:current=>current===label ? {
   readyToProduce:true,planType:'normal',placeName:'fixture',assetsAlreadyReady:false,
   scriptAlreadyReady:false,candidateUnfit:true,ok:false,distinctPlacePhotos:1,
   commonsRequestsUsed:15,summary:'Only one place photo and two portraits',
  } : undefined});
  assert.equal(result.status,'blocked');
  assert.equal(result.stage,stage);
  assert.equal(result.blockClass,'candidate_unfit');
  noPublish(calls);
  assert.ok(!calls.some(c=>c.label.startsWith('early:') || c.label.startsWith('phase2:') || c.label.startsWith('final-gate:')));
  if(stage==='episode-architect') assert.ok(!calls.some(c=>c.label.startsWith('assets:')));
  else {
   assert.ok(!calls.some(c=>c.label==='assets:researcher' || c.label==='assets:scriptwriter' || c.label==='assets:verify-disk'), 'Media Gate candidateUnfit must stop before Researcher and Scriptwriter');
  }
  assert.ok(calls.find(c=>c.label===label).prompt.includes('visual.md#vis-02'));
  assert.ok(calls.find(c=>c.label===label).prompt.includes('photo-search.mjs'));
 });
}

test('candidateKey leaves Preflight prompts identical for resumeRunId prefix caching and updates Episode Architect', async () => {
 const first = await run({args:{candidateKey:'osm:node:1'}, approved:false});
 const second = await run({args:{candidateKey:'osm:node:2'}, approved:false});
 const pre1 = first.calls.filter(c=>c.label.startsWith('preflight:')).map(c=>c.prompt);
 const pre2 = second.calls.filter(c=>c.label.startsWith('preflight:')).map(c=>c.prompt);
 assert.deepEqual(pre1, pre2, 'Preflight prompts must not depend on candidateKey so resumeRunId caches Phase 1');
 const arch1 = first.calls.find(c=>c.label==='architect:episode-brief').prompt;
 const arch2 = second.calls.find(c=>c.label==='architect:episode-brief').prompt;
 assert.notEqual(arch1, arch2);
 assert.ok(arch2.includes('osm:node:2'));
});

test('assets:verify-disk reads nested visual-material result fields and never demands workDir for normal', async () => {
 const normal = await run({type:'normal', approved:false});
 const normalVerify = normal.calls.find(c=>c.label==='assets:verify-disk').prompt;
 assert.ok(normalVerify.includes('result.score>=7'));
 assert.ok(normalVerify.includes('result.distinctSubjects>=3'));
 assert.ok(normalVerify.includes('не требуется по STATE-02'));
 const creative = await run({type:'creative', approved:false});
 const creativeVerify = creative.calls.find(c=>c.label==='assets:verify-disk').prompt;
 assert.ok(creativeVerify.includes('result.score>=7'));
 assert.ok(creativeVerify.includes('result.distinctSubjects>=3'));
 const archNormal = normal.calls.find(c=>c.label==='architect:episode-brief').prompt;
 assert.ok(archNormal.includes('episode-pregate.mjs'));
 assert.ok(archNormal.includes('НЕ сравнивай сырой sha256 файла'));
});
