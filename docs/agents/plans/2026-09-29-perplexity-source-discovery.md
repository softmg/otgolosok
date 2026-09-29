# Plan: Perplexity source discovery for weak_identity places and drafts

Status: plan, 2026-09-29.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Places with weak identity (`identity_policy='weak_identity'`, tier `enrich`) often stop with
`INSUFFICIENT_EVIDENCE`/`IDENTITY_UNCONFIRMED` or produce thin drafts because the regular research step
(Codex model + `web_search`, `researchPrompt`) finds few pages about the object itself.

Probe of 2026-09-29 (see `docs/agents/weak-identity-triage.md`, "Варианты обогащения"): Perplexity Pro
(`perplexity-web/pplx-auto`) on 20 random `enrich` places without a job returned object-specific facts with
sources for 14 of 20 (Wikidata: ~3 %). But of 75 quotes it produced, only 54 were found verbatim on the page,
and at least one URL was mangled. Therefore **Perplexity is used only to discover URLs**; the existing pipeline
fetches every page itself and extracts facts with exact-quote validation. Perplexity's own answer text is ignored.

Production state on 2026-09-29: 338 drafts (unapproved `place_texts`), all weak_identity; 586 weak_identity jobs
queued. One Perplexity Pro account has ~190 Pro searches per month left; the connection is a browser session
cookie in OmniRoute and expired once on 2026-09-29 (401 → OmniRoute disabled the account → gateway returns
404 `model_not_found` "No active credentials for provider: perplexity-web" until the cookie is re-pasted).

External API (verified 2026-09-29 from the generator container):

- The generator's existing gateway `OPENAI_BASE_URL=https://airouter.softmg.tech/v1` with the existing
  `OPENAI_API_KEY` lists `perplexity-web/pplx-auto` in `/v1/models`.
- `POST {base}/chat/completions` with `{"model":"perplexity-web/pplx-auto","stream":false,"messages":[{"role":"user","content":…}]}`
  → 200 in ~5–30 s, body keys `id,object,created,model,choices,usage,citations,search_results`;
  `citations: string[]` (≈15), `search_results: [{title,url,snippet,date?}]`,
  `choices[0].message.annotations: [{type:"url_citation",url_citation:{url,title}}]`.
- `POST {base}/responses` with the same model returns `status:"completed"` but **no URLs** (no annotations, no
  `web_search_call`; URLs appear only as "Reading: …" in a reasoning summary). Do not use `/responses` for this.
- No per-request cost; the cost is the account quota.

## Approved decisions

1. Perplexity search runs for **every weak_identity job** at the research step (new jobs and the 586 already
   queued, as soon as it is deployed and enabled). Standard-policy jobs are not affected.
2. Results are **merged** with the regular Codex research: Perplexity URLs first, then Codex URLs, deduplicated,
   at most 8 sources in total. Both calls are made.
3. If Perplexity fails for a regular job (any non-2xx, timeout, network error, no URLs) the job **continues with
   the regular search only**; the failure code is recorded in the checkpoint and logged; the queue is **not**
   paused (Perplexity failures never map to `PROVIDER_OUTAGE_CODES`).
4. Editors can **re-research drafts** through Perplexity: a per-draft button and a bulk button with a number N
   (default 20, max 50) on the "Черновики" tab. Bulk takes the oldest drafts not yet re-researched with Perplexity.
5. A successful re-research **replaces** the unapproved draft (story + evidence). If the new run fails, the old
   draft stays unchanged. Approved texts are never touched.
6. For draft re-research, if Perplexity is unavailable the job **stops** with `PERPLEXITY_UNAVAILABLE` (no
   fallback to the regular search, which produced the current draft); the draft is unchanged; the editor can
   retry later.
7. Pilot after deploy: a batch of 30 random `enrich` places without a job, prioritised above the queue, compared
   with pilot `ac2a4c4d` (17 of 30 ready).
8. The feature is switched by one env var; empty = disabled (current behaviour).

## Key codebase facts

- `backend/provider.mjs`: `createProvider({baseUrl, apiKey, model, writerModel, …, fetchImpl})` returns
  `{response, speech, …}`. `response()` posts to `${endpoint}/responses`; `providerFetch` wraps
  `fetchWithRetry` (`backend/retry.mjs`) with `RETRY={attempts:3,baseMs:1000,maxMs:10000}`;
  `providerStatusCode(status)` maps 429/401/403/5xx/other; `boundedBody(res, max, signal)` limits body size.
  `PROVIDER_OUTAGE_CODES` pauses the whole content worker (`startContentWorker`, `backend/content-pipeline.mjs`).
- `backend/server.mjs:625` builds the provider from `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `STORY_MODEL`,
  `WRITER_MODEL`; `backend/prepare.mjs:13` does the same for the CLI. `compose.yaml:31` passes `STORY_MODEL`
  to the generator; `.env.example` documents env vars.
- `backend/content-pipeline.mjs`, `runContentJob(job,{store,provider,fetchPage,resolveLocation,signal,timeoutMs,autoApprove})`:
  - research: `if(!checkpoint.research&&!checkpoint.sources){ research=await call(researchPrompt(address,context),{search:true,…}); sources=sourcesFrom(research); if(!sources.length&&!openSources.length) throw failure("INSUFFICIENT_EVIDENCE"); save({research:{sources}}) }`;
  - `sourcesFrom(result)` takes at most 5 URLs, validates them with `validateSourceUrl` (`backend/safe-fetch.mjs`), dedupes;
  - fetch: each `checkpoint.research.sources[i]` → `fetchPage` → `sourceText`, ids `s1…`; open-data records (`d1…`) go first;
  - facts: `validateFacts` + `restrictWeakIdentityEvidence` for weak_identity;
  - on error: `store.failContentJob(job.id,{code,message},state,{countAttempt:!PROVIDER_OUTAGE_CODES.has(code)})`;
    state is `insufficient_evidence`, `review_required` (identity codes) or `failed`.
  - `CONTENT_FAILURES` holds Russian editor messages for pipeline-only codes.
- `backend/content-store.mjs`:
  - `DRAFT_PLACE` (line ~66): a place with a `place_texts` row and none with `approved_story_json`.
  - `listDrafts({limit,offset})` (~382) returns the latest text per draft place, newest first.
  - `insertBatch(...)` (~128) links existing jobs to a new batch **without** re-queuing them (a `ready` job stays
    `ready`); `claimContentJob` (~432) only claims jobs that have a `queued`/`retry_wait` `batch_items` row in a
    `running` batch, ordered by `priority DESC, created_at`.
  - `retryBatchItem(batchId,placeId,{restartFrom})` (~426) re-queues only non-ready items.
  - `completeContentJob(id,{story,evidence,…})` (~437): if a `place_texts` row with the same `input_key` already
    exists, it **keeps the existing text** and just marks the job ready. Re-research therefore needs an explicit
    replace path.
  - `setBatchPriority(id,priority)` (~412), 0–1000.
- Admin API lives in `backend/server.mjs` under `/api/story-admin/content/…` with same-origin + CSRF checks
  (`GET …/content/drafts` at ~316; batch routes ~337–380).
- Admin UI: `src/features/admin/drafts-admin.tsx` (row buttons "Копировать", "Открыть", pagination),
  tests in `drafts-admin.test.ts`; batch item details in `batch-item-detail.tsx`; shared types in `model.ts`.
- Error-handling and retry rules: see AGENTS.md (bounded backoff for transient errors, none for 4xx).

## Implementation

### 0. Re-verify

Re-check the facts above (line numbers drift). Confirm with one manual request from the generator container that
`/chat/completions` still returns `citations`/`search_results` for `perplexity-web/pplx-auto`.

### 1. Provider: `searchSources`

`backend/provider.mjs`:

- `createProvider({…, searchModel = null})`; expose `searchModel` and `searchSources` only when `searchModel`
  is a non-empty string (otherwise `searchSources` is `null`).
- `async searchSources(prompt, {signal, timeoutMs = 120000}) → {sources: [{url,title}], model}`:
  - `POST ${endpoint}/chat/completions`, body `{model: searchModel, stream: false, messages:[{role:"user",content:prompt}]}`.
  - Retry: at most 2 attempts for transient errors (network, 5xx, 429) via `fetchWithRetry`; no retry for 4xx.
  - Non-OK → `failure(providerStatusCode(status))` (404 "no active credentials" becomes `PROVIDER_REJECTED`).
  - Body via `boundedBody(res, 2_000_000, deadline)`, JSON parse failure → `INVALID_MODEL_OUTPUT`.
  - URLs, in this order, deduped: `search_results[].url` (with `title`), `choices[0].message.annotations[].url_citation.{url,title}`,
    `citations[]`. Keep only strings; titles clipped to 250. Validation of URLs is the caller's job.
  - No URLs → `failure("NO_SEARCH_EVIDENCE")`.
  - Never log the prompt, key or raw body.
- `backend/server.mjs` and `backend/prepare.mjs`: pass `searchModel: process.env.RESEARCH_SEARCH_MODEL || null`.
- `compose.yaml`: `RESEARCH_SEARCH_MODEL: ${RESEARCH_SEARCH_MODEL:-}`; `.env.example`: commented entry
  (`perplexity-web/pplx-auto`; empty disables; weak_identity only; quota ~190/month per account).
- README (Russian): one line next to `STORY_MODEL`/`WRITER_MODEL`.

### 2. Prompt

`backend/prompts.mjs`: `searchSourcesPrompt(placeContext)` in Russian (Perplexity answers better in Russian for
Moscow objects): OSM name, relevant tags (drop `source*`, `check_date`), coordinates (6 decimals), nearest address
and district from `locationContext`, the instruction to find pages about *this* object at *this* location, not
namesakes, and to prefer official/heritage/museum pages. Ask for a short plain-text answer; the answer is not
used. Place data is marked as data, never instructions (same convention as `researchPrompt`).

### 3. Pipeline: merged research

`backend/content-pipeline.mjs`:

- In the research branch, when `job.identityPolicy === "weak_identity"` and `provider.searchSources`:
  1. call `searchSources(searchSourcesPrompt(context), {signal: deadline})`; count its URLs through the same
     `validateSourceUrl`/dedupe as `sourcesFrom` (refactor `sourcesFrom` into a helper that takes a URL list and a
     limit), take at most 5, tag each `{origin:"perplexity"}`;
  2. on any error: record the code, do **not** rethrow (except in the required mode, step 5), report it via the
     new `onSearchFailure(code)` option;
  3. run the regular Codex research exactly as today; tag its sources `{origin:"search"}`;
  4. merge: Perplexity first, then Codex, dedupe by normalised URL, cap 8. `INSUFFICIENT_EVIDENCE` only if the merged
     list and open data are both empty;
  5. `checkpoint.research = {sources, perplexity: {status:"ok"|"failed", code?, count, model}}`.
- Required mode: if `checkpoint.researchMode === "perplexity_required"` (set by draft re-research, step 4) and
  Perplexity fails or `searchSources` is null → throw `failure("PERPLEXITY_UNAVAILABLE")` before the Codex call.
  Add to `CONTENT_FAILURES`: «Perplexity недоступен: вероятно, истекла сессия или закончилась квота. Черновик не
  изменён, повторите позже.» Map it to state `failed`; it must not be in `PROVIDER_OUTAGE_CODES`. Check
  `failContentJob`: this code must not be auto-retried (use the terminal path or set attempts to max) so that an
  expired cookie does not burn retries.
- `startContentWorker`: pass `onSearchFailure` that `console.warn`s the code for every failure and sends
  `options.logs?.captureMessage("Perplexity search unavailable","warn",{operation:"contentWorker",context:{code}})`
  at most once per 30 minutes (closure timestamp).
- Completion: pass `replaceDraft: checkpoint.researchMode === "perplexity_required"` to `completeContentJob`.

### 4. Store: draft re-research and replace

`backend/content-store.mjs`:

- `completeContentJob(id, {…, replaceDraft=false})`: when an existing `place_texts` row has the same `input_key`,
  `replaceDraft` is true and `approved_story_json IS NULL`, update that row in the same transaction:
  `story_json`, `evidence_json`, `content_hash`, `verification`, `created_at = now` (so the draft moves to the top
  of the list). If it was approved in the meantime, keep it untouched and record nothing else. Audio fields are
  not touched (weak_identity texts have no auto audio).
- `researchDrafts({requestKey, placeIds = null, limit = 20})` in one transaction:
  - validation: `limit` integer 1–50; `placeIds` 1–50 valid OSM ids, or null; otherwise `BAD_REQUEST`;
  - candidates: draft places (`DRAFT_PLACE`, not archived) whose job for `story-v1` is `ready`, whose latest
    checkpoint has no `research.perplexity.status = 'ok'` (`json_extract`), ordered by the latest text's
    `created_at ASC` (oldest first). With `placeIds`, only those places, and the "already processed" filter does
    not apply (an explicit per-draft click may repeat);
  - none → `NO_DRAFTS_TO_RESEARCH`;
  - create a `running` batch "Perplexity · черновики · <date>" (`identity_policy='weak_identity'`, text-only,
    priority 10) and for every job: `state='queued'`, `attempts=0`, `error_json=NULL`,
    `checkpoint_json = {locationContext (kept), researchMode:"perplexity_required"}`, `batch_items` row `queued`;
  - repeated `requestKey` returns the first batch (same as other batch creators);
  - returns `{batch, count}`.
- `listDrafts` also returns `researchAvailable` (passed in from the server, see step 5) and `unresearched`
  (count of drafts that the bulk action would pick).

### 5. Server

`backend/server.mjs`:

- `POST /api/story-admin/content/drafts/research`, body `{requestKey, limit}` or `{requestKey, placeIds:[id]}`;
  same auth, same-origin and CSRF checks as other content POSTs; `provider?.searchSources` null → 409
  `SEARCH_DISABLED`; store errors map as elsewhere (`BAD_REQUEST` 400, `NO_DRAFTS_TO_RESEARCH` 409).
- `GET …/content/drafts` adds `researchAvailable: Boolean(provider?.searchSources)`.

### 6. Admin UI (Russian text)

- `src/features/admin/model.ts`: types for the new fields and response.
- `drafts-admin.tsx`:
  - toolbar: number input «Сколько черновиков» (1–50, default 20) and button «Переисследовать через Perplexity»;
    caption «Ещё не проверено через Perplexity: N»; hidden with an explanation when `researchAvailable` is false;
  - per row: button «Переисследовать» (aria-label «Переисследовать черновик: <name>»);
  - after success: status line «Поставлено в очередь: N. Партия «…»» and a reload; errors through the existing
    status mechanism.
- `batch-item-detail.tsx`: show the Perplexity status of the job (`найдено N ссылок` / `недоступен (код)`) and mark
  sources with `origin:"perplexity"` as «найдено Perplexity». This needs the store's item-detail view to expose
  `research.perplexity` and the source origin.

### 7. Deploy and pilot

Follow `docs/production-deployment.md`, `docs/agents/production-deploy-concurrency.md` and the memory notes about
background deploys and parallel agents. Then:

1. Set `RESEARCH_SEARCH_MODEL=perplexity-web/pplx-auto` in production env and restart the generator.
2. Create the pilot through the existing batch API: 30 random `enrich` places without a job and without open data,
   `identityPolicy:"weak_identity"`, then `setBatchPriority` 20 so it runs before the 586 queued jobs.
3. After it finishes, report: ready / review_required / insufficient_evidence, Perplexity `ok`/`failed` counts,
   how many `ready` texts cite at least one `origin:"perplexity"` source; compare with `ac2a4c4d` (17/30).
   Record the result in `docs/agents/weak-identity-triage.md`.

## Testing & verification

Never call Perplexity or any paid API from tests; use `fetchImpl` / provider stubs.

- `backend/provider.test.mjs` (table-driven): URLs from `search_results`, annotations and `citations` merged in
  order and deduped; non-string entries dropped; 401/403/404/429/500 → expected codes; 5xx retried once, 404 not
  retried; empty URL list → `NO_SEARCH_EVIDENCE`; malformed JSON → `INVALID_MODEL_OUTPUT`; `searchModel` empty →
  `searchSources` is null.
- `backend/content-pipeline.test.mjs`:
  - weak_identity + enabled: Perplexity URLs first, Codex after, dedupe, cap 8; `checkpoint.research.perplexity.status="ok"`;
  - Perplexity failure → Codex-only sources, `status:"failed"` with code, job not paused (result code not in outage set), `onSearchFailure` called;
  - standard job and disabled search → `searchSources` not called;
  - `perplexity_required` + failure → `PERPLEXITY_UNAVAILABLE`, Codex not called, existing `place_texts` unchanged;
  - `perplexity_required` + success → the draft row is replaced; approved row is never replaced.
- `backend/content-store.test.mjs`: `researchDrafts` selection (skips approved, not-ready jobs, already processed;
  oldest first; limit bounds 0/1/50/51; unknown/invalid `placeIds`; explicit `placeIds` repeats a processed draft;
  idempotent `requestKey`; `NO_DRAFTS_TO_RESEARCH`); `completeContentJob` replace/no-replace table.
- `backend/server.test.mjs`: new route without CSRF → rejected; bad body → 400; disabled search → 409
  `SEARCH_DISABLED`; drafts response has `researchAvailable` and `unresearched`.
- `src/features/admin/drafts-admin.test.ts`: bulk button sends `limit`, row button sends one `placeIds`, hidden when
  unavailable, error message shown.
- Run `npm run check` (lint, types, tests) before each commit.
- End-to-end: local server with a stub provider, browser check of the drafts tab (both buttons, status, caption)
  and of batch item details; in production, the pilot in step 7.

## Out of scope

- Using Perplexity's answer text or its quotes as evidence.
- `pplx-deep-research`, Perplexity for standard-policy jobs, a quota dashboard/limits card in OmniRoute, several
  Perplexity accounts, automatic cookie refresh.
- Storing several draft versions or showing a diff between old and new drafts.
- Changes in OmniRoute or the AI Router gateway (e.g. making `/responses` return Perplexity citations).

## Risks

- **Quota.** With all weak_identity jobs enabled, ~190 Pro searches will be spent on the first ~190 jobs of the
  586-job queue within hours; later jobs silently fall back to the regular search. The pilot must be prioritised
  before enabling, or the env var set only after the pilot batch is created with higher priority.
- **Session expiry.** The cookie-based connection expired once on 2026-09-29. Regular jobs degrade silently to the
  old behaviour; only the logs and the per-item Perplexity status show it.
- **Terms of use.** `perplexity-web` automates a consumer web session, not the official Perplexity API. This is the
  owner's decision; the official Sonar API is the compliant alternative if the integration proves useful.
- **Editor concurrency.** A draft may be replaced while an editor has it open; approving then saves what the editor
  sees. Acceptable: approval is an explicit choice of the shown text.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
