# Plan: Reliable stop snapping for automatic walks

Status: plan, 2026-10-02.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

A user built an automatic 30-minute loop from «Москва, Садовническая улица, 6 с11» (Храм Георгия Победоносца в Ендове, `55.7474344, 37.6269736`). The result was an 8-minute, 381 m walk with markers «1», «2» on the church and «3» on «Балчуг, 7». It reproduces exactly against the local Valhalla and a copy of the local `jobs.sqlite` (commit `d3c694c`).

Root causes, verified by tracing every router call:

1. **Snapping with `radius:100` breaks legs at stops.** `measureRoute` sends every location as `{type:'break', radius:100}` (`backend/walks.mjs:189`). With a wide radius, Valhalla picks a candidate edge per leg: the walk arrived at «Балчуг, 7» on one side of the building and left from another, a 46.8 m junction gap. The gap check (`walks.mjs:204`) correctly rejects the whole 5-stop, 19-minute chain as unusable. The wide radius also understates time: the "teleport" leg was 155 m versus 414 m with `radius:0`.
2. **An unusable first chain is treated as an over-budget one.** In `fillBudget` (`walks.mjs:233-241`), `!best?.fits` covers both "too long" and "unusable" and drops stops from the end until something fits. The bad stop was in the middle of the chain, so trimming kept it. Only the 2-stop prefix routed (7.5 min). The spacing search that fills the budget never ran.
3. **The start building becomes a stop.** The catalog point of the same church (same address, 16 m from the geocoded start) passed the `distance(start, p) < 5` filter (`walks.mjs:298`) and became the first stop.
4. **The creation preview numbers the start.** `walk-creation-panel.tsx:45-48` numbers `[start, ...stops, destination]` from 1. So «1» was the start, «2» the duplicate church stop and «3» the real second stop. The walk session already draws start/finish as `endpoint` rings (`src/features/tour/walk-session.tsx:47-51`).
5. **Valhalla errors are misreported.** Valhalla answers "no path" (442) with **HTTP 400**. `request()` throws `WALK_UNAVAILABLE` for any non-OK response (`walks.mjs:170`) before the `error_code===442` check (`walks.mjs:190`), so that check is dead code against a real router. In addition, a single automatic candidate snapped more than 150 m away throws `WALK_UNAVAILABLE` for the whole plan (`walks.mjs:201`; reproduced at «улица Лужники, 24 с3»). Users see «Пешеходный маршрутизатор временно недоступен» for what is a property of one landmark.

Benchmark (details in `docs/agents/valhalla-snapping.md`): 40 starts (the screenshot start plus 39 seeded random bundled-catalog buildings) × {loop, open} × {30, 60, 90} = 240 plans.

| Snapping | Errors | Below 75 % of time | Plans with gap rejects | A stop at the start building |
|---|---|---|---|---|
| `radius:100` (current) | 27 (11 %) | 70/213 (33 %) | 89 | 50/213 (23 %) |
| `radius:0, minimum_reachability:500` | 12 (5 %) | 15/228 (6.6 %) | 2 | 20/228 (9 %) |

`radius:0` alone produced new 442s: Зарядье/Варварка buildings snapped onto a closed patch of paths. `minimum_reachability:500` fixed all of them. The router is self-hosted (`compose.yaml` service `valhalla`, `WALK_ROUTER_URL`), so a call costs nothing but counts against the planner's 12 s deadline. Plans averaged about 3 calls, at most about 0.5 s locally.

## Approved decisions

1. **Snapping (user: "do it the production-ready way").** Every router location is sent as `{type:'break', radius:0, minimum_reachability:500}`. As a safety net, an automatic candidate that still yields an unusable route is excluded and the search continues. Unusable means: zero-length leg, junction gap, arrival snapped too far, or "no path" that can be attributed to it. Trimming from the end is never used for unusable routes.
2. **Start landmark becomes stop 1 (user choice).** The planner may pick one landmark at the start as the first stop. It is not routed, so it adds no walking time. It counts towards the stop cap and is listed first in `route.stops`.
3. **Creation preview markers:** start and destination are `endpoint` rings, as in the walk session. Stops are numbered from 1, so the map numbers match «Остановки · N».
4. **New error codes, symmetric for start and finish.**
   - `WALK_START_UNREACHABLE`, message «Сюда не дойти пешком. Выберите начало на улице рядом.»
   - `WALK_DESTINATION_UNREACHABLE`, message «Сюда не дойти пешком. Выберите финиш на улице рядом.»
   - Both use HTTP 404, like `WALK_NOT_FOUND`. Research is not offered for them.
5. Implementer's calls, kept minimal and listed here so they are not re-litigated:
   - start landmark radius 40 m;
   - automatic-stop snap limit 75 m;
   - user-chosen points keep the existing 150 m limit;
   - one router-call budget of 12 for the automatic path without destination;
   - no new API fields and no new persisted state.

## Key codebase facts

- `backend/walks.mjs` (357 lines):
  - `createWalkPlanner(...)` returns `planWalk(input, {client, storiesOnly})`.
  - `AUTO_STOP_LIMITS={30:5,60:8,90:10}`.
  - The `distinct` check (`:160-161`) rejects any two of `[start, ...stops, destination]` closer than 5 m with `WALK_INVALID`.
  - `request(url, body, contentType)` (`:168-182`) streams the body with a 1 MiB cap and throws `WALK_UNAVAILABLE` on `!response.ok`. It is shared with the Overpass request (`:284`).
  - `measureRoute(routeStops)` (`:185-214`):
    - builds `points=[start, ...routeStops, destination | (loop ? start : nothing)]`;
    - returns `null` for a zero-length leg (`:199`) or a junction gap over 10 m (`:204`);
    - throws `WALK_UNAVAILABLE` when a leg endpoint is more than 150 m from its location (`:201`);
    - computes `fits` at `:211`.
  - `routeStops(stops)` returns `measured?.fits ? route : null`.
  - `fillBudget(candidates, stopLimit)` (`:222-268`):
    - measures the spacing-0 chain;
    - takes the trimming branch on `!best?.fits`;
    - runs bisection on spacing with straight-line budget calibration;
    - caches by address list, with `MAX_AUTO_ROUTE_ATTEMPTS=8` distinct routes and `MAX_SPACING_STEPS=16`.
  - `selectChain` (`:56-75`) is exported and unit-tested.
  - `run()` (`:270-351`):
    - destination check first;
    - discovery from the bundled catalog or Overpass plus `candidateProvider` (`store.listWalkCandidates`);
    - candidates are deduplicated by `catalogId`, address and 5 m in `addCandidate` (`:295-302`);
    - destination branch at `:315-339`, `fillBudget` at `:342`, manual loop at `:344-350`.
  - The final catch (`:354`) passes through only `WALK_NOT_FOUND`, `WALK_STOPS_NOT_FOUND` and `WALK_DISCOVERY_UNAVAILABLE`; everything else becomes `WALK_UNAVAILABLE`/discovery.
- `backend/walk-plan-errors.mjs` holds the shared code → message/status map for `/api/walk-plan` and promo walks (`walkPlanErrorResponse`).
- `backend/walk-research.mjs`:
  - `canRetryWalk` (`:34`) excludes `WALK_NOT_FOUND`/`STORY_UNAVAILABLE`;
  - the subset loop (`:160-166`) swallows only `WALK_NOT_FOUND`;
  - the messages map is at `:189-191`;
  - it plans with manual stops via `createWalkPlanner({minIntervalMs:0})`.
- `backend/walk-document.mjs`: `MAX_WALK_STOPS=40`. The v2 validator has no distance rules. The v1→v2 converter (`:48-50`) already turns a start with a story into stop 0 at the start's exact location, which is precedent for a stop at the start.
- Frontend:
  - `src/features/walk-builder/model.ts:49-57` `validStops` requires every pair of `[start, ...stops, destination]` to be at least 5 m apart. Its twin for saved drafts is at `:95`.
  - `src/features/walk-builder/request.ts:5` `shouldOfferResearch` triggers only for `WALK_STOPS_NOT_FOUND`/`WALK_NOT_FOUND`.
  - Error text comes from the server `error.message`.
  - After an automatic build `use-walk-draft.ts` switches to manual selection. Any later rebuild sends `stops`, including a start landmark, so manual planning must accept it.
- Map markers: `MapItem.endpoint` (`src/features/explore/explore-map.tsx:95-96`) renders a hollow ring (`data-marker="endpoint"`), and numbered stops render `data-marker="pin"`.
- Tests:
  - `backend/walks.test.mjs` (node:test):
    - `fixture(handler)` wraps every handler result in `Response.json`, so status 400 cannot be mocked yet;
    - `route()` is a constant-time mock; `walkRoute()`, `grid()` and `gridPlanner()` are length-proportional mocks;
    - the dense-grid tests assert `calls.length<=8`;
    - `distinct landmarks ten metres apart remain separate stops` puts candidates 11–55 m from `start` and expects all five as stops in order.
  - `backend/server.test.mjs:260` and `backend/promo-walks.test.mjs:105` have error-code tables.
  - The e2e shortfall test is in `e2e/interface.spec.ts:513-535`.
- Scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test` (vitest + `node --test backend/*.test.mjs`), `pnpm test:e2e`, `pnpm check`.

## Implementation

### 0. Reproduce first (`backend/walks.test.mjs`)
Let `fixture` and the grid planner accept a handler that returns a `Response` as-is (`value instanceof Response ? value : Response.json(value)`). Add these tests; each must fail on the current code:
- A router answering `new Response(JSON.stringify({error_code:442, error:'No path could be found for input'}), {status:400})` for a manual route → rejects with `WALK_NOT_FOUND` (today: `WALK_UNAVAILABLE`).
- Dense grid, automatic 30-minute loop. The mock inserts a ≥ 30 m junction gap whenever one specific grid building is an **intermediate** location.
  - Result: `walkingMinutes >= 0.75*30`, that building is absent, and at least 3 stops remain.
  - Today the planner trims from the end.
- Automatic plan where one candidate's arrival point is 100 m away (move the leg's last shape point) → the plan succeeds without it (today: `WALK_UNAVAILABLE`).
- A candidate 16 m from `start` with the same address → `result.stops[0]` is that candidate, and no router request contains its coordinates.
- Every router request body uses `radius:0` and `minimum_reachability:500` for all locations.

### 1. Router request and response handling (`backend/walks.mjs`)
- Constants:
  - `SNAP_RADIUS_METERS=0`, `MIN_REACHABILITY_NODES=500`;
  - `MAX_POINT_SNAP_METERS=150` (start, destination, manual stops);
  - `MAX_AUTO_STOP_SNAP_METERS=75`;
  - `START_STOP_METERS=40`;
  - `MAX_AUTO_ROUTER_CALLS=12` (replaces `MAX_AUTO_ROUTE_ATTEMPTS`).
- Location payload: `{lat, lon, type:'break', radius:SNAP_RADIUS_METERS, minimum_reachability:MIN_REACHABILITY_NODES}`.
- Router errors: router calls must read the JSON body of a 4xx response with the same 1 MiB cap.
  - HTTP 400 with `error_code` 442 ("no path") or 171 ("no suitable edges") → internal `unroutable`.
  - Any other non-OK status, malformed JSON or abort → `WALK_UNAVAILABLE` as today.
  - Overpass handling is unchanged.
  - Implement it as an option of `request` or a small router-specific wrapper; do not duplicate the streaming reader.
  - Remove the dead `data?.error_code===442` check on 200.
- `measureRoute(routeStops, {autoStops=false})` returns one of:
  - `{kind:'route', seconds, fits, route}`. `fits` is unchanged.
  - `{kind:'rejected', reason:'zero_leg'|'gap'|'far_stop'|'unroutable', stopIndex:number|null}`. `stopIndex` indexes `routeStops`.
- **Start landmark rule.** If `routeStops[0]` is within `START_STOP_METERS` of `start`, it is "at the start": it is not sent to the router and not counted in `direct`, but it stays first in `route.stops`. This applies to every caller (automatic, destination, manual), so rebuilding a pinned automatic walk works.
- **Attribution.** Map router point indices back to `routeStops` indices, accounting for an unrouted start landmark.
  - Zero-length leg `i`: the stop at the leg end, or the stop at its start if the end is the closing start/destination. `null` if neither is a stop.
  - Gap at junction `i`: the stop at `points[i]`.
  - Arrival of an intermediate stop farther than `autoStops ? MAX_AUTO_STOP_SNAP_METERS : MAX_POINT_SNAP_METERS` → `far_stop`.
  - `unroutable` → `stopIndex:null`.
- **Unreachable endpoints throw.**
  - First leg starts more than `MAX_POINT_SNAP_METERS` from `start` (or the closing leg of a loop ends that far from it) → `WALK_START_UNREACHABLE`.
  - The last leg of a destination route ends more than `MAX_POINT_SNAP_METERS` from `destination` → `WALK_DESTINATION_UNREACHABLE`.
  - Check the start first.
- Malformed data (decode errors, length mismatch, oversized geometry) keeps throwing `WALK_UNAVAILABLE`.
- `routeStops(stops)` keeps its contract: a route when `kind==='route' && fits`, otherwise `null`. A mandatory route that is `unroutable` (direct A→B check, manual loop) → `WALK_NOT_FOUND`, as originally intended.
- `distinct` check: skip only the pair (`start`, `stops[0]`), because a first stop may coincide with the start. All other pairs keep the 5 m rule.
- Final catch: also pass through `WALK_START_UNREACHABLE` and `WALK_DESTINATION_UNREACHABLE`.

### 2. Start landmark in discovery (`run()`)
- `addCandidate`: drop the `< 5 m from start` exclusion. A candidate within `START_STOP_METERS` of the start goes to a `nearStart` list **and** stays in `candidates`.
- `startLandmark` = best of `nearStart` by:
  1. same normalized address as the start (casefold, `ё→е`, punctuation and whitespace collapsed, as in `addressKey` in `backend/domain.mjs`);
  2. `contentRank` desc;
  3. `catalogRank` desc;
  4. distance asc.

  Remove `startLandmark` from `candidates`. Other nearby landmarks stay ordinary candidates; the "ten metres apart" test must keep passing.
- `storiesOnly` is honoured automatically, because `addCandidate` already drops entries without `contentId`.
- **Without destination:** `fillBudget(candidates, stopLimit - (startLandmark ? 1 : 0), startLandmark)`.
  - Every measured list is `[startLandmark, ...chain]`.
  - `WALK_STOPS_NOT_FOUND` is still raised when fewer than 2 routable candidates remain; the landmark does not count towards that minimum.
- **With destination:** seed `stops` with `startLandmark`.
  - If no further candidate is added, return the direct route with `stops:[publicStop(startLandmark)]` and no extra router call: the landmark is not routed, so the geometry is identical.
  - In the candidate loops, any `rejected` result (including `unroutable`, which here is attributable to the just-added candidate) skips that candidate, as `null` does today.
- **Manual routes:** unchanged apart from the measureRoute rules.

### 3. Failure handling in `fillBudget`
- State:
  - `excluded:Set<candidate>`;
  - the chain is built from `candidates` minus `excluded`;
  - one counter of router calls, capped by `MAX_AUTO_ROUTER_CALLS`, covers every call in this function: first chain, exclusion retries, trimming, bisection;
  - the cache by address list stays.
- `measure(chain)` helper: on `rejected` with a `stopIndex`, add `chain[stopIndex]` to `excluded` and report "retry".
- **Phase A, spacing 0:**
  - Build the nearest chain, keeping the existing `straightBudgetM=Infinity` fallback for sparse areas, and measure it.
  - Retry → rebuild and re-measure.
  - Fits and reaches the floor → return.
  - Fits but short → becomes `best`, go to Phase B.
  - Over budget, or `unroutable` without attribution → Phase T.
- **Phase T, trimming (over-budget/unattributed only):**
  - Shorten the list from the end down to 2 stops.
  - A `rejected` result with a `stopIndex` removes that stop, not the last one, and adds it to `excluded`.
  - The first fitting route is returned. Otherwise `WALK_NOT_FOUND`.
- **Phase B, bisection:** as today, except that a retry re-runs the same `spacingM`; it does not lower `hi`. Unattributed rejects lower `hi` as today. Calibration and the floor test are unchanged.
- Budget exhausted → return `best.route`. If no usable route was ever measured, throw `WALK_NOT_FOUND`.
- Abort checks (`controller.signal.throwIfAborted()`) stay in every loop.

### 4. Error codes
- `backend/walk-plan-errors.mjs`: add both codes, with status 404 and the approved messages.
- `backend/walk-research.mjs`:
  - `canRetryWalk` also excludes both codes;
  - the messages map gets the same two texts;
  - the subset loop keeps propagating them, because other subsets cannot help.
- `src/features/walk-builder/request.ts`: no change in `shouldOfferResearch`; add a test that both codes do not offer research.

### 5. Frontend
- `src/features/walk-builder/walk-creation-panel.tsx:45-48`, map items:
  - start → `{id:'creation-start', title:`Старт: ${address}`, endpoint:true}`;
  - stops → `{id:`creation-stop-${i}`, title:`Остановка ${i+1}: ${address}`, number:i+1}`;
  - destination → `{id:'creation-finish', title:`Финиш: ${address}`, endpoint:true}`;
  - a loop shows only the start ring.

  Follow the `walk-session.tsx:47-51` pattern.
- `src/features/walk-builder/model.ts` `validStops`: skip the 5 m rule only for the pair (`start`, `stops[0]`), mirroring the backend. The saved-draft check at `:95` reuses `validStops`, so a stored start-landmark route stays valid.

### 6. Docs (Russian)
- `docs/agents/walk-routing-selection.md`:
  - snapping parameters;
  - the start landmark;
  - exclusion instead of trimming for unusable routes;
  - the router-call budget;
  - the new codes.
- `docs/agents/valhalla-snapping.md`: append the post-fix benchmark row (method in Testing).
- `docs/agents/promo-walks-service-api.md`: the two new error codes.

## Testing & verification

Backend (`node --test backend/*.test.mjs`), no real Valhalla, Overpass or paid APIs:
- The step-0 tests now pass.
- Table-driven `measureRoute` attribution through `planWalk`, one test per row (zero-length, gap or far arrival at the first, a middle and the last stop, in loop and open mode):
  - automatic → the stop is excluded and the plan succeeds;
  - manual → `WALK_NOT_FOUND`.
- Start unreachable: first leg starts 200 m away → `WALK_START_UNREACHABLE`, for automatic and for manual.
- Destination unreachable: last leg ends 200 m from the destination → `WALK_DESTINATION_UNREACHABLE`, raised before discovery and without Overpass/candidate calls.
- 442 on the direct A→B check → `WALK_NOT_FOUND`. 442 while adding an optional candidate on an A→B route → that candidate is skipped, and the route keeps the earlier stops.
- 442 for an automatic chain without destination → no `WALK_UNAVAILABLE`; the search continues within budget.
- Start landmark:
  - it is the first stop, and a manual rebuild with the same stops makes the same router request;
  - it is still allowed when it is < 5 m from the start;
  - with a destination and no other candidates, the plan returns `[landmark]` with exactly one router call;
  - `storiesOnly` ignores a landmark without `contentId`.
- Router-call budget: an always-rejecting mock makes at most `MAX_AUTO_ROUTER_CALLS` calls. Update the dense-grid assertion from `<=8` to `<=MAX_AUTO_ROUTER_CALLS`, keeping its intent.
- Existing tests stay green, including `distinct landmarks ten metres apart remain separate stops` (the 11 m candidate becomes the landmark and the order is unchanged). Update a pinned test only where the new behaviour legitimately changes it, and say why in the commit.
- `backend/server.test.mjs` and `backend/promo-walks.test.mjs` error tables: add both codes with status 404 and messages.
- `backend/walk-research.test.mjs`: the new codes are not retryable and carry their messages.

Frontend (vitest):
- `validStops` table: a first stop 0 m and 3 m from the start is valid; a second stop 3 m from the start is invalid; the destination 3 m from the start is invalid.
- `shouldOfferResearch` with the new codes → false.

Playwright (`e2e/interface.spec.ts`), with `/api/walk-plan` mocked:
- After «Построить прогулку» for a loop, the creation map shows exactly 1 `[data-marker="endpoint"]` and N `[data-marker="pin"]` numbered 1..N, where N equals «Остановки · N».
- An A→B route shows 2 endpoint rings.
- A mocked `WALK_START_UNREACHABLE` response shows its message and no research offer.

End-to-end against the local Valhalla (`docker compose` with `compose.override.yaml` exposing `127.0.0.1:8002`):
- Rebuild the screenshot case (start above, loop, 30/60/90). Expect:
  - no stop duplicating the start other than the start landmark as stop 1;
  - ≥ 75 % of the time or the shortfall note;
  - markers: ring at the start, stops 1..N.
- Re-run the 240-plan benchmark described in `docs/agents/valhalla-snapping.md`, using a copy of the local `jobs.sqlite` and the planner with a logging `fetchImpl`. Expect:
  - errors ≤ the `radius:0` row (12) and no `WALK_UNAVAILABLE` caused by a single landmark;
  - shortfall ≤ 15/228;
  - every stop at the start building appears only as stop 1;
  - average router calls well under the budget.

  Record the numbers in that note. Do not commit the throwaway harness.
- Before committing, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, then `pnpm test:e2e`. The known pre-existing `layout-invariants` failures are documented in `2026-10-02-unified-map-markers.md`.

## Out of scope

- Starts inside closed territories that still route with an enormous detour (Ипатьевский пер., 12 с1; улица Докукина, 15 с1). They keep returning `WALK_NOT_FOUND`.
- Matching the start landmark by OSM id. The frontend does not pass the start's `osmId` to the planner; the distance and address rule is enough.
- A finish landmark as the last stop. Candidates near the destination keep the existing 5 m exclusion.
- Changing `AUTO_STOP_LIMITS`, the 75 % floor, the discovery radius, or the number of stops per walk.
- Budgeting listening time.
- The research flow's own candidate selection.
- **Reliability risk, not fixed here:** router calls have no retry on transient 5xx/timeouts. One failing Valhalla call fails the plan with `WALK_UNAVAILABLE`. A bounded retry (1–2 attempts with backoff inside the 12 s deadline) is the proper fix and should be proposed separately.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
