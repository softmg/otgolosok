# Plan: protect published ElevenLabs audio from implicit resynthesis

Status: implemented 2026-10-05 in branch `main`.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Changing `ELEVENLABS_MODEL` currently changes the external-audio input key. An ordinary enqueue can therefore schedule another paid synthesis for an unchanged, already published narration. The owner explicitly prohibited blanket resynthesis of existing ElevenLabs recordings and approved protection against this behavior. A deliberate request through the catalog's «Озвучить заново» button must remain possible, including with the same model.

There are two independent identities to address:

- Queue identity: `backend/store.mjs` includes the model in the profile hashed into `input_key`.
- Synthesis-cache identity: `backend/audio.mjs` hashes text, provider, model, voice and preparation versions. A new queue job alone does not ensure a new synthesis.

ElevenLabs uses `POST /v1/text-to-speech/{voiceId}?output_format=mp3_44100_128` through the configured `ELEVENLABS_BASE_URL` or the default API. Requests consume account credits; prices and balances are not assumed here. Audio tagging also calls an external text provider. All verification must use local fixtures or mocks, without account credentials or paid requests.

This is a repository implementation plan, not authorization to implement it, deploy it, modify production data, or run a synthesis batch.

## Approved decisions

1. Ordinary enqueue must not create another paid job when the currently published recording is ElevenLabs audio of the same narration with the same logical voice, regardless of the configured ElevenLabs model.
2. Deliberate new synthesis is allowed through the existing catalog action «Озвучить заново»; merely changing the model is not deliberate authorization.
3. Existing audio stays published until its replacement succeeds. A failed replacement must not remove it.
4. Existing ElevenLabs recordings must not be mass-revoiced. Cancelled bulk work must not be revived as part of this fix.
5. Proceed with the plan without further interview questions. Technical mechanisms below are implementation recommendations, not additional product decisions attributed to the owner.

## Key codebase facts

- `backend/store.mjs:584–618`, `enqueueExternalAudio({ sourceJobId, sourceRevision, story, profileId, signal })`, validates and prepares narration, hashes the profile including `configured.model`, revalidates catalog approval inside a transaction, sets `audio_target_profile`, and returns any row with the same `input_key` before inserting a queued job.
- Catalog sources have IDs `place-text:<UUID>` and use `sourceRevision: 0`. `approvedPlaceNarration` verifies the latest approved text for the place, not merely the existence of an older approved row.
- The queue payload already records `sourceTextHash`, `spokenTextHash`, `normalizerVersion` and `profile`. `profile.speaker` represents the requested logical voice.
- `backend/content-store.mjs:166–168`, `latestApprovedAudio`, selects the latest nonempty `audio_json` across a place's text rows. `getPlace` and `getPublishedPlace` use this fallback independently of the selected text row. Public catalog SQL also has approved-row audio predicates: recheck the relevant readers before choosing the protection query.
- `backend/content-store.mjs:630–642`, `approvePlaceText`, creates a new text row with no audio when an already approved title or narration changes. It cancels outstanding audio for superseded catalog text; the previous row's audio can remain publicly visible as fallback. Therefore visible audio must not automatically be treated as a recording of the latest text.
- `backend/store.mjs:740–765`, `acceptExternalAudio`, validates lease, source freshness and duration, records a successful receipt, and publishes catalog audio only when the target profile permits it. Generated-source publication increments the source revision and clears `data.revoice`.
- `audio_artifacts` is keyed by audio SHA-256 and uses `INSERT OR IGNORE`; its `job_id` alone is not authoritative provenance when several jobs produce identical bytes. Match the actual published artifact against successful receipts and payloads instead.
- `backend/speech-audio-worker.mjs` exports `ELEVENLABS_PROFILE_ID = "elevenlabs-v3"`; this historical ID must remain unchanged. `elevenLabsProfile(voice, model)` specifies `engine: "elevenlabs"`, `speaker`, `model` and a 300-second publication limit.
- The speech worker calls `createNarration` with the already prepared text and a passthrough normalizer, uses lease heartbeats, and reports errors through `failExternalAudio`. The runtime speech provider supplies the model; queue-profile/runtime-model compatibility is a separate pre-existing consideration, not permission to silently rewrite old jobs.
- `backend/audio.mjs:9–40`, `createNarration`, reuses validated metadata and MP3 bytes before calling `provider.speech`. It uses content-addressed MP3 filenames and atomic metadata publication. Cache keys without new options must stay backward-compatible.
- `backend/server.mjs:518` (approval) and `backend/content-pipeline.mjs:155` (automatic approval) call ordinary enqueue. `enqueueMissingPlaceAudio` also uses ordinary enqueue and can separately retry failed/cancelled jobs; do not execute that backfill during this task.
- `backend/server.mjs:521–529`, `POST /api/story-admin/content/places/{osmId}/audio`, is the endpoint for «Озвучить заново». It currently calls the same enqueue method without explicit intent. Existing same-origin, authentication, editorial-text and allowed-profile checks must remain intact.
- `backend/server.mjs:607–610`, the generated-job `/external-audio` route, is another ordinary enqueue caller. Do not reinterpret it as an explicit force action.
- `src/features/admin/content-admin.tsx:483–487` renders the catalog button and sends an optional `profileId`. Its existing action disables the button while processing or while edits are unsaved.
- `backend/speech-audio-worker.test.mjs:67–89` currently asserts that changing the model creates another job. This expectation must be replaced with protection coverage, not left as a contradictory test.
- `backend/audio.test.mjs` already tests provider/voice cache isolation, duration limits and prepared text. `backend/approved-place-audio.test.mjs` covers latest-approval validation and asynchronous preparation/editorial races.
- `backend/server.test.mjs:465–477` covers available audio profiles but not deliberate resynthesis or published-audio reuse. Existing client button tests are in `src/features/admin/content-admin.test.ts`.
- `package.json` defines `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:py`, `pnpm build` and aggregate `pnpm check`. Backend tests use `node --test backend/*.test.mjs`; frontend tests use Vitest.

## Implementation

### 0. Establish scope and reproduce the defect before changing implementation

Files: `backend/speech-audio-worker.test.mjs`, `backend/approved-place-audio.test.mjs`, `backend/audio.test.mjs`.

- Publish fixture v3 audio, reopen the same SQLite database with v4 configuration, and ordinary-enqueue the unchanged approved narration. Assert the original successful job is returned, queue cardinality does not increase, and the original recording remains published. The current implementation should fail this assertion.
- Add a same-model explicit-revoice fixture showing that the existing completed job and its ordinary cache must not satisfy a new deliberate action.
- Use distinct artifact hashes for replacements; identical-byte fixtures can hide erroneous publication and cache behavior.
- Inspect the current working tree; do not stage, overwrite or revert other agents' content, images or tests.

### 1. Resolve the published artifact and its trustworthy narration provenance

File: `backend/store.mjs`; keep helpers private unless an existing shared helper is appropriate.

For ElevenLabs ordinary enqueue only, resolve the artifact currently served for the source:

- Catalog: select the actual audio-bearing row for the place using the applicable published-read semantics, including its owning text ID and approved narration. Do not limit this lookup to the requested row's `audio_json`, because readers retain older audio as fallback.
- Generated job: inspect the current source's `data.audio`; do not treat arbitrary successful historical jobs or a backup field as the current publication. Validate source existence, revision and narration again at the transaction boundary.

A reusable publication requires all of the following:

1. A valid current artifact with ElevenLabs provider and the requested logical voice.
2. Proven narration equality using the raw approved paragraph text hash (`sourceTextHash`), not model, audio tags, normalized wording, title, or an unrelated historical text version.
3. A matching succeeded external-audio job whose receipt identifies this artifact and whose payload identifies this narration and ElevenLabs logical voice. For catalog fallback, restrict provenance to text rows of this same place; for generated sources, restrict it to this same source ID. Do not require an obsolete generated-source revision to equal the post-publication revision.

Return that real successful job through the existing `publicExternal` response shape. Do not manufacture a completed row, use `audio_artifacts.job_id` as the sole join, or mutate the successful receipt/model to the new configuration. If multiple successful receipts match the same artifact, choose deterministically; any returned job must satisfy the complete provenance checks.

When provenance is absent or contradictory, do not guess that a visible recording speaks the current text. A visible ElevenLabs artifact with the requested voice but insufficient provenance should produce a deterministic `CONFLICT` for ordinary enqueue rather than silently authorize an uncertain paid replacement; the editor can use the explicit action. Different-text or different-voice provenance is a known mismatch and must not block ordinary work. Document and test this conservative legacy-data boundary; do not backfill production provenance during implementation.

### 2. Separate ordinary enqueue from deliberate revoice inside one transaction

File: `backend/store.mjs`.

Extend the enqueue options with optional `revoiceRequestId?: string`. Absence means ordinary work. A valid UUID supplied by the explicit server action means deliberate ElevenLabs synthesis; reject malformed values and reject this option for other engines. Keep F5/Silero and other profile keys and behavior unchanged.

Processing order:

1. Preserve existing input validation and approved-narration validation before preparation.
2. Prepare the text as today; retain model in the actual synthesis profile and ordinary input-key recipe. Do not globally remove it from all queue keys.
3. Inside the existing transaction, revalidate source freshness and reread current publication/provenance. Both reuse and new insertion must pass the same freshness barrier.
4. Resolve explicit request replay by persisted `revoiceRequestId` and source/profile scope (catalog place across its text rows; generated source ID), independently of mutable model/configuration/preparation values; validate that the request still addresses the same narration and logical voice, otherwise return `CONFLICT`. A replay returns its original job, including terminal failed/cancelled/succeeded states, even after a configuration change; it must not create fresh synthesis or reset attempts. Only for a new explicit intent, compute a distinct versioned input key containing the preparation/profile identity and `revoiceRequestId`. Do not rely on that mutable-profile hash alone for request replay.
5. Do not permit two active ElevenLabs jobs for the same source/profile to race to publish under the same `audio_target_profile`. An explicit request with a different request ID while such a job is queued, retry-waiting or leased returns deterministic `CONFLICT`; it must not cancel that job. An ordinary request can return the compatible active job instead of inserting duplicate work. Compatibility includes current source narration and requested synthesis profile; incompatible active work is a conflict, not a silently relabelled job.
6. Without explicit intent, reuse a proven current publication across models. Perform no queue insert, retry reset, provider call or audio deletion. Preserve the existing target-profile selection semantics within the transaction, and test races against another profile's pending publication.
7. If no publication can be reused, retain ordinary exact-input-key idempotency and existing failed/cancelled behavior. Do not use an arbitrary historical succeeded row as a cross-model publication-reuse shortcut. This task does not redesign the pre-existing exact-input-key behavior for restoring historical audio.
8. Otherwise insert one queued job. For explicit work, store `revoiceRequestId` in `payload_json` together with a stable synthesis-cache identity derived from the new job ID. Keep old audio untouched.

Use existing JSON payload storage and `input_key` uniqueness; no new database table or migration is expected. Transactional active-job checks and input-key uniqueness provide atomicity across concurrent calls. If research during implementation proves additional persistence is essential, update this plan instead of silently introducing a second queue or undocumented schema.

`retryExternalAudio`, claim request idempotency, lease generation/expiry, upload replay protection and bounded retry must continue to operate on the same job and the same synthesis identity. Manual ElevenLabs retry also revalidates source freshness and checks for competing active work (catalog place/profile scope) and returns `CONFLICT` without reviving the terminal job when another job is active. No blanket cancellation, automatic retry of cancelled jobs, startup resynthesis sweep, new env flag or model downgrade is included.

### 3. Isolate deliberate synthesis from ordinary cache, while keeping retry reuse

Files: `backend/audio.mjs`, `backend/speech-audio-worker.mjs` and their tests.

- Extend `createNarration(..., options)` with optional `cacheNamespace?: string`, included in the metadata-cache key only when supplied. Validate it as a bounded nonempty identifier. Calls without it must keep their exact existing cache recipe and provider/voice isolation.
- The speech worker supplies this namespace only for an explicitly requested ElevenLabs job. Use the persisted job identity (for example `external-revoice:<jobId>`), never lease generation, attempt number, current time or a fresh random value per attempt.
- For an explicit job, cache lookup uses the persisted synthesis model and the fixed `external-revoice-v1` preparation identity; per-job namespaces isolate new intents even when the runtime tagger version changes. A completed cache remains reusable after the runtime model changes. If that cache is absent and the runtime model differs, fail deterministically with `TTS_MODEL_MISMATCH` before provider invocation; do not synthesize with one model and label it as another. Ordinary runtime-model compatibility remains outside this change.
- A new deliberate request gets a new namespace and cannot reuse another job's ordinary or deliberate metadata. Its retry gets the same namespace and can reuse a completely written, validated artifact after an upload/publication failure.
- MP3 filenames remain content-addressed. A fresh provider invocation can legitimately produce identical audio bytes; do not require a changed hash as proof of synthesis.
- Keep metadata atomic writes, byte-hash and duration checks, cleanup, cancellation, lease heartbeat and sanitized errors intact. Missing/corrupt cached bytes remain a cache miss; deterministic option errors should not become paid calls.
- Replace the obsolete worker comment claiming that a model change should revoice an already voiced text.

This is not a guarantee of exactly-once external billing: a process failure after a paid provider response but before a validated artifact is durably cached can still require another provider call on retry. Durable caching once synthesis completes mitigates the existing risk without adding an unrequested distributed payment protocol.

### 4. Connect only the existing explicit catalog action to new intent

Files: `backend/server.mjs`, `backend/server.test.mjs`, `src/features/admin/content-admin.tsx`, `src/features/admin/content-admin.test.ts`.

- For ElevenLabs on `POST /content/places/{osmId}/audio`, require a client-generated UUID `requestId` and pass it as `revoiceRequestId`. Preserve profile allowlisting, editorial-source checks, same-origin checks and body-size limits. Invalid or missing ElevenLabs request IDs return `BAD_REQUEST`, before enqueue or worker wake.
- The UI creates the UUID once per deliberate button action and sends `{ profileId, requestId }` for ElevenLabs. Any network retry of that action uses the same body/ID. A subsequent deliberate click after completion receives a new ID.
- Other profiles continue sending their existing body and using ordinary enqueue; do not silently change F5/Silero revoice/cache semantics.
- Approval, automatic approval, missing-audio backfill and generated-job `/external-audio` do not receive the explicit parameter. Unknown input fields must not offer a force bypass through an ordinary endpoint.
- Wake the ElevenLabs dispatcher only after a valid explicit/ordinary enqueue result as appropriate. Replays cannot create a second paid job.
- Keep the label «Озвучить заново». Show a Russian message explaining an active-work conflict rather than claiming that another replacement was queued. Preserve old published audio on every request failure.
- Before frontend changes, read the relevant installed Next.js guidance under `node_modules/next/dist/docs/`; do not use remembered framework APIs as authority.

### 5. Document behavior and finalize verification

Files: `README.md`, this plan.

- Update the ElevenLabs admin documentation in Russian: a model change alone does not replace existing matching published audio; the explicit action creates a new synthesis, including on the same model; retries reuse the same job/artifact; old audio stays available until success.
- Explain the conservative conflict for a matching legacy publication without reliable provenance and the editor's deliberate-action remedy. Do not suggest a paid catalog sweep as migration.
- Keep `elevenlabs-v3` as the compatibility profile ID and leave multi-key/account-copy routing unchanged.
- Update the plan's completion status only after implementation and verification.
- Run required checks before a scoped atomic commit. Do not commit on the default branch or create a branch when higher-priority/user permissions prohibit it; report a blocked commit rather than bypassing that boundary.

## Testing & verification

Required local tests, using fixtures/mocks only:

1. **Model transition:** v3 → v4 and v4 → v4 Turbo, unchanged published narration/voice: no new job, no speech invocation, same published artifact. Reopening the database must not change the outcome.
2. **Same model:** ordinary enqueue after publication reuses it; a new explicit UUID produces a distinct job and bypasses its cache. A second explicit UUID after completion produces another deliberate job.
3. **Provenance boundaries:** changed narration, changed voice, another provider, no audio, stale fallback audio, historical succeeded-but-not-published jobs, two jobs with identical MP3 bytes, and title-only editorial revision. Only proven same-narration/current-publication matches trigger cross-model reuse.
4. **Legacy ambiguity:** matching ElevenLabs provider/voice with missing or inconsistent provenance cannot silently create paid replacement; ordinary enqueue conflicts, explicit revoice remains available.
5. **Editorial concurrency:** source changes while normalization is pending; ordinary reuse and deliberate insertion reject the superseded source. A failed or superseded upload cannot replace published audio.
6. **Request concurrency:** replay of the same explicit UUID before/after completion and after model/configuration changes returns the same job; reuse of that UUID for a different narration or logical voice conflicts. Simultaneous distinct UUIDs cannot create competing active jobs; concurrent ordinary calls insert at most one job. Failed/cancelled request replay does not revive work.
7. **Retry/cache:** ordinary keys remain byte-for-byte compatible; namespaces isolate explicit requests; namespace remains stable across retries, leases and restart. A simulated publication failure after cache completion reuses the validated asset and does not repeat speech. Missing/corrupt cache still follows the tested failure path.
8. **Publication:** old audio remains served while replacement is queued, leased, retrying or failed; successful current replacement is served; target-profile protection remains effective. Verify both admin and public catalog readers.
9. **Generated sources:** ordinary cross-model reuse is revision-aware and publication-aware; stale source revisions are rejected. No generated-job API can accidentally opt into deliberate synthesis.
10. **Compatibility/security:** existing F5/Silero tests, claim/upload replay, auth/same-origin rejection, profile allowlist, request validation, provider/voice cache isolation and duration limits continue passing. No secrets appear in responses or logs.

Start with focused backend tests:

```sh
node --test backend/speech-audio-worker.test.mjs backend/approved-place-audio.test.mjs backend/audio.test.mjs backend/external-audio.test.mjs backend/server.test.mjs
```

Run the verified client test filename with Vitest, then `pnpm check` for the full lint/type-check/JS/Python/build gate. Report individual failures accurately; do not overwrite another agent's uncommitted tests to obtain a green result.

End-to-end verification: run the local admin/backend with an isolated SQLite fixture and fake speech provider. Publish v3 fixture audio, restart with v4, repeat approval and observe zero additional speech calls; click «Озвучить заново», verify one new job/provider invocation, verify old public audio until successful publication, then replay the request and observe no second job. Exercise an upload failure/retry to confirm durable-cache reuse. This verification must not use the production database, paid tagging, account credentials or a live ElevenLabs worker.

## Out of scope

- Implementing or deploying during the plan-writing phase.
- Any paid test, bulk revoice, cancelled-queue revival or change to the existing production queue.
- Deploying/configuring earlier multi-key or cloned-voice changes, recreating voice clones, changing balances or reading secrets.
- Changes to F5/Silero/OpenAI/Yandex behavior, walk chapter generation, existing provider retry policies or account failover.
- Redesigning catalog fallback audio, ordinary exact-input-key historical restoration, or queue/runtime-model migration.
- New monitoring, metrics, audit dashboards, generic idempotency infrastructure or distributed exactly-once billing.
- Editing unrelated content/images/tests, adding AGENTS.md gotchas without approval, or creating a branch without permission.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch \`feat/<name>\`.` If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.

## Implementation result (2026-10-05)

- Implemented in the current branch without a schema migration or production-data changes. Catalog UUID replay is scoped to the place/profile across text revisions; replay never changes a newer target profile.
- Manual ElevenLabs retry additionally rejects superseded sources and competing active jobs. Explicit cache lookup keeps the persisted model and a fixed tagging preparation identity; incompatible runtime-model cache misses fail terminally before a provider call.
- Regression tests reproduced the original cross-model duplicate and same-model explicit-cache defects before implementation. Independent review found and verified replay target races and retry boundaries; all blocking findings were resolved.
- Final `pnpm check` passed: 118 frontend test files / 1536 tests, 869 backend tests, 26 Python tests / 78 subtests, lint, formatting, both typechecks and production build. ESLint retains 75 existing warnings; scoped changed-file lint passed without errors.
- The local HTTP end-to-end test uses an isolated persisted SQLite database, fake PCM speech and the real encoder/cache. It verifies v3 publication, v4 ordinary approval without speech, explicit replacement, old public/admin audio during work/failure, v4 Turbo restart with changed tagger version and cached retry without additional speech, UUID replay, and fresh synthesis for another UUID.
- No paid calls, credential reads, deployment, bulk synthesis or cancelled-queue sweep were performed. Existing multi-key/account-copy routing and the historical profile ID remain unchanged.
