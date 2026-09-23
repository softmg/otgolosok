# Plan: triage workflow for `weak_identity` OSM places

Status: implemented 2026-09-23 in branch `main`. Production pilot not started (needs separate confirmation).

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Implementation result

Implemented as planned. Divergence found during local end-to-end verification: for area objects
(parks, manors) the stored coordinate is only a representative point, so a building or address
around it is no longer an anchor; `auto` for them requires a typed name, polygon and district.
Rules v1 on the production catalog snapshot: 526 auto, 2 894 enrich, 944 manual.
Details: `docs/agents/weak-identity-triage.md`.

## Context

Production (2026-09-23): 6 107 active OSM places, 1 743 pass `assessPlaceEligibility`
and have exactly one text job each. 4 364 places fail with `weak_identity`: they have
coordinates, a name and usually a type, but no postal address and no `wikidata`/`wikipedia`.
The global filter must stay as is. We need a separate, auditable way to pick the safest
of these places for a small paid pilot and to keep the rest visible for enrichment or
manual review.

Offline measurement on the production catalog snapshot (same 6 107 places) with the local
OSM address index (`backend/osm-geocoder.mjs`): 416 weak places have their coordinate inside
an addressed building, 922 on the edge of one (memorial plaques), 2 593 only nearby addresses
and a street, 298 nothing within 300 m. 889 weak places share their name with another place.

No external service is needed: the assessment uses catalog tags, name frequency and the
offline address index already deployed in production. The only paid step is the existing
content pipeline (web search + model) for pilot jobs, bounded by the pilot limit.

## Approved decisions

1. The eligibility filter (`backend/place-eligibility.mjs`) is not changed. The triage is a
   separate assessment stored in its own table with its own rules version.
2. Three tiers: `auto` (high confidence, may enter a pilot), `enrich` (plausible, but needs an
   address or external identifier first), `manual` (editor only). Every candidate stores tier,
   score 0–100, reason codes, signal codes, category and a location summary.
3. The assessment is offline and runs from a CLI script (≈5 s for 4 364 places — too long to
   block the HTTP server). The admin UI only reads it and starts pilots.
4. A pilot takes only `auto` candidates without an existing job, at most 50, spread across
   categories by score, and is created **paused**. Idempotency comes from `requestKey`,
   duplicate protection from the existing `content_jobs.input_key`.
5. Pilot jobs carry `identity_policy = 'weak_identity'`:
   - never auto-approved, even with `CONTENT_AUTO_APPROVE=true` (enforced in the store);
   - only facts about the object itself (`subjectRelation = object`) reach the writer;
   - an `identity` fact quote must name the object (token-stem match of an OSM name variant),
     otherwise `IDENTITY_UNCONFIRMED` → `review_required`.
6. `enrich` has no automatic path in this iteration. External enrichment (Wikidata search,
   data.mos.ru heritage registry, Nominatim) is described as options, not implemented.

## Key codebase facts

- `backend/content-store.mjs`: tables `places`, `content_batches`, `content_jobs`
  (`input_key` unique = sha256 of place id, content hash, profile, `CONTENT_PROFILE_VERSION`),
  `batch_items`; migrations are `CREATE TABLE IF NOT EXISTS` + `ALTER TABLE ADD COLUMN`
  guarded by `PRAGMA table_info`.
- `transaction()` in `backend/store.mjs` is `BEGIN IMMEDIATE` and does not nest.
- `backend/content-pipeline.mjs` `runContentJob` → `validateFacts` (quotes must exist in
  fetched pages) → `writeStory` → `completeContentJob(..., autoApprove)`.
- `scripts/create-osm-batch.mjs` already groups by `tourism:*`/`historic:*`/`leisure:*`.
- Admin API lives in `backend/server.mjs` under `/api/story-admin/content/*`, POST requires
  same-origin; UI in `src/features/admin/content-admin.tsx`.

## Implementation

1. `backend/identity-triage.mjs`: `IDENTITY_RULES_VERSION`, `identityNameKey`,
   `identityCategory`, `summarizeLocation`, `assessIdentityCandidate(place, {locationContext, nameCount})`,
   `restrictWeakIdentityEvidence(evidence, place)`.
2. `backend/content-store.mjs`: table `place_identity_candidates`; columns
   `content_batches.identity_policy`, `content_jobs.identity_policy`; `createBatch` accepts
   `identityPolicy`, stricter policy wins on a reused unfinished job; `claimContentJob` returns it;
   `completeContentJob` ignores `autoApprove` for weak jobs; `replaceIdentityCandidates`,
   `listIdentityCandidates`, `createIdentityPilot`.
3. `backend/content-pipeline.mjs`: apply `restrictWeakIdentityEvidence`; map
   `IDENTITY_UNCONFIRMED` to `review_required` with a Russian message.
4. `backend/server.mjs`: `GET /content/identity-candidates`, `POST /content/identity-candidates/pilot`.
5. `scripts/assess-identity-candidates.mjs` (`--dry-run` prints the summary only).
6. UI: `src/features/admin/identity-candidates.tsx` — tier counts, filters, table, pilot form.
   Batch rows mark weak-identity batches.
7. Docs: runbook section, `docs/agents/weak-identity-triage.md`.

## Testing & verification

Table-driven tests for tiers and name matching; store tests for idempotent assessment,
stale rows, pilot selection, idempotent `requestKey`, reuse of jobs, no auto-approval;
pipeline tests with a fake provider; server tests for validation and auth; UI tests.
Local end-to-end: import the production catalog snapshot into a temporary `DATA_DIR`,
run the assessment, open the admin UI, create a paused pilot. No paid model calls.

## Out of scope

- External enrichment sources and any change of `places.address`.
- Starting the pilot in production (needs separate confirmation).
- Changing the regular eligibility filter or the regular batch UI.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
