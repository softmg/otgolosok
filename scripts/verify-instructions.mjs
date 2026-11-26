import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

export function verifyInstructions(root = path.resolve(import.meta.dirname, '..')) {
  const inventory = JSON.parse(fs.readFileSync(path.join(root, 'docs/instructions/inventory.json'), 'utf8'));
  const errors = [], ids = new Set();
  const adapterEdges = new Map();
  const decisions = new Set(['pending-line-review', 'migrated', 'deduplicated', 'retained-procedure', 'archived-historical', 'non-normative', 'protected-read-only', 'new-domain']);
  const roles = new Set(['canonical', 'adapter', 'entrypoint', 'historical', 'tool-procedure', 'runtime-consumer', 'reference', 'protected']);
  const candidateDecisions = new Set(['migrated', 'deduplicated', 'retained-procedure', 'archived-historical', 'non-normative', 'protected-read-only']);
  const canonical = new Map(inventory.files.filter(e => e.role === 'canonical').map(e => [`${e.repo}/${e.path}`, e]));
  const sources = new Set();
  let pendingCandidates = 0;
  function targetDecision(record, label) {
    if (!record.owner || !record.migrationTarget) {
      errors.push(`Incomplete migration decision: ${label}`);
      return;
    }
    const [target, anchor] = record.migrationTarget.split('#');
    const domain = canonical.get(target);
    const ruleId = record.ruleId || (anchor && anchor.toUpperCase());
    if (!domain || domain.owner !== record.owner || !domain.ruleIds?.includes(ruleId) ||
        (anchor && anchor !== ruleId?.toLowerCase()))
      errors.push(`Invalid migration target/owner/Rule ID: ${label}`);
  }
  for (const entry of inventory.files) {
    const label = `${entry.repo}/${entry.path}`;
    if (sources.has(label)) errors.push(`Duplicate source: ${label}`);
    sources.add(label);
    if (!roles.has(entry.role)) errors.push(`Unknown role: ${label}`);
    if (!decisions.has(entry.decision)) errors.push(`Unknown decision: ${label}`);
    const file = path.resolve(root, '..', entry.repo || '', entry.path || '');
    if (!fs.existsSync(file)) errors.push(`Missing inventoried source: ${label}`);
    if (['migrated', 'deduplicated'].includes(entry.decision)) targetDecision(entry, label);
    if (['archived-historical', 'non-normative', 'retained-procedure'].includes(entry.decision) && !entry.reason?.trim())
      errors.push(`Missing decision reason: ${label}`);
    if (entry.decision === 'archived-historical' && (!entry.review?.consumptionEvidence?.trim() || entry.review?.activeConsumers?.length !== 0))
      errors.push(`Archive requires evidence of no active normative consumers: ${label}`);
    if (entry.review) {
      const actual = fs.existsSync(file) && fs.statSync(file).isFile()
        ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
      if (entry.review.sha256 !== actual) errors.push(`Stale review hash: ${label}`);
      if (!entry.review.method?.trim()) errors.push(`Missing review method: ${label}`);
    } else if (['migrated', 'deduplicated', 'archived-historical', 'non-normative', 'retained-procedure'].includes(entry.decision)) {
      errors.push(`Missing review evidence: ${label}`);
    }
    for (const candidate of entry.normativeCandidates ?? []) {
      const at = `${label}:${candidate.line}`;
      if (candidate.decision === 'pending-semantic-review') { pendingCandidates++; continue; }
      if (!candidateDecisions.has(candidate.decision)) errors.push(`Unknown candidate decision: ${at}`);
      if (['migrated', 'deduplicated'].includes(candidate.decision)) targetDecision(candidate, at);
      else if (!candidate.reason?.trim()) errors.push(`Missing candidate reason: ${at}`);
    }
  }
  if (pendingCandidates) errors.push(`Semantic migration incomplete: ${pendingCandidates} candidates pending`);
  // Explicit scopes are coverage declarations, never a claim of semantic review.
  for (const scope of inventory.sourceScopes ?? []) {
    const directory = path.resolve(root, '..', scope.repo, scope.path);
    function scan(dir) {
      if (!fs.existsSync(dir)) { errors.push(`Missing source scope: ${dir}`); return; }
      for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        if (item.isSymbolicLink()) continue;
        const file = path.join(dir, item.name);
        if (item.isDirectory()) scan(file);
        else if (scope.filenames.includes(item.name)) {
          const key = `${scope.repo}/${path.relative(path.resolve(root, '..', scope.repo), file).split(path.sep).join('/')}`;
          if (!sources.has(key)) errors.push(`Uninventoried source: ${key}`);
        }
      }
    }
    scan(directory);
  }
  for (const entry of inventory.files.filter(entry => ['adapter', 'entrypoint', 'reference', 'tool-procedure'].includes(entry.role) && !['pending-line-review', 'archived-historical', 'protected-read-only'].includes(entry.decision))) {
    const file = path.resolve(root, '..', entry.repo, entry.path);
    if (!fs.existsSync(file)) { errors.push(`Missing entrypoint: ${file}`); continue; }
    if (!['.md', '.txt'].includes(path.extname(file).toLowerCase())) continue;
    const body = fs.readFileSync(file, 'utf8');
    const targets = [...body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    targets.push(...[...body.matchAll(/^@([^\s]+)$/gm)].map(m => m[1]));
    const edges = [];
    for (const target of targets) {
      if (/^[a-z]+:/i.test(target)) continue;
      const destination = path.resolve(path.dirname(file), target.split('#')[0]);
      if (!fs.existsSync(destination)) errors.push(`Broken entrypoint link: ${file} -> ${target}`);
      else {
        edges.push(destination);
        const archived = inventory.files.find(e => e.decision === 'archived-historical' &&
          path.resolve(root, '..', e.repo, e.path) === destination);
        if (archived) errors.push(`Active instruction links archived source: ${file} -> ${target}`);
        const anchor = target.split('#')[1];
        if (anchor && fs.statSync(destination).isFile()) {
          const headings = [...fs.readFileSync(destination, 'utf8').matchAll(/^#+ (.+)$/gm)]
            .map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
          if (!headings.includes(anchor)) errors.push(`Broken anchor: ${file} -> ${target}`);
        }
      }
    }
    if (entry.role === 'adapter') {
      if (edges.length !== 1) errors.push(`Adapter must have one canonical target: ${file}`);
      if (body.length > 1800) errors.push(`Adapter contains copied procedure: ${file}`);
    }
    adapterEdges.set(file, edges);
  }
  const active = new Set(), visited = new Set();
  function visit(file) {
    if (active.has(file)) { errors.push(`Adapter/import cycle: ${file}`); return; }
    if (visited.has(file)) return;
    active.add(file);
    for (const edge of adapterEdges.get(file) ?? []) if (adapterEdges.has(edge)) visit(edge);
    active.delete(file); visited.add(file);
  }
  for (const file of adapterEdges.keys()) visit(file);
  // Production inventory declares the required sibling layout; fixtures need not.
  for (const repo of inventory.requiredCheckouts ?? []) {
    const directory = path.resolve(root, '..', repo);
    if (!fs.existsSync(path.join(directory, 'AGENTS.md'))) errors.push(`Missing sibling checkout: ${repo}`);
  }
  for (const entry of inventory.files.filter(entry => entry.role === 'canonical')) {
    const file = path.resolve(root, '..', entry.repo, entry.path);
    if (!fs.existsSync(file)) { errors.push(`Missing canonical: ${file}`); continue; }
    const text = fs.readFileSync(file, 'utf8');
    if (!entry.owner) errors.push(`Missing owner: ${file}`);
    for (const heading of ['Владеет', 'Не владеет', 'Ссылки на смежные домены']) {
      if (!text.includes(`## ${heading}\n`)) errors.push(`Missing boundary ${heading}: ${file}`);
    }
    const actualIds = [...text.matchAll(/^## ([A-Z]+-\d+)$/gm)].map(m => m[1]);
    if (new Set(actualIds).size !== actualIds.length) errors.push(`Duplicate declared heading: ${file}`);
    for (const id of actualIds) if (!entry.ruleIds.includes(id)) errors.push(`Unregistered Rule ID: ${id}`);
    for (const id of entry.ruleIds) {
      if (ids.has(id)) errors.push(`Duplicate rule: ${id}`);
      ids.add(id);
      if (!text.includes(`## ${id}\n`)) errors.push(`Missing rule: ${id}`);
    }
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const target = match[1];
      if (/^[a-z]+:/i.test(target)) continue;
      const [link, anchor] = target.split('#');
      const destination = link ? path.resolve(path.dirname(file), decodeURI(link)) : file;
      if (!fs.existsSync(destination)) { errors.push(`Broken link: ${file} -> ${target}`); continue; }
      if (anchor) {
        const body = fs.readFileSync(destination, 'utf8');
        const headings = [...body.matchAll(/^#+ (.+)$/gm)].map(m => m[1].toLowerCase().replace(/[^\p{L}\p{N} _-]/gu, '').replace(/ /g, '-'));
        if (!headings.includes(anchor)) errors.push(`Broken anchor: ${file} -> ${target}`);
      }
    }
  }
  // Anti-proliferation guards: prevent duplicate skill trees, stray runtime AGENTS/CLAUDE, new repair logs, and stale worktrees.
  const guards = inventory.hygieneGuards ?? {};
  for (const dirSpec of guards.claudeSkillAdapterDirs ?? []) {
    const base = path.resolve(root, '..', dirSpec.repo, dirSpec.path);
    if (!fs.existsSync(base)) continue;
    function scanSkillAdapter(dir) {
      for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        if (item.isSymbolicLink() || item.name === '.DS_Store' || item.name.endsWith('-workspace')) continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) scanSkillAdapter(full);
        else if (item.name !== 'SKILL.md') {
          errors.push(`Duplicate non-adapter file in .claude/skills: ${dirSpec.repo}/${path.relative(path.resolve(root, '..', dirSpec.repo), full).split(path.sep).join('/')}`);
        }
      }
    }
    scanSkillAdapter(base);
  }
  for (const dirSpec of guards.forbidNewEntrypointsIn ?? []) {
    const base = path.resolve(root, '..', dirSpec.repo, dirSpec.path);
    if (!fs.existsSync(base)) continue;
    function scanEntrypoints(dir, depth) {
      if (depth > 5) return;
      for (const item of fs.readdirSync(dir, {withFileTypes: true})) {
        if (item.isSymbolicLink() || item.name === 'node_modules' || item.name === '.hyperframes') continue;
        const full = path.join(dir, item.name);
        if (item.isDirectory()) scanEntrypoints(full, depth + 1);
        else if (item.name === 'AGENTS.md' || item.name === 'CLAUDE.md') {
          const key = `${dirSpec.repo}/${path.relative(path.resolve(root, '..', dirSpec.repo), full).split(path.sep).join('/')}`;
          if (!sources.has(key)) errors.push(`Forbidden new runtime entrypoint: ${key}`);
        }
      }
    }
    scanEntrypoints(base, 0);
  }
  if (guards.forbidNewRepairReviewsIn) {
    const spec = guards.forbidNewRepairReviewsIn;
    const base = path.resolve(root, '..', spec.repo, spec.path);
    const allowed = new Set(spec.grandfathered ?? []);
    if (fs.existsSync(base)) {
      for (const item of fs.readdirSync(base, {withFileTypes: true})) {
        if (!item.isFile()) continue;
        if ((item.name.endsWith('-repair.md') || item.name.includes('-attempt-')) && !allowed.has(item.name)) {
          errors.push(`Forbidden new repair report in docs/reviews: ${spec.repo}/${spec.path}/${item.name}`);
        }
      }
    }
  }
  for (const repo of guards.requireWorktreeGitignoreIn ?? []) {
    const repoDir = path.resolve(root, '..', repo);
    const gi = path.join(repoDir, '.gitignore');
    if (!fs.existsSync(gi) || !fs.readFileSync(gi, 'utf8').includes('.claude/worktrees/')) {
      errors.push(`Missing .claude/worktrees/ in .gitignore: ${repo}`);
    }
    const wt = path.join(repoDir, '.claude/worktrees');
    if (fs.existsSync(wt) && fs.readdirSync(wt).some(name => !name.startsWith('.'))) {
      errors.push(`Stale .claude/worktrees directory present: ${repo}/.claude/worktrees`);
    }
  }
  // Pending migrations are deliberately a failure, never a clean SSOT declaration.
  const pending = inventory.files.filter(entry => entry.decision === 'pending-line-review');
  if (pending.length) errors.push(`Semantic migration incomplete: ${pending.length} sources pending`);
  return {ok: errors.length === 0, canonicalRules: ids.size, errors};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = verifyInstructions();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
