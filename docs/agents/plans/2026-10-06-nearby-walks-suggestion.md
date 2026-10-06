# Plan: «Прогулки рядом» suggestion in the walk creation sheet

Status: implemented 2026-10-06 in branch `feat/promo-walks-stories-only`. Radius changed to 500 m; see "Implementation notes" for divergences.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The walk creation sheet (`WalkCreationPanel`, `data-sheet="creation"`) shows only the
«Откуда» / «Куда» endpoints until the user builds a route. Once a start point is chosen we
want to suggest ready-made walks that start nearby, so the user can just go instead of
building a new one.

Today no API returns walk start coordinates. `/api/top-walks` is global (max 20), has no
location and rejects any query string. `/api/me/walks` has no coordinates either. Account
walk geometry lives only inside `user_walks.snapshot_json`.

## Approved decisions

1. **Radius rule:** a walk qualifies when its **start point** is within **500 m** (changed from 1000 m at the user's request during implementation)
   (haversine) of the draft's start (`w.draft.start.location`). Stops and the route line are
   not considered.
2. **Sources:** catalog walks, editor-approved public account walks (same set as the top),
   the signed-in user's own account walks (any visibility), and the guest's local walks
   (localStorage). Drafts without a built route are excluded (the card needs minutes / km).
3. **Ranking:** one combined list with the existing top formula (`rankTopWalks` /
   `topScore`). Own walks usually have 0 launches (owner launches are never counted) and sink
   to the bottom via the tie-breakers. Show at most **5** (3 in the original plan; raised at the user's request).
4. **Deduplication:** a user's own walk that is also public and approved is shown once, as
   «Ваша» (opens `/walk?id=`).
5. **Guest/local walks** are filtered on the client and only fill the slots left after the
   server items (newest `updatedAt` first). They are shown as «Ваша» too.
6. **When shown:** the start is set, the route is not built (`!built`), the panel is not in
   map-picking mode, and no endpoint picker (`picker`) is open. If there are no results, the
   block is not rendered at all (no empty state). It sits at the bottom of the sheet body.
7. **Click** opens the walk: `/walk?catalog=<slug>`, `/walk?share=<token>`, `/walk?id=<id>`
   or `/walk?local=<id>`. It does not copy the walk into the draft.
8. **Card:** title, rating (`formatRatingSummary` or «Пока без оценок»), the top meta line
   («45 мин · 3,2 км · 6 историй») plus the distance to the walk's start
   («старт в 350 м» / «старт рядом» under 50 m), and a «Ваша» label for own walks.
9. **Storage:** new columns `start_lat` / `start_lon` on `user_walks`, written on every
   snapshot write and backfilled once at startup. The query is a SQL bbox prefilter plus
   haversine, not a decode of every snapshot.
10. **Privacy:** the API never returns other users' start coordinates, launch counts or
    authors. It returns only the distance, rounded to 50 m.

## Key codebase facts

- **Panel:** `src/features/walk-builder/walk-creation-panel.tsx`.
  - Draft state comes from `useWalkDraft()` (`use-walk-draft.ts`).
  - The start is `w.draft.start?.location` (`Coordinates = {lat, lon}`, `src/features/tour/types.ts`).
  - `built = Boolean(w.draft.route) && !state.picking`.
  - `picker` is local state: `"choices" | "address" | "time" | null`.
  - Body order: endpoints → map-pick hint → stops `<details>` → `<ResearchPanel>` →
    submitting notice → storage/error/message/busy lines. The footer is pinned by `Sheet`
    (`src/features/shell/sheet.tsx`). Only the body scrolls.
- **Draft hook:** `useWalkDraft` returns `serverWalk` and `openHref` but not the local id being
  edited. That id is held in `localWalkId` (a ref) and `localIdForView` (`use-walk-draft.ts:29, 90, 345, 356`).
  The current walk must be excluded from suggestions, so the hook has to expose
  `{ kind: "account" | "local", id } | null` for it.
- **Account walks:** `backend/account-store.mjs`. Raw `node:sqlite`, with columns added by `PRAGMA table_info` +
  `ALTER TABLE` (`:78-81`, `:102-114`).
  - Snapshots are written in exactly two places: INSERT at `:169` and UPDATE at `:189`.
  - `documentOf(row)` (`:99`) decodes a row and returns null when the snapshot is damaged.
  - "Published" is defined by `listTopCandidates()` (`:234-244`):
    `visibility='public' AND listing_status='approved' AND share_token IS NOT NULL`, joined
    with the published `walk_reviews` sums.
  - `getTopDocuments(ids)` decodes only the documents that are shown.
- **Ranking:** `backend/walk-top.mjs`.
  - `rankTopWalks(candidates, {priorMean, limit})` with candidate fields `key, ratingSum, ratingCount, launches, listedAt`.
  - Launches come from `accountStore.launchTotals()`, a Map keyed by `catalog:<slug>` / `account:<id>`.
  - `createTopWalks().list()` builds catalog plus account candidates, ranks them, then decodes in batches and
    skips route-less or damaged walks. Reuse this pattern.
- **Catalog walks:** `builtinRoutes` filtered by `route.walk?.steps?.length`.
  - `store.getPublishedWalk(id)` returns the route, and its start is `route.walk.start.location`.
  - The details come through `catalogWalkView(route).document` (`backend/walk-catalog.mjs`).
- **Coordinate bbox:** coordinates are validated to Moscow, `55.48–55.98 / 37.30–37.95` (`backend/walk-document.mjs:8`).
- **Haversine helpers:**
  - SQL haversine via SQLite math functions: `backend/content-store.mjs:255-283`.
  - JS haversine: `backend/walks.mjs:14-18`.
  - Client: `distanceMeters` in `src/lib/geo/distance.ts`.
- **Routing:** routes are hand-written in `backend/server.mjs`.
  - The session is obtained via `authSession` (`:171`). Use `session?.user?.id`.
  - `/api/top-walks` is at `:627-632` and `topWalks` is created at `:166`.
- **Client models:** `src/features/walks/top-model.ts` has `TopWalk`, `validateTopWalk(s)`, `topWalkHref`,
  `formatTopWalkMeta`, `storyCountLabel`. The list UI is `top-walks.tsx` / `top-walks.module.css`.
  - `loadJson(url, signal, validate)` is in `src/features/walks/walk-loader.ts` and retries 429/5xx.
- **Local walks:** `src/features/walks/local-store.ts`.
  - `listLocalWalks(localStorage)` returns `{document, revision, updatedAt?}`. It throws on damaged storage, so catch that.
  - `document.start?.location` and `document.route` are part of `WalkDocument`.
- **Tests:**
  - Vitest: `src/**/*.test.ts`, with `// @vitest-environment jsdom` for DOM.
  - Backend: `node --test backend/*.test.mjs`. See `walk-top.test.mjs`, `walk-top-api.test.mjs` and the account-store tests.
  - Playwright: `e2e/`, with APIs mocked via `page.route("**/api/**")` in `e2e/support/scenarios.ts`.
  - `e2e/interface.spec.ts:311` asserts the creation panel height `< 430`, so mock the new endpoint as empty by default.
- **Launch accounting:** launches are counted only for `?catalog=` / `?share=` opens. Opening a suggestion goes
  through the same walk page, so no extra accounting is needed (`docs/agents/walk-top.md`).

## Implementation

### 0. Storage: start columns on `user_walks` (`backend/account-store.mjs`)
- Next to the existing column migrations, if `start_lat` is missing, run a single transaction:
  - `ALTER TABLE user_walks ADD COLUMN start_lat REAL; ADD COLUMN start_lon REAL;`
  - Backfill every row: `documentOf(row)?.start?.location`. A damaged or startless row stays NULL.
- Add `CREATE INDEX IF NOT EXISTS user_walks_start ON user_walks(start_lat,start_lon) WHERE start_lat IS NOT NULL`.
- Add a helper `startOf(normalized) → [lat|null, lon|null]`. Write both columns in the INSERT (`:169`) and the
  snapshot UPDATE (`:189`) so they never drift from `snapshot_json`.
- Add a store method `listNearbyCandidates({lat, lon, radiusM, userId})`:
  - Prefilter by bbox on the start columns.
  - Use SQL haversine (copy the expression style from `content-store.mjs`) with a filter of `≤ radiusM`.
  - Match rows that are either (a) public + approved + `share_token NOT NULL`, or (b) `user_id = userId` when
    `userId` is given.
  - Return `{id, title, shareToken, own, listedAt, updatedAt, distanceM, ratingSum, ratingCount}`. Use the same
    reviews join as `listTopCandidates`; own private walks may have 0 reviews.
- Add `getNearbyDocuments(ids, userId)`: decode the shown rows, with the same visibility/ownership condition as above.
- Keep `catalogRatings` / `priorMean` reuse. Factor the shared rating SQL out of `listTopCandidates` instead of
  duplicating it.

### 1. Ranking module (`backend/walk-nearby.mjs`, new)
- `export const NEARBY_RADIUS_M = 500; export const NEARBY_LIMIT = 5;`
- `export function createNearbyWalks({ accountStore, store, builtinRoutes })`, which returns
  `{ list({lat, lon, userId}) }`.
- **Catalog:** for each published builtin route, compute the JS haversine from `route.walk.start.location`, keep
  those `≤ 500`, and build candidates with `catalogRatings` and `launches.get("catalog:<slug>")`.
- **Account:** take `listNearbyCandidates`. Use key `account:<id>`. Set `kind` to `"own"` when `own`, else
  `"shared"`. For own walks `listedAt` falls back to `updatedAt`.
  - Deduplicate before ranking: one row per walk id, and own wins. This happens naturally if the SQL returns
    each row once with `own = user_id = ?`.
- Rank with `rankTopWalks(..., { priorMean, limit: Infinity })`. Then decode and fill up to `NEARBY_LIMIT`
  exactly like `createTopWalks().list()`, skipping route-less or damaged walks.
- **Output item:** `{kind: "catalog"|"shared"|"own", id, title, walkingMinutes, distanceM, stopCount, rating:{average,count}, startDistanceM}`.
  - `id` is the slug, the share token or the account walk id.
  - `startDistanceM = Math.round(d / 50) * 50`.
  - No coordinates, no launches, no author.
- Reuse `details()` / `catalogWalkView` from `walk-top.mjs`. Export the small helpers rather than copy them.

### 2. API endpoint (`backend/server.mjs`)
- Route: `GET|HEAD /api/walks/nearby?lat=<num>&lon=<num>`, next to `/api/top-walks`.
- **Validation:**
  - Only the `lat` and `lon` params are allowed.
  - Both must be finite numbers inside the Moscow bbox from `walk-document.mjs`. Reuse its constants; do not
    re-type the numbers.
  - Otherwise respond `400 BAD_REQUEST`.
  - Any other method gets `405` with an `Allow` header.
- If `accountStore` is missing, respond `503 {error:{code:"UNAVAILABLE", message:"Подборка прогулок временно недоступна."}}`.
- On success: `200 {walks:[...]}` with `Cache-Control: no-store` (the shared `json()` helper; stricter than the
  planned `private, no-store`), because the response depends on the session.
- Own walks are included only when `session?.user?.id` is present. Guests get public walks only.
- Unexpected errors go through the existing error handler. Never log coordinates together with the user id.

### 3. Client model (`src/features/walks/nearby-model.ts`, new)
- `type NearbyWalk = Omit<TopWalk, "kind"> & { kind: "catalog" | "shared" | "own" | "local"; startDistanceM: number }`.
- `validateNearbyWalks(value): NearbyWalk[]`:
  - Reuse the `top-model.ts` validation. Factor out the shared field checks and extend the id rule:
    - `own` uses the account walk id format. Check how ids are generated in `account-store.mjs` (`randomUUID`).
    - `local` is client-only and never accepted from the server.
  - `startDistanceM` must be a non-negative integer.
- `nearbyWalkHref(walk)`:
  - `catalog` → `?catalog=`
  - `shared` → `?share=`
  - `own` → `?id=`
  - `local` → `?local=`
  - All ids are `encodeURIComponent`ed.
- `formatStartDistance(m)`: under 50 → «старт рядом», otherwise «старт в N м» (rounded to 50).
- `localNearbyWalks(items: LocalWalkItem[], start: Coordinates, exclude: string | null): NearbyWalk[]`:
  - Keep items with a route and `distanceMeters(start, document.start.location) ≤ 500`, minus `exclude`.
  - Sort by `updatedAt` desc.
  - Map to `NearbyWalk` with `rating {average:null,count:0}` and `stopCount = document.stops.length`.
- `mergeNearby(server, local, exclude, limit = 3)`: drop the server item equal to `exclude` (an own account id),
  then fill the remaining slots with local items.

### 4. Client hook (`src/features/walk-builder/use-nearby-walks.ts`, new)
- `useNearbyWalks(start: Coordinates | null, exclude: {kind, id} | null, enabled: boolean): NearbyWalk[]`.
- On a start change, abort the previous request and `loadJson('/api/walks/nearby?lat&lon', signal, validateNearbyWalks)`.
  Coordinates are rounded to 5 decimals in the URL.
  - Use the plain fetch path, not `accountApi`: it is a GET with cookies and same-origin, no CSRF.
  - Check whether `loadJson` sends credentials and adjust if needed.
- **Failure:** the suggestion is non-critical, so on a network, validation or 5xx error after retries, show local
  walks only. No error UI. Abort is not an error.
- Read local walks with `listLocalWalks(localStorage)` inside try/catch. Damaged storage yields none, because the
  panel already reports storage errors itself.
- The hook returns `[]` while `!enabled` or there is no start, and does not fetch then.

### 5. UI (`walk-creation-panel.tsx` + `nearby-walks.tsx` + CSS module)
- Expose `editing: {kind:"account"|"local", id} | null` from `useWalkDraft`, derived from `serverWalk` / `localWalkId`.
- `const nearby = useNearbyWalks(w.draft.start?.location ?? null, w.editing, w.loaded && !built && !state.picking)`.
- Render `<NearbyWalks walks={nearby} />` as the last element of the body content, before the status/error lines,
  only when `!picker && nearby.length > 0`.
- **Component:** `<section aria-labelledby>` with the heading «Прогулки рядом» and an `<ol>` of up to 5 `Link`s.
  - Each card shows the title, the «Ваша» badge for `own` / `local`, the rating line, and
    `formatTopWalkMeta(walk) · formatStartDistance(walk.startDistanceM)`.
  - Follow `top-walks.tsx` markup and tokens. Do not import its module CSS; create `nearby-walks.module.css`.
  - Add `data-creation="nearby"` for tests.
- Text is in Russian. Check that stylelint and prettier pass on the new CSS.

### 6. Docs
- Add `docs/agents/nearby-walks.md` covering:
  - the radius rule, sources and ranking;
  - the start columns and backfill;
  - the API contract and privacy (rounded distance, no coordinates or launches);
  - local merge rules.
- List it in `docs/agents/README.md`.
- Add a one-line pointer from `docs/agents/walk-top.md`, which owns the formula.

## Testing & verification

- **Backend (`node --test`):**
  - `walk-nearby.test.mjs` with an in-memory DB, table-driven:
    - start at 499 m included, 501 m excluded;
    - private foreign walk excluded;
    - pending or hidden public walk excluded;
    - own private walk included only with a matching `userId`;
    - own public approved walk appears once, as `own`;
    - route-less or damaged walk skipped, and the next one fills its slot;
    - ranking uses launches and ratings, and own walks with 0 launches go last;
    - limit is 5;
    - `startDistanceM` is rounded to 50;
    - the response has no `lat` / `lon` / `launches` keys.
  - account-store tests:
    - INSERT and UPDATE keep `start_lat` / `start_lon` in sync with the snapshot;
    - the backfill fills existing rows once and leaves damaged rows NULL.
  - API test (pattern from `walk-top-api.test.mjs`):
    - 400 on missing, extra, non-numeric or out-of-bbox params;
    - 405;
    - 503 without `accountStore`;
    - guest vs signed-in difference;
    - the `Cache-Control` header.
- **Vitest:**
  - `nearby-model.test.ts`: validation failure cases, hrefs per kind, `formatStartDistance` boundaries (0, 49, 50, 500), local filter, exclusion, merge fill order.
  - `use-nearby-walks` / panel jsdom test:
    - the block appears with a start and results;
    - it is hidden while picking, with a picker open, after build, and on an empty result;
    - a fetch failure falls back to local walks;
    - a start change aborts the previous request.
- **e2e:**
  - Mock `/api/walks/nearby` with `{walks: []}` by default in `e2e/support/scenarios.ts`, so existing height
    assertions stay valid.
  - Add one scenario in `interface.spec.ts`: set a start, check that 3 cards render inside the sheet body and that
    clicking one navigates to `/walk?catalog=…`.
  - Run the `layout-invariants` spec, because the body grows.
- Run `npm run check` (lint, typecheck, test, build) and the relevant e2e specs before committing.
- **Manual:** run the dev server, choose a start near a catalog walk, and confirm the block and its navigation.
  Confirm the block disappears after «Построить прогулку».

## Out of scope

- Markers of suggested walks on the map.
- Matching by stops or the route line, or a configurable radius.
- Copying a suggested walk into the builder.
- Caching or precomputing the nearby ranking, and rate limiting beyond existing infrastructure.
- Changes to `/api/top-walks` or to launch accounting.
- Suggestions on screens other than the creation sheet.

## Implementation notes (divergences)

- Radius is **500 m**, not 1000 m, and the limit is **5**, not 3 (user requests during implementation). The client keeps a copy of the constant in
  `nearby-model.ts` for local walks.
- The bbox constants are exported from `walk-document.mjs` as `WALK_BOUNDS` / `inWalkBounds`; the JS haversine is
  the exported `distance` from `backend/walks.mjs`; `walk-top.mjs` exports `walkDetails`, `catalogDetails`,
  `ratingSummary`, `CATALOG_LISTED_AT`.
- The SQL bbox prefilter uses meters-per-degree of the same sphere as the haversine. The `111320` constant copied
  from `content-store.mjs` made the box ~0.1 % too small and dropped starts right at the radius edge.
- Cards also show where the walk ends under the title (user request): the API item has `finish` — the destination
  or last stop address of an open walk, `null` for a loop. The block is a collapsed `<details>` (user request).
- Without a chosen start, if geolocation access is already granted, the device position (one coarse fix, no permission
  prompt, accuracy ≤ 500 m, inside Moscow) is used and the block is titled «Близко к вам» (user request).
- `NearbyWalks` renders after the submitting notice (last content element, before the status/error lines).
- Account-store column/backfill tests live in `backend/walk-nearby.test.mjs`; API tests in
  `backend/walk-nearby-api.test.mjs`; hook and panel jsdom tests in `src/features/walk-builder/nearby-walks.test.ts`.
- e2e: no separate default mock was added — the existing catch-all `**/api/**` mocks already answer
  `{walks: []}` (or an invalid shape, which falls back to no local walks), so the block stays hidden.
- `layout-invariants`: 3 chromium cases «прогулка / … / 568×320» report a KNOWN_LAYOUT_FAILURES entry as already
  fixed; they concern the walk screen, not the creation sheet, and are not caused by this change.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
