import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {verifyInstructions} from './verify-instructions.mjs';
function fixture(t, mutate = () => {}) {
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'instruction-check-'));
 t.after(()=>fs.rmSync(parent,{recursive:true,force:true}));
 const root=path.join(parent,'project');fs.mkdirSync(path.join(root,'docs/instructions'),{recursive:true});
 const entry={repo:'project',path:'docs/instructions/domain.md',role:'canonical',owner:'example',ruleIds:['RULE-01'],decision:'new-domain'};
 const text='# Domain\n\n## Владеет\n\nExample.\n\n## Не владеет\n\nOther.\n\n## Ссылки на смежные домены\n\n## RULE-01\n\nRule.\n';
 const data={files:[entry]};mutate(data);
 fs.writeFileSync(path.join(root,entry.path),text);
 fs.writeFileSync(path.join(root,'docs/instructions/inventory.json'),JSON.stringify(data));
 return root;
}
test('valid single owner and section pass',t=>assert.equal(verifyInstructions(fixture(t)).ok,true));
test('duplicate ids fail',t=>assert.match(verifyInstructions(fixture(t,data=>data.files.push({...data.files[0]}))).errors.join('\n'),/Duplicate rule/));
test('missing owner fails',t=>assert.match(verifyInstructions(fixture(t,data=>delete data.files[0].owner)).errors.join('\n'),/Missing owner/));
test('broken link and anchor fail',t=>{
 const root=fixture(t), file=path.join(root,'docs/instructions/domain.md');
 fs.appendFileSync(file,'\n[missing](missing.md) [anchor](domain.md#missing)\n');
 assert.match(verifyInstructions(root).errors.join('\n'),/Broken link/);
 assert.match(verifyInstructions(root).errors.join('\n'),/Broken anchor/);
});
test('pending semantic review never produces green',t=>assert.match(verifyInstructions(fixture(t,data=>data.files.push({decision:'pending-line-review'}))).errors.join('\n'),/Semantic migration incomplete/));
test('missing sibling layout is an explicit failure',t=>{
 const root=fixture(t), file=path.join(root,'docs/instructions/inventory.json');
 const data=JSON.parse(fs.readFileSync(file));data.requiredCheckouts=['absent'];fs.writeFileSync(file,JSON.stringify(data));
 assert.match(verifyInstructions(root).errors.join('\n'),/Missing sibling checkout/);
});
test('adapter imports resolve and cycles fail',t=>{
 const root=fixture(t), file=path.join(root,'docs/instructions/inventory.json');
 const data=JSON.parse(fs.readFileSync(file));
 for(const name of ['a','b']) data.files.push({repo:'project',path:`${name}.md`,role:'adapter'});
 fs.writeFileSync(path.join(root,'a.md'),'@b.md\n');fs.writeFileSync(path.join(root,'b.md'),'@a.md\n');
 fs.writeFileSync(file,JSON.stringify(data));
 assert.match(verifyInstructions(root).errors.join('\n'),/Adapter\/import cycle/);
 fs.writeFileSync(path.join(root,'b.md'),'@missing.md\n');
 assert.match(verifyInstructions(root).errors.join('\n'),/Broken entrypoint link/);
});
test('migrated entries need a named owner and target',t=>{
 const root=fixture(t,data=>data.files.push({repo:'project',path:'old.md',decision:'migrated'}));
 assert.match(verifyInstructions(root).errors.join('\n'),/Incomplete migration decision/);
});

test('migrated file cannot conceal pending candidates', t => {
 const root = fixture(t, data => data.files[0].normativeCandidates = [{line: 12, decision: 'pending-semantic-review'}]);
 assert.match(verifyInstructions(root).errors.join('\n'), /1 candidates pending/);
});
test('unknown file and candidate decisions fail closed', t => {
 const root = fixture(t, data => {
  data.files[0].decision = 'approved-by-magic';
  data.files[0].normativeCandidates = [{line: 12, decision: 'ignored'}];
 });
 assert.match(verifyInstructions(root).errors.join('\n'), /Unknown decision/);
 assert.match(verifyInstructions(root).errors.join('\n'), /Unknown candidate decision/);
});
test('migration resolves a canonical rule and its owner', t => {
 const root = fixture(t), inventory = path.join(root, 'docs/instructions/inventory.json');
 const data = JSON.parse(fs.readFileSync(inventory));
 data.files.push({repo:'project',path:'old.md',role:'reference',decision:'migrated',owner:'example',migrationTarget:'project/docs/instructions/domain.md#rule-01'});
 fs.writeFileSync(path.join(root,'old.md'),'[Rule](docs/instructions/domain.md#rule-01)\n');
 const write = () => fs.writeFileSync(inventory, JSON.stringify(data));
 write();
 assert.ok(!verifyInstructions(root).errors.some(e => e.includes('Invalid migration target')));
 for (const change of [{owner:'invented'}, {migrationTarget:'project/docs/instructions/domain.md#rule-99'}, {migrationTarget:'project/missing.md#rule-01'}, {ruleId:'RULE-01',migrationTarget:'project/docs/instructions/domain.md#invented-anchor'}]) {
  const original = {...data.files[1]}; Object.assign(data.files[1], change); write();
  assert.match(verifyInstructions(root).errors.join('\n'), /Invalid migration target/);
  data.files[1] = original;
 }
});
test('review evidence must match the reviewed revision', async t => {
 const {createHash} = await import('node:crypto');
 const root = fixture(t), inventory = path.join(root,'docs/instructions/inventory.json');
 const data = JSON.parse(fs.readFileSync(inventory)), file = path.join(root, data.files[0].path);
 data.files[0].review = {sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex'),method:'full-text comparison'};
 fs.writeFileSync(inventory, JSON.stringify(data));
 assert.equal(verifyInstructions(root).ok,true);
 fs.appendFileSync(file,'Changed rule.\n');
 assert.match(verifyInstructions(root).errors.join('\n'),/Stale review hash/);
});
test('historical disposition needs a reason and consumption evidence', t => {
 const root = fixture(t, data => Object.assign(data.files[0],{role:'historical',decision:'archived-historical'}));
 assert.match(verifyInstructions(root).errors.join('\n'),/Missing decision reason/);
 assert.match(verifyInstructions(root).errors.join('\n'),/Archive requires evidence/);
});
test('unregistered and duplicate rule headings fail', t => {
 const root = fixture(t), file = path.join(root,'docs/instructions/domain.md');
 fs.appendFileSync(file,'\n## RULE-02\n\n## RULE-01\n');
 assert.match(verifyInstructions(root).errors.join('\n'),/Unregistered Rule ID/);
 assert.match(verifyInstructions(root).errors.join('\n'),/Duplicate declared heading/);
});
test('declared source scopes catch missing adapters', t => {
 const root=fixture(t), file=path.join(root,'docs/instructions/inventory.json');
 const data=JSON.parse(fs.readFileSync(file));
 data.sourceScopes=[{repo:'project',path:'.claude/skills',filenames:['SKILL.md']}];
 fs.mkdirSync(path.join(root,'.claude/skills/new'),{recursive:true});
 fs.writeFileSync(path.join(root,'.claude/skills/new/SKILL.md'),'@../../../docs/instructions/domain.md\n');
 fs.writeFileSync(file,JSON.stringify(data));
 assert.match(verifyInstructions(root).errors.join('\n'),/Uninventoried source/);
});
test('archive cannot override an active normative link',t=>{
 const root=fixture(t), file=path.join(root,'docs/instructions/inventory.json');
 const data=JSON.parse(fs.readFileSync(file));
 data.files.push({repo:'project',path:'old.md',role:'historical',decision:'archived-historical',reason:'previous report',review:{activeConsumers:[],consumptionEvidence:'claimed no consumers'}});
 data.files.push({repo:'project',path:'entry.md',role:'entrypoint',decision:'non-normative',reason:'routing'});
 fs.writeFileSync(path.join(root,'old.md'),'Historical.\n');fs.writeFileSync(path.join(root,'entry.md'),'[Rules](old.md)\n');
 fs.writeFileSync(file,JSON.stringify(data));
 assert.match(verifyInstructions(root).errors.join('\n'),/Active instruction links archived source/);
});
test('non-markdown code files skip markdown link parsing', async t => {
 const {createHash} = await import('node:crypto');
 const root = fixture(t), file = path.join(root, 'docs/instructions/inventory.json');
 const data = JSON.parse(fs.readFileSync(file));
 const py = path.join(root, 'tool.py');
 fs.writeFileSync(py, 'PATTERN = r"[a-z](?=[a-z])"\n');
 data.files.push({repo:'project',path:'tool.py',role:'tool-procedure',decision:'non-normative',reason:'helper script',review:{sha256:createHash('sha256').update(fs.readFileSync(py)).digest('hex'),method:'test'}});
 fs.writeFileSync(file, JSON.stringify(data));
 assert.equal(verifyInstructions(root).ok, true);
});
test('hygiene guards reject duplicate .claude/skills files, new runtime AGENTS, new repair reviews, and missing worktree gitignore', t => {
 const root = fixture(t), file = path.join(root, 'docs/instructions/inventory.json');
 const data = JSON.parse(fs.readFileSync(file));
 data.hygieneGuards = {
  claudeSkillAdapterDirs: [{repo: 'project', path: '.claude/skills'}],
  forbidNewEntrypointsIn: [{repo: 'project', path: 'videos'}],
  forbidNewRepairReviewsIn: {repo: 'project', path: 'docs/reviews', grandfathered: ['2026-11-18-old-repair.md']},
  requireWorktreeGitignoreIn: ['project']
 };
 fs.writeFileSync(file, JSON.stringify(data));
 fs.writeFileSync(path.join(root, '.gitignore'), '.claude/worktrees/\n');
 fs.mkdirSync(path.join(root, '.claude/skills/demo'), {recursive: true});
 fs.writeFileSync(path.join(root, '.claude/skills/demo/SKILL.md'), 'adapter\n');
 fs.mkdirSync(path.join(root, 'docs/reviews'), {recursive: true});
 fs.writeFileSync(path.join(root, 'docs/reviews/2026-11-18-old-repair.md'), 'old\n');
 assert.equal(verifyInstructions(root).ok, true);

 fs.writeFileSync(path.join(root, '.claude/skills/demo/extra.py'), 'print(1)\n');
 fs.mkdirSync(path.join(root, 'videos/auto-new'), {recursive: true});
 fs.writeFileSync(path.join(root, 'videos/auto-new/AGENTS.md'), 'stray\n');
 fs.writeFileSync(path.join(root, 'docs/reviews/2026-11-27-new-repair.md'), 'new\n');
 fs.mkdirSync(path.join(root, '.claude/worktrees/agent-dead'), {recursive: true});
 const errs = verifyInstructions(root).errors.join('\n');
 assert.match(errs, /Duplicate non-adapter file in \.claude\/skills/);
 assert.match(errs, /Forbidden new runtime entrypoint/);
 assert.match(errs, /Forbidden new repair report in docs\/reviews/);
 assert.match(errs, /Stale \.claude\/worktrees directory present/);
});
