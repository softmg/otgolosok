# Opt-In Walk Research

This flow does not change `/api/walk-plan`. No research or allocation occurs until
an explicit same-origin POST with `consent: true`. The consent covers external
building discovery, evidence research, routing, writing and automatic narration.

## HTTP Contract

- `POST /api/walk-research-jobs`: `{start:{address,location:{lat,lon}},mode:'loop'|'open',minutes:30|60|90,consent:true,recoveryToken:UUID}`.
- `GET /api/walk-research-jobs?lat=55.75&lon=37.61&mode=loop&minutes=30&recoveryToken=UUID`: read-only recovery after an uncertain POST.
- `GET /api/walk-research-jobs/:uuid`: read-only polling.
- `POST /api/walk-research-jobs/:uuid/retry`: `{revision}`. Explicit optimistic-concurrency retry, not an implicit restart on GET or repeated create.

Successful responses are unwrapped objects:

```text
{id,stage,revision,request:{start,mode,minutes},
 phase:'discovery'|'research'|'routing'|'narration'|'complete',
 progress:{checked,total,accepted},route:Plan|null,
 stories:[{place:Place,id,stage}],error:{code,message}|null,canRetry}
```

Stages are the existing generation stages. A lookup miss is HTTP 404 with
`error.code = NOT_FOUND`, not `null`. Validation failures are 400, origin failures
403, quota failures 429, revision/retry conflicts 409. New work and retries need
a configured research provider (503 otherwise); existing jobs remain readable.

Coordinates are normalized to **six decimal places**, identically for create and
lookup. The versioned deterministic key includes coordinates, mode and minutes,
**not the address label or recovery token**. The stored and public start label is
always `Начало прогулки`; the frontend retains its original label locally. There is no
address query parameter. Identical requests always return the same persisted job,
including terminal results; change the start, mode or duration to request a new
walk. `total` is zero during discovery, then the selected candidate count (0-3).
`checked` counts candidates reaching a research outcome; `accepted` counts those
with validated evidence or an existing approved story. Stories appear only after
successful publication and reference actual `/api/story-jobs/:uuid` resources.

The client must generate and persist a random UUID recovery token before its first
POST (for example `crypto.randomUUID()`) and reuse it after uncertain delivery.
Missing or malformed tokens are 400. Lookup requires both a registered token and
matching normalized coordinates/mode/duration; an unregistered token returns 404.
POST transactionally grants each token access to the shared deduplicated job,
including cache hits with no quota or provider work. Grants store token hashes,
not raw tokens, survive restart, and never appear in public responses. GET by job
ID remains a random-UUID capability and requires no additional token. Backend code
does not log tokens. Deployment access logs must redact query strings or disable
logging for this endpoint because the recovery token is a query-string capability.

## Persistence And Budget

`walk_research` parents share SQLite and the sequential worker but are excluded
from address/admin APIs and the audio-only worker. Candidate pipeline updates are
persisted through a checkpoint proxy into the parent; no queued child is awaited.
Research-only execution stops after the existing strict evidence validator and
uses the existing safe source fetcher. Only routed stops enter writing and speech.

Creation transactionally reserves three work units: one parent row and two ledger
entries. Every explicit retry conservatively reserves another three ledger units,
even when only audio remains. The shared default daily budget remains six. Ready
address publications are quota-exempt because the parent already reserved their
work. They never overwrite an existing user job or an irrelevant record. An
existing ready address is reused; otherwise publication uses the normal address
key when free, or a separate address-kind publication key when occupied.

The address-keyed research cache includes the pipeline version. Evidence, partial
pipeline checkpoints, text and audio can be reused across neighborhoods. Existing
irrelevant addresses/publications block reuse. Parent checkpoints preserve failures,
the chosen route and completed publications. Startup marks interrupted processing
failed; explicit retry resumes it. Completed research, text and audio are not
repeated. As with the existing pipeline, a process crash between an external paid
response and its SQLite checkpoint cannot guarantee exactly-once provider billing.
Cached terminal `insufficient_evidence`/`review_required` outcomes without accepted
evidence or text are reused without new provider research across neighborhoods.
Retries revalidate every already-published story before skipping it, and all stories
again before completion. Missing, unready, irrelevant or blocked publications stop
the parent with terminal `STORY_UNAVAILABLE`, rather than reporting a ready walk.

## External Bounds

Discovery uses `WALK_OVERPASS_URL` (default Overpass interpreter), independently of
the ordinary planner's offline catalog. It makes one POST for addressed buildings,
without requiring a name, historic tag or heritage designation. No bulk Nominatim
requests occur. Radius is `min(1800, minutes*20)` metres. Bounds: 8-second upstream
query, 12-second client deadline, 1 MiB response, at most 160 returned elements,
Moscow coordinates, validated address tags, nearby spatial/address deduplication,
and at most three researched candidates. Each candidate retains OSM type, ID, URL,
fetch time and radius. Map data identifies candidates; it is not historical evidence.

At least two candidates need accepted evidence. The dedicated internal manual
planner has `minIntervalMs: 0`; a parent tries all three stops and, if needed, the
three two-stop subsets, at most four bounded route attempts. `WALK_ROUTER_URL`
remains the existing Valhalla route endpoint; with `WALK_TRACE_URL` set, the same
planner adds `tunnels` to the final route (best effort, no retry). No straight-line route fallback exists.
No evidence is terminal `insufficient_evidence`; no feasible route is terminal
`failed/WALK_NOT_FOUND` with `canRetry:false`. Temporary discovery/router/provider
failures permit explicit retry up to the existing three processing attempts.

Run `node --test backend/*.test.mjs`. Tests use mocked discovery, routing, research,
source pages and narration, with no production requests or paid synthesis.
