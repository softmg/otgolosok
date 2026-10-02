# Plan: Guide the walker along the current leg (route styling, camera, arrival-gated audio, tunnels)

Status: in progress since 2026-10-02.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

User feedback on walking a universal walk (`/walk?local|id|catalog|share=…`, screen `WalkSession`):

1. The route line should be slightly transparent.
2. When the walk starts, the map does not move or zoom to a useful view; the walker has to pan/zoom by hand.
3. The first stop's story starts playing immediately on «Начать прогулку», although the walker still has to walk there.
4. It is unclear where to go right now: the whole route is drawn equally. Only the current leg should stand out, the rest should be strongly faded, with direction arrows.
5. Where the route goes underground (pedestrian underpass), the line should be dashed.

Current behavior (verified):
- `startTour` (`src/features/tour/tour-experience.tsx:170`) calls `audio.begin(initialIndex, …)` inside the click, which plays chapter 0 at once. The geofence then listens for the *following* stop: `nextChapterTarget` / `chapterTriggerConfig` (`src/features/tour/walk-plan.tsx:11-21`) use `chapters[index + 1]`. The design assumed the walk starts at stop 1, which is false for user walks: `route.walk.start` is a separate address, the first stop can be hundreds of metres away.
- `WalkSession` (`src/features/tour/walk-session.tsx:42-45`) focuses the first stop once (initial `focus` state) and passes `fitGeometry={!focus}`, so the route is never fitted; starting the walk changes nothing on the map.
- `ExploreMap` draws the route as two polylines in Leaflet's default overlay pane: casing (`--surface-island`, weight 9, opacity 0.9) and line (`--route-line`, weight 5, opacity 0.95) (`src/features/explore/explore-map.tsx:458-474`). Same component is used by the walk builder (via `AroundScreen`) and by `WalkSession`.
- Stop/leg boundaries are not stored anywhere: `WalkDocument.route` is `{ geometry, distanceM, walkingMinutes, attribution }`.
- Valhalla `/route` responses carry no tunnel information.

External service: self-hosted Valhalla (`compose.yaml` service `valhalla`, image `ghcr.io/valhalla/valhalla-scripted:latest`, local instance reports version 3.8.3). No per-call cost. New endpoint used: `POST /trace_attributes` on the same host. Probed locally on 2026-10-02 (details in step 9):
- `trace_attributes` with `edge.tunnel`, `edge.begin_shape_index`, `edge.end_shape_index`, `shape` returns `tunnel: true` for underpasses (Pushkinskaya under Tverskaya, Mayakovskaya under the Garden Ring), ~7 ms per leg.
- `tunnel: true` is also set for `tunnel=building_passage` (an arch: way 39950039, Георгиевский переулок). Underpasses additionally have `levels: [[-1,-1]]`; arches have no `levels`.
- `shape_match:"edge_walk"` fails with HTTP 400 `error_code:443` on a leg that starts with a U-turn at a stop (common with `type:'break'` stops). `walk_or_snap`/`map_snap` succeed but return their own shape (76 points for a 78-point input), so `begin/end_shape_index` do NOT index our geometry in general.

## Approved decisions

1. **One plan** covers all five items (UI + backend tunnels).
2. **Audio — "walk there first"** (advance modes `manual` and `place`):
   - After «Начать прогулку» the walker is *on the way to stop 1*; nothing plays.
   - Mode «По месту» (`place`): the story starts by itself on arrival at that stop.
   - Mode «По кнопке» (`manual`): the story starts when the walker presses ▶ («Слушать историю») in the player.
   - «Дальше» (and lock-screen "next") moves to *on the way to the next stop* without autoplay; «Предыдущая остановка» likewise.
   - Mode «Подряд» (`sequence`, listening at home) keeps today's behavior: plays immediately and chains chapters.
3. **Leg highlight with chevrons.** Highlighted leg = the leg the walker should walk now: while on the way to stop k — the leg ending at stop k (from the start or stop k−1); after the walker has arrived at stop k — the leg from stop k to stop k+1 (or to the finish). The rest of the route is strongly faded. Small light chevrons («›») along the highlighted leg show the direction; no animation.
4. **Camera — fit the leg.** On start and on every change of the highlighted leg the map fits that leg plus the walker's position (if known and near). Between changes the map is the walker's to move; «Моё местоположение» stays. No continuous follow mode.
5. **Dashed = any tunnel.** Every edge Valhalla flags `tunnel` is dashed — underpasses and arches through buildings alike (both are invisible from above). Works where OSM has no `level` on an underpass.
6. **Old walks: only new routes + the built-in catalog.** Routes built after release get tunnel data; the built-in catalog route in the repo is annotated once. Walks already saved in accounts, by share link or in browsers keep a solid line until their route is rebuilt. No DB backfill, no on-the-fly API.
7. **Transparency everywhere.** The route line is slightly transparent (≈80% group opacity) on every map that draws it (walk builder, walk before start, walk in progress). During a walk the non-highlighted part is ≈30%.

Defaults chosen by the planner (not separately discussed; change only with the user):
- Resuming («Продолжить прогулку») a chapter saved with `positionSec ≥ 1` continues playing that story from the saved offset (an explicit request to continue it); a checkpoint below 1 s resumes as *on the way to* that stop, silent.
- Tunnel lookup is best-effort: any failure or timeout returns the route without tunnel data (solid line), never fails or slows down a plan beyond its own small budget. No retries (justified in step 1).
- The tunnel lookup is switched on by a new env var `WALK_TRACE_URL`; unset = off.

## Key codebase facts

Walk session / audio:
- `src/features/tour/tour-experience.tsx` — `AvailableTour` owns phase (`reading`/`walking`), `chapterIndex`, `startTour` (170), `stopTour` (218), `selectChapter` (235), `liveRef` (76, refreshed every render at 253) read by the long-lived position subscription, Media Session actions (151-168). `universal` is true for `WalkSession` walks; `false` = legacy `ClassicWalkView` demo on `/` (out of scope — keep its behavior byte-for-byte).
- `position.start({ live, busy, onEntered })` (`src/features/tour/use-walk-position.ts:172`): every fix runs `processFix(state, fix, live().target, live().config, busy())`; `entered` → `onEntered`. `resetTrigger()` must be called whenever the watched target changes. Arrivals are withheld while a recording plays (`busy`).
- `onEntered` today (tour-experience.tsx:208-214): `place` mode → `selectChapterRef.current(live.index + 1)`.
- `useWalkAudio` (`src/features/tour/use-walk-audio.ts`): `begin(index, positionSec, source)` must be called synchronously in the click (iOS user activation); `switchTo(index, source)` stops and plays; `toggle()` plays/pauses current source; checkpoints via `setChapterCheckpoint` (only chapters with audio). `sync()` writes `playbackTime` and the checkpoint from the element; it is guarded by `playbackSourceRef` / `restoringOffsetRef`.
- `unlockAudioElement(audio)` (`src/lib/audio/audio-element.ts:192`) plays a 0.15 s silent data-URI clip and pauses — the existing iOS unlock. Its `playing`/`pause` events reach `useWalkAudio`'s handlers (`onPlaying` sets status `playing` and `busyRef`), so an unlock path must neutralize those (see how `begin` overrides status after unlock for the non-universal test tone).
- `usePlaybackProgress` / `savedCheckpoint` drives the «Продолжить прогулку» label (`resume` prop).
- Settings: `src/features/tour/walk-settings.ts` — `AdvanceMode = "manual" | "place" | "sequence"`, default `manual`. `advanceModeHints` is used only by `ClassicWalkView`.
- `WalkSession` props: `index`, `active`, `completed`, `user` (= `position.diagnostics.lastFix`), `onSelect`, player/story nodes. Meta line «Остановка N из M» at walk-session.tsx:102. Footer «Дальше»/«Завершить»/previous at 141-144. The map pin click calls `select(position)` while active (89-90).
- `getWalkChapters(route, true)` keeps every step for universal walks, so chapter index = step index = stop index.
- `?replay=walk&speed=1..20` replays the routed line as GPS fixes (`use-walk-position.ts:179-188`) — usable in e2e for the `place` flow.

Map:
- `ExploreMap` (`src/features/explore/explore-map.tsx`): props `geometry`, `fitGeometry`, `focus`, `insets`, `user`. Runtime keeps `L`, `map`, `view`, `colors` (read from CSS tokens once), layer groups `markers`, `position`, `route`. Route effect at 458-474 clears and redraws, then `view.fit(bounds)` or `view.clearFit()`; it marks the green path with `data-route=""`.
- `createMapView` (`src/features/explore/map-view.ts`): keeps the last `focus`/`fit` target inside the free area while panels resize, until the user pans/zooms (`userMoved`). `fit(bounds)` and `focus()` reset `userMoved`. Route fit is capped at zoom 17 (`ROUTE_MAX_ZOOM`).
- `WalkSession` computes `insets` (`padding`) from the measured panel/header (walk-session.tsx:55-77).
- Leaflet 1.9: a layer with `options.pane` gets its own SVG renderer per pane automatically; a pane element's CSS `opacity` gives *group* opacity (casing does not show through the line). Default `overlayPane` z-index 400, `markerPane` 600.
- Unit tests of `ExploreMap` mock `react` and `leaflet` (`src/features/explore/explore-map.test.ts`); new Leaflet calls (`createPane`, `pane` option) need mock support. Keep geometry logic in pure modules.
- Builder path: `around-screen.tsx:208` passes `geometry: creationMap.geometry`; `CreationMap` type in `src/features/walk-builder/walk-creation-panel.tsx:17`, filled at :53 from `w.draft.route?.geometry`.

Data contract:
- `backend/walk-document.mjs` is the shared validator (imported by the frontend through `src/features/walks/model.ts:19`). `fields()` is strict: unknown keys are rejected. `route` validator at line 13; `migrateLegacyDraft` copies route fields explicitly (line ~53).
- Builder `Plan` type and `isPlan` validation: `src/features/walk-builder/model.ts:9` and ~60-65; saved-draft check at ~97; `use-walk-draft.ts:249` validates the API response.
- Adapters copy route fields explicitly: `src/features/walks/adapters.ts` ~61 (draft→document), ~96 (document→draft), ~236 (`walkViewToRoute`: `path.coordinates`), ~289 (`routeToWalkView`).
- `WalkPlan.path` type: `src/features/tour/types.ts` (`coordinates: number[][]`, `provider`, …).
- Built-in catalog route: only `msk-kozhevniki-zindel-short` (31 points, 4 steps), duplicated in `backend/builtin-routes.mjs` (served by `catalogWalkView`, `backend/walk-catalog.mjs:32`) and `public/data/routes/paveletskaya.json` (bundled into the frontend, also used by e2e). Locally `trace_attributes` finds 1 tunnel edge on it.
- Known rollout hazard (docs/agents/boulevard-ring-walk-2026-09-30.md, "Старая офлайн-оболочка"): a cached old frontend rejects documents with fields it does not know until the shell updates itself.

Planner:
- `backend/walks.mjs`: `createWalkPlanner({ fetchImpl, routerUrl = process.env.WALK_ROUTER_URL, timeoutMs = 12000, … })` (133). Inside a plan: one `AbortController` + `deadline` race (`timeoutMs`); `request(url, body, contentType, { routerErrors })` streams with a 1 MB cap (187-203). `measureRoute` (209-254) decodes each leg (`decode`, polyline6) into `shapes`, concatenates them into `geometry` with `slice(1)` for every leg after the first, and returns `{ kind:'route', seconds, fits, route:{ stops, geometry, distanceM, walkingMinutes, attribution } }`; the decoded leg shapes are discarded. `run()` produces the final route; the public result is `await Promise.race([run(), deadline])` (~line 428).
- Many tests in `backend/walks.test.mjs` fake `fetchImpl` for *any* URL, count calls, or assert the URL equals the router URL (e.g. line 214) — the trace lookup must be off unless `traceUrl` is configured.
- `WALK_ROUTER_URL` is documented in `README.md:58`, `docs/production-deployment.md:232`, `content/walk-builder.md:46`, `backend/WALK_RESEARCH.md:92`, and set in `compose.yaml:24`.

## Implementation

### 0. Shared tunnel contract

`backend/walk-document.mjs`:
- Export `validTunnels(value, geometryLength)`: `undefined` is valid (field absent); otherwise an array of at most 500 pairs `[a, b]` of integers with `0 ≤ a < b ≤ geometryLength − 1`, sorted, non-overlapping and non-touching (`b_i < a_{i+1}`; touching ranges are merged by producers).
- Meaning: every segment between vertices `a..b` of `route.geometry` is in a tunnel (covered passage).
- `route` validator accepts the optional key `tunnels` (add to `fields`) and checks it with `validTunnels`. `migrateLegacyDraft` copies it when present. Typedef updated.
- `src/features/walks/model.ts`: `route.tunnels?: Array<[number, number]>`.
- `src/features/walk-builder/model.ts`: `Plan.tunnels?`; `isPlan` validates with the shared `validTunnels` (no duplicated rules).
- `src/features/tour/types.ts`: `WalkPlan.path.tunnels?: Array<[number, number]>` (same index space as `path.coordinates`).
- `src/features/walks/adapters.ts`: carry `tunnels` through all four explicit copies (draft↔document, document→`Route.walk.path`, `Route`→view). Omit the key when absent (do not write `tunnels: undefined` into stored JSON).

### 1. Backend: annotate the final route with tunnels

`backend/walks.mjs`:
- New option `traceUrl = process.env.WALK_TRACE_URL` (full Valhalla `/trace_attributes` URL). Empty/unset → no lookup, no extra fetch. Validate protocol/credentials like `routerUrl` (http/https, no userinfo); invalid → treat as unset and keep planning.
- `measureRoute` keeps the decoded leg shapes of an accepted route on its internal result (e.g. `legs: shapes`), never on the public `route` object.
- After `run()` has chosen the final route, call `traceTunnels(legs, { fetchImpl, traceUrl, signal, budgetMs })` and, on success with ≥1 range, set `route.tunnels`. The candidate-search loops must not call it.
- Budget: skip the lookup if less than 2 s of the plan deadline remains; otherwise its own `AbortController` with `TRACE_TIMEOUT_MS = 1500`, also aborted by the plan's signal. All-or-nothing: if any leg fails, return no `tunnels` at all (a partial set would show some underpasses solid with no way to tell).
- Error policy: catch everything inside `traceTunnels` (network, non-2xx, `error_code`, malformed JSON, >1 MB body, abort) → `null`. Never let it reject the plan or change `WALK_*` error codes. No retry: the data is cosmetic, the planner already has a hard 12 s budget shared with routing, and the next route build gets another chance; record this reasoning in a short comment.
- `traceTunnels` (export it for tests and the one-off catalog annotation, step 8):
  - Request per leg, sequentially: `{ shape: leg (array of {lat, lon}), costing: "pedestrian", shape_match: "walk_or_snap", filters: { attributes: ["edge.tunnel", "edge.begin_shape_index", "edge.end_shape_index", "shape"], action: "include" } }`. Reuse the streaming/size-capped reading of `request` (factor the body reader out of `request` if needed instead of copying it).
  - Map back **geometrically**, not by index: decode the response `shape` (polyline6); for each edge with `tunnel === true`, take the sub-polyline `shape[begin..end]`; a segment `(leg[i], leg[i+1])` is covered when both endpoints lie within 3 m of that sub-polyline. Restrict matching to the leg's own segments.
  - Convert to global indices using the same concatenation as `measureRoute` (leg 0 starts at 0; leg j starts at the previous leg's last index because of `slice(1)`), merge adjacent/touching runs, return sorted `[a, b]` pairs (≤ 500, else return `null`).
- `compose.yaml`: `WALK_TRACE_URL: ${WALK_TRACE_URL:-http://valhalla:8002/trace_attributes}` next to `WALK_ROUTER_URL`. Document it wherever `WALK_ROUTER_URL` is documented (README.md, docs/production-deployment.md, content/walk-builder.md, backend/WALK_RESEARCH.md); `.env.example` only if it lists `WALK_ROUTER_URL`-style overrides.
- Promo walks / research planner (`backend/walk-research.mjs:102`) use the same planner and get tunnels automatically; no code change expected there — verify.

### 2. Frontend: legs of the route

New pure module `src/features/tour/route-legs.ts`:
- `routeLegCuts(geometry: Coordinates[], stops: Coordinates[]): number[]` — for each stop i, the geometry vertex index where the leg into stop i ends; non-decreasing. Use `stop.triggerLocation ?? stop.place.location` (in `Route` terms `trigger_location ?? location`). Search forward from the previous cut; among the remaining vertices take the minimum distance `m`, then pick the *earliest* vertex with distance ≤ `m + 15 m` (a loop walk can pass the same spot again later). A stop at the start building yields cut 0.
- `legRange(cuts, geometryLength, leg)`: leg 0 = `[0, cuts[0]]`, leg i = `[cuts[i−1], cuts[i]]`, final leg (to the finish) = `[cuts[last], geometryLength − 1]`; returns `null` when the range has fewer than 2 vertices (stop at the start, finish equal to the last stop).
- A walk without stops has one leg = the whole geometry.

### 3. Frontend: walk stage model (universal walks only)

`src/features/tour/walk-plan.tsx` — add pure helpers next to `nextChapterTarget`:
- `type StopStage = "approach" | "stop"` — `approach`: walking to chapter `index`'s stop, story not started; `stop`: arrived, story started (or text-only stop reached).
- `arrivalTarget(chapters, index, stage, finish)` / `arrivalTriggerConfig(chapters, index, stage, fallback)`: `approach` → stop `index` (its `trigger_location ?? location`, its `trigger`); `stop` → today's `nextChapterTarget` / `chapterTriggerConfig`.
- `highlightedLeg(index, stage, chapterCount)`: `approach` → leg `index`; `stop` → leg `index + 1` (the final leg when `index` is the last chapter).

`src/features/tour/tour-experience.tsx` (`AvailableTour`), only when `universal`:
- New state `stage: StopStage`, mirrored into `liveRef` (read by `onEntered`, Media Session, and target/config computation). Replace `target`/`triggerConfig` computation for universal walks with the stage-aware helpers. Every change of `index` or `stage` calls `position.resetTrigger()` and updates `liveRef` synchronously (same pattern as `selectChapter` today).
- `startTour`:
  - `sequence` mode: unchanged (play immediately, `stage = "stop"`).
  - Resume with `savedCheckpoint.positionSec ≥ 1`: `stage = "stop"`, play from the offset (as today).
  - Otherwise: `stage = "approach"`, no playback. Still inside the click: unlock the audio element for later programmatic play (new `useWalkAudio` entry, e.g. `prime(index)`, built on `unlockAudioElement`), create the Media Session, and save checkpoint `(index, 0)` so «Продолжить прогулку» works. The unlock must not change visible status, `playbackTime`, `busyRef` or the checkpoint: guard the handlers the same way `playbackSourceRef` guards foreign sources, then settle status to `ready` (also when unlocking fails — a manual ▶ is a new user gesture).
- Arrival (`stage → "stop"`) happens when:
  - `place` mode and `onEntered` fires while `stage === "approach"` → play chapter `index`;
  - `place` mode and `onEntered` fires while `stage === "stop"` (watching stop `index + 1`) → move to `index + 1` and play it (`stage` stays `stop`) — today's behavior;
  - any mode: the walker presses ▶ in the player while `approach` (wrap `audio.toggle` so a play from `approach` sets `stage = "stop"`);
  - a stop without audio in `place` mode just switches the stage (the next leg lights up).
- `selectChapter(index)` («Дальше», previous, stop list, map pin, lock-screen next/previous): in `sequence` mode unchanged (switch and play). Otherwise: stop current audio, `chapterIndex = index`, `stage = "approach"`, checkpoint `(index, 0)`, no playback. Extend `audio.switchTo` with a `play: boolean` flag (or add a sibling) instead of duplicating its reset logic.
- `onEnded` in `sequence` mode: unchanged.
- Media Session: `play`/`pause` → the wrapped toggle (so lock-screen play counts as arrival); `next`/`previous` → `selectChapter` as on screen.
- `ClassicWalkView` path (`universal === false`): no behavior change. Keep its existing helpers working.

### 4. Frontend: panel copy and props

`src/features/tour/walk-session.tsx` (UI text in Russian):
- New props `stage` and `advance` (or a ready-made hint string).
- Meta line: `approach` → «Идём к остановке {index+1} из {N}»; `stop` → «Остановка {index+1} из {N}» (as today).
- Hint under the title while `approach` (muted style, `role="status"` not needed): `place` → «История начнётся, когда вы подойдёте.»; `manual` with audio → «Когда будете на месте, нажмите «Слушать историю».»; no audio → nothing new. The existing GPS-failure notice stays.
- Player stays visible in `approach` (its button label is already «Слушать историю» for status `ready`).
- Footer labels unchanged («Дальше» / «Завершить» / previous arrow).

### 5. Frontend: map styling — transparency, faded rest, dashes, chevrons

New pure module `src/features/explore/route-style.ts`:
- Constants (single place, tuned by screenshots): `ROUTE_OPACITY = 0.8`, `ROUTE_DIM_OPACITY = 0.3`, dash pattern for covered runs (e.g. `"6 8"`, `lineCap: "butt"`), chevron spacing ≈ 70 px, chevron cap (e.g. 200).
- `routeRuns(length, tunnels, active)` → ordered runs `{ from, to, covered, active }` covering `0..length−1` exactly once (active range excluded from the faded part, so nothing is drawn twice).
- `chevronMarks(points: {x, y}[], spacingPx)` → `{ x, y, angleDeg }[]` along the polyline in layer pixels; at least one mark at mid-length for a short leg; none for a degenerate leg.

`src/features/explore/explore-map.tsx`:
- New props: `tunnels?: Array<[number, number]>`, `activeLeg?: [number, number] | null`, `fitTarget?: { points: Coordinates[]; keepUserView: boolean } | null` (see step 6).
- Create two panes once at map init: `route` (z-index ≈ 410) and `routeActive` (≈ 420), both below markers. Pane CSS opacity: `route` = `ROUTE_OPACITY`, or `ROUTE_DIM_OPACITY` when `activeLeg` is set; `routeActive` = `ROUTE_OPACITY`. Use classes in `explore-map.module.css` rather than inline styles.
- Draw each run as casing (solid) + green line; covered runs get the dash pattern on the green line only (the solid light casing keeps the gaps legible). Active runs go to `routeActive`, the rest to `route`.
- Chevrons: non-interactive `divIcon` markers in the `routeActive` pane, inline SVG «›» in `--surface-island` colour, rotated by `angleDeg`, `aria-hidden`. Recompute on `zoomend` and when `activeLeg`/`geometry` change (layer pixels do not change on pan).
- Keep test hooks: every green path keeps `data-route` (existing selectors), plus `data-route-part="active" | "rest"`; dashed paths `data-route-covered=""`; chevrons `data-route-arrow`. Existing e2e selectors `.leaflet-overlay-pane path[data-route]` must be updated because the paths move to custom panes — grep `data-route` in `e2e/` and `src/`.
- The route-drawing effect only draws; route fitting (`fitGeometry`) stays as today for the builder. Make sure redrawing the route (e.g. `activeLeg` change) never calls `view.clearFit()` on a leg fit requested through `fitTarget`.
- Builder: add `tunnels` to `CreationMap` (`walk-creation-panel.tsx`) from `w.draft.route?.tunnels`, pass through `around-screen.tsx`. No `activeLeg` there → whole route at `ROUTE_OPACITY` with dashes.

### 6. Frontend: camera

`src/features/explore/map-view.ts`:
- `fit(bounds, { keepUserView = false } = {})`: with `keepUserView` the request is ignored while `userMoved` is true (and does not reset it); otherwise as today.

`src/features/explore/explore-map.tsx`: when `fitTarget` identity changes and has ≥ 1 point, `view.fit(L.latLngBounds(points), { keepUserView })` (a single point → `view.focus` at `FOCUS_ZOOM`).

`src/features/tour/walk-session.tsx`:
- While `active`, compute the highlighted leg (`routeLegCuts` + `highlightedLeg` + `legRange`) and pass `activeLeg`; not active (before start / completed) → `null`.
- On every change of the highlighted leg (including start): `fitTarget = { points: leg vertices + walker position if a fix exists within 1.5 km of the leg bounds, keepUserView: false }`. Read the current fix through a ref so position updates do not refit.
- Once per session, when the first fix arrives after a leg fit that had no position: `fitTarget = { points: leg + position, keepUserView: true }` (does not override a manual pan).
- Degenerate leg (`legRange` null): focus the target point (stop or finish) instead.
- Before start the behavior is unchanged (focus on the first stop, `fitGeometry={false}`), see docs/agents/walk-map-session.md.

### 7. Docs

- `docs/agents/walk-map-session.md`: replace the description of start/advance with the stage model, leg highlight, camera and the `sequence` exception; note the existing limitation that a locked phone may suspend the page, so `place` arrival needs the page alive (unchanged by this work — previously the gap existed between chapters).
- New `docs/agents/route-tunnels.md` (+ two-sentence entry in `docs/agents/README.md`): Valhalla findings from this plan (tunnel incl. `building_passage`, `levels` on underpasses, `edge_walk` 443 on U-turn legs, `map_snap` shape mismatch → geometric mapping, timings), the `WALK_TRACE_URL` switch, the catalog annotation command and result, the rollout order.

### 8. Built-in catalog route data

Run `traceTunnels` once against local Valhalla for `msk-kozhevniki-zindel-short` (pass its whole `walk.path.coordinates` as a single leg) and write the resulting `tunnels` into `walk.path.tunnels` of both `backend/builtin-routes.mjs` and `public/data/routes/paveletskaya.json` (keep the two copies identical; check whether a test already compares them). `catalogWalkView` (`backend/walk-catalog.mjs:32`) passes `path.tunnels` into `route.tunnels`. Record the exact command and output in `docs/agents/route-tunnels.md`. No new committed script (one-off; YAGNI).

### 9. Rollout

Ship the frontend (validators, rendering) together with or before the backend. Old cached offline shells reject documents with the new `tunnels` key until they update (self-heals on the next online load; `/update.html` exists) — the same hazard as documented in docs/agents/boulevard-ring-walk-2026-09-30.md. `WALK_TRACE_URL` can be emptied in production `.env` to switch the producer off without a redeploy of code.

## Testing & verification

Unit (Vitest / `node --test` for backend), table-driven where one rule has many inputs:
- `backend/walk-document` tests: `validTunnels` — absent, valid, `a ≥ b`, `b` out of range, overlapping, touching, unsorted, non-integer, 501 pairs; document with/without `tunnels` round-trips through `validateWalkDocument` and `migrateLegacyDraft`.
- `backend/walks.test.mjs`: (a) `traceUrl` unset → no trace request (existing call-count tests stay green); (b) two legs, fake trace returns tunnel edges whose response shape *differs* from the input (simulated `map_snap`, extra/missing vertices) → correct global ranges, merged across the leg joint; (c) trace HTTP 500 / 400 `error_code` / malformed JSON / oversized body / hang past `TRACE_TIMEOUT_MS` → plan succeeds without `tunnels`, error codes unchanged; (d) less than 2 s of deadline left → no trace request; (e) candidate measurements do not trigger trace requests (only the final route).
- `route-legs` tests: straight route, loop walk passing a stop twice, stop at the start (cut 0), finish equal to last stop (null final leg), no stops, stop snapped 100 m off the line.
- `walk-plan` tests: `arrivalTarget` / `arrivalTriggerConfig` / `highlightedLeg` for `approach`/`stop`, first and last index, no chapters.
- `route-style` tests: `routeRuns` with/without tunnels and active range (exact coverage, no overlap, tunnel crossing the active boundary split correctly); `chevronMarks` spacing, angles for straight/turning lines, short leg, degenerate input.
- `map-view` tests: `fit(..., { keepUserView: true })` ignored after a user move, applied otherwise; plain `fit` still resets.
- `explore-map.test.ts`: panes created once; `activeLeg` toggles the dim class; covered runs get `dashArray`; extend the Leaflet mock for `createPane`/`pane`.
- `adapters` tests: `tunnels` survives draft→document→`Route`→view and is omitted when absent. Builder `model` tests: `isPlan` accepts valid and rejects invalid `tunnels`.
- `walk-session.test.ts`: meta/hint text per stage and mode.

E2E (`e2e/walk-session.spec.ts`; update existing expectations that assume autoplay):
- «Начать прогулку» → meta «Идём к остановке 1 из 2», audio element paused, `[data-route-part="active"]` present, start ring and stop 1 inside the free map area (assert positions, like the existing first-stop test), rest of the route in the dimmed pane.
- Catalog walk: after start the player shows «Слушать историю»; clicking it → «Пауза» and the highlighted leg switches to the next one; «Дальше» → meta «Идём к остановке …», nothing plays. Update the test «аудио, текст и список остановок открываются внутри панели», which currently expects «Пауза» right after start.
- `place` mode with `?replay=walk&speed=20` and a stubbed audio route: the first story starts by itself on arrival at stop 1, not at the start.
- `sequence` mode: plays immediately (regression guard).
- Local document with `route.tunnels`: a `[data-route-covered]` path has a non-empty `stroke-dasharray`; builder map shows the line at ≈0.8 pane opacity.
- Screenshots at 390×844, 1440×900 and 568×400 for the walk in progress (highlight, chevrons, dim) — attach to the PR.

Manual end-to-end with local Docker (`otgolosok-valhalla-1` on 127.0.0.1:8002): build a walk in the builder that crosses Tverskaya at Pushkinskaya (e.g. start near 55.7660, 37.6060, a stop across the street) → the underpass is dashed in the builder and in the walk. Do not call paid APIs from tests.

Before each commit: `npm run check` (or the project's lint/type-check/test scripts) and backend tests for touched backend files.

## Out of scope

- Continuous "follow me" camera, map rotation by heading.
- Distance/time to the next stop, turn-by-turn hints, an arrow from the walker to the stop.
- Distinguishing underpasses from arches (`levels`), elevator/stairs icons.
- Backfilling tunnel data for walks saved in accounts, by share link (including the boulevard walk published via the `promo-walks` account) or in browsers; an on-the-fly tunnel API.
- Changes to the legacy `ClassicWalkView` flow on `/`.
- Keeping the page alive with a locked screen between stories (existing platform limitation).

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
