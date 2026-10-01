# Plan: Slim map index in 1° cells, story text on demand, layered cache

Status: implemented 2026-10-01 in branch `feat/promo-walks-stories-only` (backend `742b886`, frontend `05190dc`). Caveats: not deployed yet, so the production curl/browser checks are pending; the local end-to-end check ran on a 1,743-point test database (numbers in `docs/agents/map-viewport-loading.md`); three `прогулка / до старта` layout e2e cases fail on the base revision too and are unrelated.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The home map ("Рядом") loads catalog points through `usePublishedCatalog` → `createRegionCatalog` → `loadPublishedCatalog` (`src/features/explore/`), introduced on `main` in `ec999e8` ("загружать точки по области карты с запасом", see `docs/agents/map-viewport-loading.md`). For an arbitrary rectangle (viewport zoomed out by two steps) it pages through `GET /api/content/places?limit=100&status=ready&offset=N&west=&south=&east=&north=` until `hasMore=false`.

Problems that remain:

1. **Every point carries its full story.** Each list item is `viewPlace(row)` (tags, polygon geometry, provenance) plus the whole approved story (paragraphs, sources, facts) and audio metadata — about 4 KB per point. Measured on production: the first area is 34 places in one request on a 390×844 phone and 217 places in three requests on a 1440×1000 desktop (≈ 0.9 MB). Zooming out to the whole city pages through all 1,461 ready places: 15 requests and 8.5 MB, measured in the browser on 2026-10-01.
2. **No compression and no HTTP caching.** `json()` in `backend/server.mjs` always sends `Cache-Control: no-store` and the body uncompressed. In production Traefik routes `/api/` straight to the backend, and the repository's `docker/nginx.conf` forces `no-store` on `/api/`. Bbox URLs are unique per viewport, so they could not be cached anyway.
3. **The cache dies with the screen.** `createRegionCatalog` keeps places only until `AroundScreen` unmounts. Returning to `/`, reloading, or going offline loads everything again.
4. **The catalog will grow beyond Moscow.** Loading must stay area-based so a future city is fetched only when the map shows it.

Target: a **slim index** (position, title, address, audio duration and fact/source counts; no text) split into **fixed 1°×1° cells**. The client loads only the cells it needs, and a small **manifest** lists the non-empty cells with their ETags. The story text, sources and audio URL load **on click** from the existing `GET /api/content/places/:id`.

Caching has three layers:
- Server: ETag, `Cache-Control: no-cache` and br/gzip.
- Client memory: module-level, so it survives remounts.
- Persistent client cache: Cache Storage with stale-while-revalidate, which also works offline.

Measured slim payload (object format below, local DB with real names and addresses):

| Points | Raw | gzip | br |
|---|---|---|---|
| 1,461 (current production) | 269 KB | 44 KB | 33 KB |
| 6,107 (whole OSM catalog) | 1.19 MB | 196 KB | 140 KB |

Compressing the 6,107-point body with gzip plus br (quality 5) takes ≈ 40 ms locally, so compressed bodies are memoized by ETag.

Moscow inside the MKAD (lat 55.57–55.91, lon 37.37–37.86) is the single cell `55:37`. The whole validation region of the legacy list (lat 55.05–56.05, lon 36.75–38.25) spans cells lat {55, 56} × lon {36, 37, 38}.

**Cell boundaries in real data** (local DB, 6,107 places):
- `55:37` holds 6,075 places, `56:37` holds 20 and `55:36` holds 12.
- The 56°N line runs through Zelenograd. "Братская могила воинов РККА" (56.0004, 37.2440) and "Пионерам" (55.9986, 37.2390) are a few hundred metres apart but in different cells.
- About 100 places lie within 5 km of a cell line.

Cells are only a transport and cache unit, so a line must never be visible on the map:
- Every point belongs to exactly one cell, computed from raw coordinates.
- The client merges all loaded cells into one set of points (deduplicated by `id`).
- Clustering and the nearby radius work on that merged set, so a cluster or a radius that spans a cell line uses points from both sides.
- See the boundary rules in steps 1, 2 and 5.

## Approved decisions

1. **Slim index without text.** Each point has `id`, `lat`, `lon`, `title`, `address`, `durationSec` (null without audio), `facts` and `sources` (counts, for the nearby ranking). This is enough for marker titles (accessibility), the story sheet header and the "Рядом" recommendations without extra requests.
2. **Text on demand.** Paragraphs, source attribution and the audio URL come from `GET /api/content/places/:id` when a catalog point is opened.
3. **Area-based loading with large fixed cells, 1°×1°.** `cell = (floor(lat), floor(lon))`. This replaces arbitrary bbox rectangles and offset paging, keeps "only what the map shows" for future cities, and gives stable, cacheable URLs.
4. **Clustering stays as on `main`** (`leaflet.markercluster`, `src/features/explore/map-clusters.ts`). **Only catalog points are clusterable.** Walk chapters, the user's own generation jobs, the selected point and the picked place are always individual pins.
5. **Caching: ETag + persistent client cache + memory.**
   - Server: strong ETag, `Cache-Control: no-cache` (always revalidate, 304 when unchanged) and br/gzip.
   - Client: a module-level memory cache that survives screen remounts, plus persistent Cache Storage with stale-while-revalidate (instant on repeat visits, works offline).
   - Newly approved stories appear after one revalidation, at most `REVALIDATE_MS` = 5 min within a session and immediately on the next visit.
   - The user approved "ETag + SW + memory". The persistent layer is written by page code (Cache Storage), not by a new Service Worker route — see step 5 for the reason. The user is informed.
6. **Built on current `main`.** `origin/main` (`5b13f90`) was merged into `feat/promo-walks-stories-only` as `79337d8` on 2026-10-01.

## Key codebase facts

**Backend**
- `backend/server.mjs`:
  - `json()` (≈ L53) sets `no-store`, with no compression and no ETag.
  - The router is one `httpServer(async(req,res)=>{…})` inside `createApp`, and `authSession(auth,req)` (≈ L147) runs for **every** request before routing.
  - The public list is at ≈ L527 (`GET /api/content/places`, whitelisted params, `bounds` support).
  - The public detail is at ≈ L538–539: the regex `^/api/content/places/(osm:(?:node|way|relation):\d+)$` → `store.getPublishedPlace(id)` → `{place}` or 404 `NOT_FOUND`.
- `backend/content-store.mjs`:
  - `listPlaces` "ready" means `EXISTS(... approved_story_json IS NOT NULL)` and `archived=0`.
  - The latest approved story is `ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1` among texts with `approved_story_json IS NOT NULL`. The audio is the latest `audio_json` among approved texts, `audio_json IS NOT NULL AND audio_json<>'null'`. Reuse exactly these predicates.
  - `getPublishedPlace` (≈ L258) returns `{...viewPlace, text:{id, profile, story, verification, audio, createdAt}}`.
  - Indexes: `places_coordinates_idx ON places(lat,lon) WHERE archived=0` exists. There is **no** index on `place_texts(place_id)`, so every per-place subquery scans `place_texts`.
  - Test placeholders (`backend/test-placeholders.mjs`, local only) count as ready. Keep that parity: they give 1,743 local points for testing.
- Writes that change what the map shows:
  - `importPlaces` (archive/unarchive).
  - `completeContentJob` (auto-approve, `replaceDraft`).
  - `approvePlaceText`.
  - `acceptExternalAudio` (`backend/store.mjs`).
  - `seedTestPlaceholders`.

  ETags are computed from content, so no explicit invalidation hook is needed.
- `backend/walk-view.mjs:75` also calls `getPublishedPlace`. Do not change its return shape.

**Frontend**
- `src/features/explore/use-published-catalog.ts`:
  - Returns `{places, status, total, loaded, nearbyStatus, maintenance, retry, onViewport}`.
  - Polls `/service-status` every 5 s while visible, and auto-retries every 5 s in maintenance.
  - `isServiceMaintenance` (503 + `SERVICE_MAINTENANCE`) lives in `published-catalog.ts`.
- `src/features/explore/catalog-bounds.ts`:
  - `catalogArea(map)` → `{required, buffered}`, where required = viewport zoomed out 0.5 step and buffered = 2 steps, both Mercator-correct.
  - `nearbyBounds(center, radius)`.
- `src/features/explore/explore-map.tsx`:
  - Reports `onViewport(catalogArea(map))` on `moveend resize`, debounced 160 ms (≈ L296–304).
  - The cluster rule is `clustered = !active && item.number === undefined && !item.pending` (≈ L348). Today this also clusters the user's finished own jobs.
  - `MapItem` type ≈ L79.
- `src/features/explore/around-screen.tsx`:
  - Hook call ≈ L61.
  - Catalog → `StoryPin` mapping ≈ L115 (puts `paragraphs`, `audioUrl` and `attribution` into the pin).
  - Recommendations ≈ L118 (`place.audio && place.story`, `sourceCount`/`factCount` from array lengths, `?? 1`).
  - Catalog status notice ≈ L201 ("Загружаем места: N из M…", `<progress>`, "Повторить загрузку мест", maintenance text).
- `src/features/explore/around-sheets.tsx`:
  - `StorySheet` (≈ L28–53) renders paragraphs, attribution and `<audio>` straight from the pin.
  - `PlacePhotoHeading` uses the bundled `content/place-images.json` and is independent of the API.
- `src/features/explore/story-pin.ts`: `StoryPin` type. `nearby-stories.ts`: `NearbyStory`, `recommendNearbyStories`.
- `src/features/walk-builder/request.ts`, `request()`:
  - Bounded retries: 3 attempts, 20 s timeout, `500ms·2^n` + jitter capped at 5 s, honours `Retry-After`.
  - No retry on 4xx except 429.
  - Hard-codes `cache: "no-store"` and throws on any `!response.ok`, so a 304 cannot pass through.
  - Tests are in `request.test.ts`.

**Service Worker and proxies**
- `public/sw.js` handles only the app shell, `_next/static`, `audio/` and `/api/story-jobs|story-audio`. Unknown `/api/` routes fall through to the network.
- On activate it deletes only caches prefixed `otgolosok-`. Caches with other names (`story-packs-v1`, `walk-packs-v1`) survive app updates.
- `docker/nginx.conf`: `location /api/` hides the upstream `Cache-Control` and adds `no-store`. `location /api/story-audio/` shows the pass-through pattern.
- Production does not use this nginx for the API (`docs/production-deployment.md` ≈ L36–41).

**Legacy list consumers** (keep the endpoint as is)
- Smoke checks in `docs/production-deployment.md:311` and `docs/production-osm-tts-runbook.md:87`.
- Admin uses `/api/story-admin/content/places` (a different route).

**Existing tests touching the catalog**
- Unit and component: `src/features/explore/{around-catalog,published-catalog,region-catalog,catalog-bounds,explore-map-markers,explore-map,nearby-stories}.test.ts`.
- E2E: `e2e/map-catalog.spec.ts`; also `e2e/interface.spec.ts` and `e2e/support/scenarios.ts`, which mock `**/api/content/places?*`.
- Backend: `backend/content-store.test.mjs`, `backend/server.test.mjs`.

## Implementation

### 0. Preconditions

- Work on a branch that contains `origin/main` ≥ `5b13f90`.
- Deploy order: **backend first, then frontend**. The new frontend needs the new endpoints, and the old frontend keeps using the unchanged legacy list.

### 1. Backend: cell model (`backend/map-cells.mjs`, new, pure functions)

- `cellOf(lat, lon) → {lat, lon}`: `Math.floor` of each, clamped to lat ∈ [-90, 89] and lon ∈ [-180, 179].
- `cellKey({lat, lon}) → "55:37"`.
- `toMapPoint(row) → MapPoint`:
  - `{id, lat, lon, title, address, durationSec, facts, sources}`.
  - lat/lon rounded to 5 decimals (≈ 1 m).
  - `title` = story title if it is a non-empty string, else `place.name`.
  - `address` = `place.address ?? place.name`.
  - `durationSec` = finite positive number or `null`.
  - `facts`/`sources` = non-negative integers, 0 when absent.
- `serializeCell(cell, points) → string`: the canonical JSON `{"lat":…,"lon":…,"points":[…]}` with points sorted by `id`. This exact string is the HTTP body, so the hash is stable.
- `etagOf(body) → string`: first 32 hex chars of SHA-256. The same function is used by the HTTP helper (step 3) and by the manifest, so the manifest's per-cell etag always equals the cell endpoint's ETag.

### 2. Backend: content store queries (`backend/content-store.mjs`)

- Add `CREATE INDEX IF NOT EXISTS place_texts_place_idx ON place_texts(place_id, created_at)` next to the other indexes. It is idempotent and created on store open, like `places_coordinates_idx`.
- Add a private SQL fragment `MAP_POINT_SELECT`:
  - `p.id, p.name, p.address, p.lat, p.lon`.
  - Latest approved story `json_extract(…,'$.title')`, `json_array_length(…,'$.facts')`, `json_array_length(…,'$.sources')` (one correlated subquery returning the story JSON, then extracted in JS, is also fine).
  - Latest approved audio `json_extract(audio_json,'$.durationSec')`.
  - Same "ready" filter and same latest-row ordering as `listPlaces`.
- `getMapCell(lat, lon)`:
  - Validates integers in range; otherwise `fail("BAD_REQUEST")`.
  - Query with `p.archived=0 AND p.lat >= ? AND p.lat < ? AND p.lon >= ? AND p.lon < ?`, so it uses `places_coordinates_idx`.
  - Returns `{cell, points}`.
- `listMapCells()`:
  - One query over all ready places, grouped in JS by `cellOf`.
  - For each cell: `{lat, lon, count, etag: etagOf(serializeCell(cell, points))}`, sorted by lat then lon.
  - Never return the points themselves.

### 3. Backend: HTTP (`backend/server.mjs`, plus `backend/http-cache.mjs` if it keeps `server.mjs` readable)

- `sendCacheableJson(req, res, body: string)` (body already serialized):
  - `ETag: "<etagOf(body)>"`.
  - `If-None-Match` handling: a comma-separated list, `W/` prefixes compared weakly, `*` matches. On a match → `304` with `ETag`, `Cache-Control`, `Vary` and no body.
  - Otherwise `200` with `Content-Type: application/json; charset=utf-8`, `Cache-Control: no-cache`, `Vary: Accept-Encoding`, `X-Content-Type-Options: nosniff` and `Content-Length`.
  - Encoding negotiation from `Accept-Encoding`: `br` (BROTLI quality 5), else `gzip`, else identity. An encoding with `q=0` is refused.
  - Memoize compressed buffers in a small LRU (`Map`, 32 entries) keyed `${etag}:${encoding}`.
  - Use sync zlib (bodies ≤ ~1.2 MB; ≈ 40 ms worst case only on a cache miss). Note this in a comment; switch to async zlib only if profiling shows event-loop stalls.
- As built: `HEAD` is served by the same helper (headers only), and the strong ETag is shared by all encodings of one body.
- Routes, placed next to the public list route:
  - `GET /api/content/map-cells`:
    - Any query parameter → 400 `BAD_REQUEST`.
    - Body `{"version":1,"cellSize":1,"cells":[{lat,lon,count,etag}]}` via `sendCacheableJson`.
  - `GET /api/content/map-cells/{lat}/{lon}`:
    - Strict path regex `^/api/content/map-cells/(-?(?:0|[1-9]\d{0,2}))/(-?(?:0|[1-9]\d{0,2}))$`.
    - Reject `-0`, out-of-range values and any query parameter with 400, so every cell has exactly one URL (one cache key).
    - An empty cell is `200 {"lat":…,"lon":…,"points":[]}`.
  - `GET /api/content/places/:id`:
    - 200 responses go through `sendCacheableJson(JSON.stringify({place}))`.
    - 404 stays `json()` with `no-store`. The response shape is unchanged.
- Errors from the store propagate to the existing top-level handler (500 / mapped failures). Do not catch and swallow them in the route.
- Leave the legacy `GET /api/content/places` (including `west/south/east/north`) untouched.

### 4. nginx for Docker Compose (`docker/nginx.conf`)

- Add `location /api/content/map-cells` and `location ~ "^/api/content/places/osm:"`. They include `api-proxy.conf` and `security-headers.conf` **without** overriding `Cache-Control`, mirroring `location /api/story-audio/`.
- Add a comment explaining why: content-addressed ETags and no private data in these URLs. A cell is a 1° square, not a user location.
- Production ingress (Traefik → backend) needs no change. Verify headers after deploy (see Testing).

### 5. Frontend: transport and cell store

**`src/features/walk-builder/request.ts`**
- Extract the retry loop into `fetchWithRetry(path, signal, init?: {headers?, cache?, method?, body?}): Promise<Response>` (as built: `cache` defaults to `"no-store"`; the body is read inside the timeout and returned as a buffered `Response`, null body for 304).
- It resolves for `response.ok || response.status === 304`. Other statuses throw `RequestError`/`RejectedRequest` exactly as today.
- Rebuild `request()` on top of it with unchanged behaviour (`cache: "no-store"`, JSON parse). Existing `request.test.ts` must stay green.

**`src/features/explore/map-cells.ts`** (new), replacing `published-catalog.ts` and `region-catalog.ts`:
- Types:
  - `MapPoint` (wire format).
  - `CatalogPoint = {id, location:{lat,lon}, title, address, durationSec: number|null, facts, sources}`.
- Strict runtime validation of manifest and cell bodies. A malformed body is an error, never a partial success (as `loadPublishedCatalog` does today).
- `cellsFor(manifest, bounds: CatalogBounds): string[]`: returns the keys of **manifest cells** whose square `[lat, lat+1] × [lon, lon+1]` intersects `bounds` (edges touching count as intersecting).
  - Do not enumerate every 1° key of the bounds. `catalogArea` returns the whole world (−180…180) when the view wraps near the antimeridian, which would mean 64,800 keys. At the minimum zoom the buffered area already covers ~50 empty keys.
  - Iterating the manifest (a handful of cells) avoids both problems.
- `isServiceMaintenance`: move it here from `published-catalog.ts`.
- `CellStorage` interface: `read(url) → {etag, body}|null`, `write(url, etag, body)`.
  - Default implementation: `caches.open("map-cells-v1")`, storing a `Response` with the `ETag` header.
  - Every call is wrapped in try/catch. Unsupported API, private mode or quota errors are treated as an empty cache, never as a failure.
  - On first use, delete other caches whose name starts with `map-cells-` (schema versioning).
  - A page-level cache is used instead of an SW route because:
    - The page must show fresh data in the same session: render the cached copy, revalidate, then update the markers in place.
    - An SW stale-while-revalidate would serve one-visit-old data unless it also posted messages back.
    - Page code is unit-testable with an injected storage.
  - The SW is not changed and keeps passing these URLs through.
- `createMapCellStore({storage, fetch = fetchWithRetry, now = Date.now})`, exported as a module-level singleton `mapCellStore` so it survives `AroundScreen` remounts:
  - **Manifest**, held in memory as `{etag, cells: Map<key,{count, etag}>, checkedAt}`:
    - `ensureManifest()` uses memory if `now - checkedAt < REVALIDATE_MS` (5 min).
    - Otherwise: read storage first and publish it immediately if present, then make a conditional network request with `If-None-Match` and `cache: "no-store"`. A manually set conditional header makes the browser bypass its HTTP cache, so the page sees a raw 304.
    - 200 → validate, replace and write to storage. 304 → refresh `checkedAt`.
    - Network failure → keep the stale copy. Report an error only when nothing is available.
  - **Cells**, as built `ensureArea(...bounds)` (keys are computed inside the store via `cellsFor`, and the last 8 areas are remembered for refresh after a manifest change), for each manifest cell of the areas:
    - Memory copy with the manifest etag → done.
    - Otherwise a storage copy with the manifest etag → load into memory.
    - Otherwise fetch, conditionally if any older copy exists → validate → memory and storage.
    - If the fetched ETag differs from the manifest (race with a publish), accept the fetched body as newer and mark the manifest stale.
    - Keys not in the manifest are empty: no request.
  - Deduplicate in-flight fetches per key, and fetch at most 4 cells concurrently.
  - Shared fetches are not aborted when one screen unmounts; their results land in the cache. The hook only ignores late updates after dispose.
  - Read API: `subscribe(listener)` and `snapshot() → {points: CatalogPoint[] (union of loaded cells), manifestKeys, loadedKeys, cellStatus: Map<key, "ready"|"loading"|"error">, manifestStatus, maintenance}`, plus `revalidate()`, `retry(...bounds)` and the helper `areaStatus(snapshot, bounds)`.
  - The union is deduplicated by `id`, and the most recently fetched cell wins. When an import moves a place across a cell line, both cells change. For a moment the client may hold the new cell and the stale old one, and the place must not appear twice. Points are never filtered by cell on the client: the map and the nearby ranking always see the whole union.
  - No eviction: at most a few cells exist. Document the bound in a comment.

**`src/features/explore/use-map-catalog.ts`** (new), replacing `use-published-catalog.ts`. Same contract minus `total`/`loaded`: `{places, status, nearbyStatus, maintenance, retry, onViewport}`.
- `onViewport(area)` → `ensureArea(area.buffered)`. The buffer (two zoom steps) prefetches the neighbouring cell before the user pans across a line, so points do not pop in at the edge.
- `status`:
  - `"loading"` only while a cell intersecting `area.required` has no data at all, neither memory nor storage. Background revalidation of cached data is silent.
  - `"error"` when such a cell failed and has no copy.
  - Otherwise `"ready"`.
- Nearby: `ensureArea(nearbyBounds(center, radius))`. A radius that crosses a line loads both cells, and `nearbyStatus` stays `"loading"` until all of them are ready, so recommendations are never computed from half the circle.
- Move the `/service-status` polling and the 5 s maintenance auto-retry unchanged.
- `retry()` re-runs manifest and cell loading for the current area and nearby keys.

**Cleanup**
- Delete `published-catalog.ts`, `region-catalog.ts`, `use-published-catalog.ts` and their tests; the new tests replace them.
- Keep `catalog-bounds.ts`, and drop `containsBounds` if it becomes unused.

### 6. Frontend: story text on demand (`src/features/explore/place-story.ts`, new)

- `usePlaceStory(placeId: string | undefined)` → `{status: "idle"|"loading"|"ready"|"missing"|"error", story?: {paragraphs: string[]; attribution?: SourceAttribution; audioUrl?: string; durationSec?: number}, retry}`.
- Data: `GET /api/content/places/${id}` via `fetchWithRetry()` (as built; the id is not URL-encoded because the server route matches the raw path) with `cache: "no-cache"`. The browser HTTP cache then revalidates with the server ETag transparently, and a 304 reaches the page as the cached 200.
- Field mapping:
  - `paragraphs` ← `place.text.story.paragraphs[].text` (non-empty strings).
  - `attribution` ← `openDataAttribution(place.text.story.sources)`.
  - `audioUrl`/`durationSec` ← `place.text.audio`.
- Module-level LRU (`Map`, 100 entries): reopening a story in the session makes no request.
- Abort the request when `placeId` changes or on unmount. As built: one in-flight request per place is shared by all consumers and the abort is deferred by a microtask, so a StrictMode remount does not send a second request (found by the e2e request count in dev).
- 404 → `"missing"`: the story was unpublished after the index loaded. Also ask `mapCellStore` to revalidate the manifest.
- Other failures → `"error"` with `retry`. Transient failures are already retried inside `request()`.

### 7. UI wiring

**`around-screen.tsx`**
- Use `useMapCatalog`.
- Catalog pins become `{id, placeId: id, title, address, location, duration: durationSec ?? undefined, status: durationSec != null ? "Готово к прослушиванию" : "Текст готов", clusterable: true}`, with no `paragraphs`/`audioUrl`/`attribution`.
- Recommendations are built from points with `durationSec != null`: `{id, title, address, location, durationSec, sourceCount: sources, factCount: facts}`.
- Catalog notice:
  - Remove the "N из M" counter and the determinate `<progress>`.
  - While loading, show "Загружаем места…" with an indeterminate `<progress aria-label="Загрузка мест на карте">`.
  - Keep the error ("Не все места загрузились." + "Повторить загрузку мест") and maintenance texts as they are.

**`around-sheets.tsx` `StorySheet`**
- For catalog pins (`story.placeId` set, no `chapter`/`jobId`), call `usePlaceStory(story.placeId)`.
- Render the photo heading, title, address and metadata immediately.
- Body by state:
  - Loading: `<p role="status">Загружаем рассказ…</p>`.
  - Error: "Не удалось загрузить рассказ." + a «Повторить» button.
  - Missing: "Эта история больше недоступна."
  - Ready: paragraphs and attribution, with the audio player in the footer.
- Chapters and own jobs keep their current paths.
- Keep the existing "Проверенный текст доступен в карточке места…" text for a ready story without paragraphs.

**`story-pin.ts` / `explore-map.tsx`**
- Add `clusterable?: boolean` to `MapItem`.
- Replace the cluster rule with `clustered = item.clusterable === true && !active`.
- Creation mode maps visible pins to compact dots. Catalog dots keep `clusterable`; `creationMap.items` never set it.
- Walk maps (`walk-session.tsx`, `walk-map.tsx`) never set it, so they are unaffected.

### 8. Documentation (Russian, per repo rules)

- Rewrite `docs/agents/map-viewport-loading.md` for:
  - cells and the manifest;
  - the API contract (paths, validation, ETag/304, encodings);
  - the cache layers and `REVALIDATE_MS`;
  - deploy order and the nginx locations;
  - measured sizes.
- Update its line in `docs/agents/README.md`.
- In `docs/production-deployment.md`, add a post-deploy check: `curl -sI -H 'Accept-Encoding: br' https://otgolosok.online/api/content/map-cells` → 200 with `ETag`, `Cache-Control: no-cache`, `Content-Encoding: br`. A repeat with `If-None-Match` should give 304.

## Testing & verification

All tests use local fixtures and mocks. No external or paid API calls.

**Backend (`node --test`)**

- `backend/map-cells.test.mjs`, table-driven:
  - `cellOf`: (55.75, 37.62) → 55:37; (-0.5, -0.5) → -1:-1; (56, 38) → 56:38; (90, 180) → 89:179.
  - `toMapPoint` fallbacks: no title → name; no address → name; zero/negative/NaN duration → null; missing arrays → 0.
  - `serializeCell` order is independent of input order, and `etagOf` is stable.
- `backend/content-store.test.mjs`:
  - Only ready, non-archived places appear.
  - The latest approved story wins over an older approved one and over a newer unapproved draft.
  - Audio duration comes from the latest approved audio.
  - The lower cell boundary is inclusive and the upper exclusive.
  - A place at lat 55.999999 is served by cell 55, even though its rounded coordinate is 56.0. A place at exactly 56.0 is served by cell 56.
  - The last row and column are inclusive (lat 90 → cell 89, lon 180 → cell 179), so the manifest and the cell endpoint agree.
  - The manifest etag equals `etagOf(serializeCell(getMapCell(...)))`.
  - The etag changes after `approvePlaceText`, after audio acceptance and after archiving via a `complete` import.
  - `place_texts_place_idx` exists.
- `backend/server.test.mjs`:
  - Manifest and cell return 200 with `ETag`, `Cache-Control: no-cache` and `Vary: Accept-Encoding`.
  - 304 for an exact, `W/` or listed `If-None-Match`.
  - `br`/`gzip`/identity negotiation, and the decompressed body equals the identity body.
  - `q=0` is honoured.
  - 400 for `-0`, `055`, `1.5`, lat 90, lon -181 and any query parameter.
  - An empty cell returns `points: []`.
  - The detail endpoint returns 200 with ETag and 304, and 404 stays `no-store`.
  - The legacy `/api/content/places` responses are unchanged (existing tests).

**Frontend (Vitest)**

- `request.test.ts`:
  - Existing tests stay green.
  - `fetchWithRetry` returns a 304 without throwing, retries 5xx/429/timeouts with backoff, and does not retry other 4xx.
- `map-cells.test.ts`, with injected storage and fetch:
  - `cellsFor` is table-driven:
    - bounds inside one cell;
    - bounds straddling 56°N (Zelenograd) → both cells;
    - bounds touching a line exactly;
    - bounds with no manifest cell → none;
    - world bounds (−180…180) → only manifest cells.
  - The union is deduplicated by `id` when the same place is in two cached cells (moved across a line).
  - Manifest: served from storage and then revalidated (304); a 200 replaces it.
  - A cell is fetched only when its etag differs from the manifest.
  - Concurrent `ensureCells` calls are deduplicated, with at most 4 in flight.
  - Keys outside the manifest cause no request.
  - Storage that throws falls back to the network.
  - Offline with storage → points and `"ready"`, with no error. Offline without storage → `"error"`.
  - 503 `SERVICE_MAINTENANCE` → `maintenance`.
  - The manifest/cell etag race is accepted.
  - A malformed body is rejected.
  - The singleton keeps data across hook remounts.
- `place-story.test.ts`:
  - Field mapping, and an LRU hit makes no second request.
  - 404 → `missing` and triggers manifest revalidation.
  - Error → `retry` succeeds.
  - Changing `placeId` aborts the previous request.
- `around-catalog.test.ts` (rewrite):
  - Renders every point of a cell.
  - A remount renders immediately from memory without network.
  - Nearby recommendations come from cells, including a cell outside the viewport.
  - A nearby radius centred just south of 56°N includes a story just north of the line, and waits for both cells.
  - Opening a catalog point shows title and address immediately, then the text and the audio player.
  - The loading notice appears only without cached data.
  - Error plus retry, and maintenance auto-recovery (adapt the existing test).
- `explore-map-markers.test.ts`:
  - A catalog pin is clustered, a selected catalog pin is not, and own jobs, chapters and pending pins are not.

**E2E (Playwright)**

- In `e2e/map-catalog.spec.ts`, `e2e/interface.spec.ts` and `e2e/support/scenarios.ts`, replace the `**/api/content/places?*` mocks with manifest/cell routes and a detail route.
- Scenarios:
  - The first open makes one manifest request and one cell request (no paging).
  - With two mocked cells meeting at 56°N, a viewport over the line shows a cluster that combines points from both cells. The line is invisible: there are no separate per-cell groups. As built: covered by the store and `around-catalog.test.ts` component tests (dedup across the line, nearby radius across 56°N) instead of e2e; the e2e guest catch-all mock answers with an empty manifest.
  - A city-wide zoom-out makes no further requests within the same cell.
  - The story card shows the text after the detail response.
  - After a reload with the cell and manifest routes failing, the points still render from Cache Storage.
  - The existing cluster and keyboard scenarios pass unchanged.

**Commands and end-to-end check**

- Commands: `pnpm check`, then `pnpm test:e2e`.
- Locally, `node scripts/seed-osm-test-points.mjs` (1,743 ready placeholders) plus `pnpm build && pnpm generator:dev` (port 4175). In the browser's network panel confirm:
  - one manifest request and one or two cell requests;
  - `Content-Encoding: br` and a cell transfer of tens of KB;
  - 304 on reload;
  - the story text loading on click;
  - no JavaScript errors.

  Record the measured numbers in `docs/agents/map-viewport-loading.md`.
- After a production deploy (backend first), repeat the curl checks from step 8 and the browser check, and record them in the deployment log.

## Out of scope

- Changing or removing the legacy `GET /api/content/places` (including its bbox parameters) and the admin catalog.
- Moving public routes before `authSession`: every request still does a session lookup. Worth a separate small task.
- Offline reading of stories that were never opened, and persisting story details beyond the browser HTTP cache.
- Service Worker changes.
- Server-side clustering, vector tiles, or rendering points in the MapLibre layer.
- Adaptive cell sizes and cache eviction: revisit if a single cell exceeds ~10k points.
- Excluding test placeholders from the map (they exist only in local databases).
- Walk maps (`/walk`) and the promo-walk planner (`listWalkCandidates`).

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
