# Plan: Automatic place photos from Wikidata / Wikimedia Commons in the story card

Status: implemented 2026-10-01 in branch `feat/promo-walks-stories-only`. Not done: step 0 (Wikimedia reachability from the VPS — the dev machine does not know the VPS SSH host key, so it was not checked), the production header check of step 6 (every request from the dev machine to otgolosok.online returned HTTP 505) and step 9 (rollout, on request only). See "Implementation divergences".

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

The story card on the home map ("История места", `StorySheet` in `src/features/explore/around-sheets.tsx`) already supports a photo: an 88×88 CSS px preview to the right of the title, and a native `dialog` with the full image and the author and license credit (`src/features/explore/place-photo.tsx`, documented in `docs/agents/place-photo-preview.md`). The photos come from a hand-curated **editorial catalog** of 11 Boulevard Ring places:
- `content/place-images.json` maps an exact OSM place id to two local JPEG copies in `public/images/places/`, plus author, license and Commons page;
- `place-photo.tsx` imports that JSON straight into the client bundle.

This does not scale beyond a handful of places. The bundle would grow with every entry, and each photo is added by hand.

**Goal:** every published catalog place whose OSM object links to Wikidata (directly, or through a Wikipedia article) gets that item's main image (Wikidata property **P18**) automatically. The photo is published together with the story.

**Measurements (2026-10-01):**
- Local DB `backend/data/jobs.sqlite`: 6,107 active places. 1,480 have a `wikidata` tag, 1,019 a `wikipedia` tag, 1,553 either; 73 have only `wikipedia`.
- Sample of 50 random QIDs from those places: 43 (86 %) have P18 and 40 have P373 (Commons category).
- Production had 1,461 published places on 2026-09-30. The share with `wikidata` there is unknown, so expect a few hundred to ~1,200 photos.
- The PBF has OSM `image` / `wikimedia_commons` tags on 308 selected attractions. Only ~29 `wikimedia_commons=File:…` and ~13 Commons `image` URLs belong to places **without** `wikidata`. Most `image` values are `yadi.sk` links with no license. These tags are deliberately not used (see Approved decisions).

**External APIs** (free, no keys; verified 2026-10-01):
- **Wikidata entities:** `GET https://www.wikidata.org/w/api.php?action=wbgetentities&ids=Q1|Q2|…&props=claims&format=json&formatversion=2`, up to 50 ids.
  - `entities[Q].claims.P18[]` has `rank` (`preferred`/`normal`/`deprecated`) and `mainsnak.datavalue.value`, a Commons file name without the `File:` prefix.
  - Redirected ids come back under the requested id with `redirects: {from, to}` and the target `id`. Deleted ids have a `missing` key. **Correction:** an id that never existed fails the whole request with `error.code = "no-such-entity"` and `error.id`.
- **Wikipedia → Wikidata:** `GET https://{lang}.wikipedia.org/w/api.php?action=query&prop=pageprops&ppprop=wikibase_item&redirects=1&titles=A|B|…&format=json&formatversion=2`, up to 50 titles per language.
  - The `normalized` and `redirects` arrays map input titles to page titles. `pages[].pageprops.wikibase_item` is the QID.
- **Commons file info:** `GET https://commons.wikimedia.org/w/api.php?action=query&prop=imageinfo&iiprop=url|size|mime|thumbmime|sha1|extmetadata&iiextmetadatafilter=Artist|Credit|LicenseShortName|LicenseUrl|AttributionRequired|NonFree&iiurlwidth=W&titles=File:A|File:B|…&format=json&formatversion=2`, up to 50 titles.
  - Returns `width`, `height`, `mime`, `sha1`, `descriptionurl`, `thumburl`, `thumbwidth`, `thumbheight`, `thumbmime` and `extmetadata.*.value`.
  - `Artist` and `Credit` are HTML. Example: `Artist` = `<a href="//commons.wikimedia.org/wiki/User:NVO">NVO</a>`, `LicenseShortName` = `CC BY-SA 3.0`.
  - As of 2026-10-01, `thumburl` points to `https://thumb.wikimedia.org/wikipedia/commons/thumb/…/330px-….JPG?utm_source=…`. Originals are on `https://upload.wikimedia.org/`.
- **Standard thumbnail widths** (https://www.mediawiki.org/wiki/Common_thumbnail_sizes): 20, 40, 60, 120, 250, 330, 500, 960, 1280, 1920, 3840.
  - The imageinfo API rounds a non-standard `iiurlwidth` **up** to the next standard size.
  - Direct requests for non-standard sizes are rejected.
  - `iiurlheight` does not help: the width it computes is rounded up too, which breaks a height bound.
- **Robot policy** (https://wikitech.wikimedia.org/wiki/Robot_policy):
  - Identify the bot with a User-Agent that carries contact information.
  - Action API, unauthenticated: concurrency 1 and under 5 requests/s overall. Batch requests where supported. Send `Accept-Encoding: gzip`.
  - Media (`upload.wikimedia.org`): concurrency at most 2, only originals or standard thumbnail sizes, thumbnails preferred.
  - On `429`, honor `Retry-After`.

**Constraints:**
- The production VPS is in Russia (`docs/agents/elevenlabs-region-block.md`). Reachability of the Wikimedia hosts from it must be verified first (step 0).
- Photos are served from our own origin. Viewing a card makes no request to Wikimedia: this protects privacy, keeps photos available if Wikimedia is blocked, and leaves the CSP unchanged.

## Approved decisions

1. **Self-hosted copies, not hotlinks.** The backend downloads two Wikimedia thumbnails per photo into its data directory, under content-addressed names. It serves them itself with an immutable cache, the same way as story audio. The user chose this over hotlinking `thumb.wikimedia.org` because of the Russia availability risk, user privacy (IP leak to Wikimedia), unstable thumbnail URLs and the CSP.
2. **Sizes are limited:**
   - **Preview:** width 250 px, ≤ 40 KB.
   - **Full image:** long side ≤ 960 px, ≤ 250 KB.
   - Only Wikimedia standard widths are requested. If the full file exceeds its cap, the next smaller standard width is tried (500, then 330).
   - If the preview exceeds 40 KB, or no full width fits, the place gets no photo.
3. **Scope: published places only**, meaning places with an approved story.
4. **Fully automatic.** There is no review queue, no review report and no per-photo hide command. The existing editorial catalog (11 photos) stays and **always takes precedence** over automatic photos. Editing it and deploying is the only manual override.
5. **CLI + automation.** A new place must be published *with* its photo:
   - the photo is resolved right before publication, both in the content pipeline (auto-approve) and in the manual approve endpoint;
   - a background worker handles the backlog, retries and periodic rechecks;
   - a CLI script handles backfill, forced rechecks, dry runs and pruning.
6. **Wikimedia unavailable at publication time:** the story is published without a photo. The worker retries with exponential backoff and adds the photo later. Publication is never blocked by Wikimedia.
7. **Sources:**
   - Wikidata P18 through the place's `wikidata` tag.
   - Fallback: `wikipedia` tag → `wikibase_item` → P18.
   - `subject:wikidata` is **never** used: its P18 is a portrait of the person, not the monument.
   - OSM `image` / `wikimedia_commons` tags are not used, and the OSM importer is not changed. They would add ≤ ~40 places at the cost of a reimport that changes `content_hash` and invalidates open-data matches and identity triage.
8. **Preview timing:**
   - The slim map index gets a `photo: true` flag. With it, the card reserves the preview slot with a static placeholder the moment it opens, so the title never reflows.
   - The real preview appears when the place detail (`GET /api/content/places/:id`) arrives.
   - Thumbnail URLs are *not* put in the index: hash names do not compress and would grow the compressed index by roughly a third to a half.

**Implementation defaults** (chosen by the planner; not user decisions, change only with a reason):

- **Recheck interval:** 7 days for `ready` and `none` rows. A full recheck of ~1,500 places is about 60 batched API calls, and the interval bounds how long a file deleted on Commons (e.g. for copyright) stays on our site.
- **Format:** JPEG thumbnails only (`thumbmime === "image/jpeg"`, verified by magic bytes). PNG/SVG/GIF originals, usually drawings, logos or maps, give no photo. TIFF originals have JPEG thumbnails and are accepted.
- **Minimum original size:** width ≥ 500 px.
- **Opt-in:** the env flag `PLACE_IMAGE_SYNC=true` enables all network activity in the server (worker, pipeline step, approve step). The default is off, because local test placeholders make ~6,100 places "published" and would trigger ~1,300 downloads on a dev machine. Production sets it to `true`.

## Implementation divergences

What was built differs from the steps below in these points (the steps are kept as the decision history):

- **No `maxlag`.** Wikidata counts the query-service lag in `maxlag`; on 2026-10-01 it was 9.5 s and such lag lasts for hours, so `maxlag=5` stalled the read-only sync. Requests rely on the serialized queue, the interval and the User-Agent instead. JSON-level API errors (`ratelimited`, `maxlag`, `readonly`, DB errors, malformed JSON) are retried inside the same 3-attempt loop and honor the response's `Retry-After`.
- **`no-such-entity`:** `entities()` drops the reported id and repeats the request for the rest of the chunk.
- **Identifiers:** `wikipedia` URLs on `m.wikipedia.org` hosts are accepted too.
- **Extra reasons:** `invalid_download` (the media host returned a non-JPEG, a foreign redirect or bad bytes) and `download_failed` (a deterministic HTTP error on the media host).
- **Service:** `syncPlaces(places, {signal})` processes the given places as one batch (used by the CLI `--place`). Reusing the previous files also requires both files to exist on disk; a missing file is downloaded again.
- **Worker loop:** one run calls `syncDue` repeatedly and stops when nothing was processed, any place failed, or Wikimedia paused the client.
- **Server:** `setupPlaceImages({env, store, directory, origin, logs, fetchImpl, catalogPath})` in `server.mjs` mirrors the editorial catalog and builds the service when the flag is on; `main()` only wires it. The manual approve route also catches an exception from `ensure` (logged), so approval never fails because of photos.
- **CLI:** the default mode stops when a whole batch failed (Wikimedia unreachable), so the backlog is not marked failed. It sets `process.exitCode` instead of calling `process.exit()`, which aborts with a libuv assertion on Windows while fetch sockets close.
- **nginx:** the editorial location requires the 12-hex hash: `^/images/places/[a-z0-9-]+-[0-9a-f]{12}\.jpg$`.
- **Frontend:** `MapPoint.photo` is optional (`photo?: true`), and `CatalogPoint.photo` is a boolean.
- **compose.yaml:** passes `PLACE_IMAGE_SYNC` (default `false`); production reads it from `.generator.env` through `env_file`.

## Key codebase facts

**Current photo feature**
- `src/features/explore/place-photo.tsx`:
  - imports `../../../content/place-images.json` into the client bundle;
  - `PlacePhotoHeading({placeId,title,address,titleClassName,addressClassName})` looks the photo up by `placeId`;
  - type `PlacePhoto = {src, thumbnail, width, height, alt, author, sourceUrl, license, licenseUrl}`;
  - renders `<div className={styles.heading} data-photo-heading>` with a preview `<button>` (`aria-label="Открыть фото: {title}"`) and a `<dialog>` whose credit reads `Фото: {author}. <a>Wikimedia Commons</a> · <a>{license}</a>`;
  - the preview `onError` hides the photo, and the full image has a «Повторить» retry.
- `src/features/explore/around-sheets.tsx` L51 renders `<PlacePhotoHeading key={story.id} placeId={story.placeId} …/>`.
  - L34–35: a catalog point is `story.placeId !== undefined && story.chapter === undefined && story.jobId === undefined`. Its text loads through `usePlaceStory(placeId)`, which returns `{status: "idle"|"loading"|"ready"|"missing"|"error", story?, retry}`.
  - Walk chapter pins have no `placeId` (`around-screen.tsx` L110), so they never show photos.
- `content/place-images.json` has 11 entries keyed `osm:{node|way|relation}:{id}`, each with `thumbnail`, `src` (`/images/places/<type>-<id>-<12 hex>.jpg`), `width`, `height`, `alt`, `author`, `sourceUrl`, `license`, `licenseUrl`, `retrievedAt` and `modifications`.
  - `src/features/explore/place-photo-catalog.test.ts` validates the files in `public/images/places/`: hash in the name, JPEG magic bytes, sizes under 60 KB / 1 MB.
  - `e2e/place-photo.spec.ts` imports the JSON and uses `osm:way:35814561` («Художественный»).
- No CSS currently references `data-photo-heading`; only the e2e spec does.

**Map index and detail**
- Slim index: `backend/map-cells.mjs` `toMapPoint(row)` (L26) builds `{id,lat,lon,title,address,durationSec,facts,sources}`.
  - `serializeCell` sorts points by id, and `etagOf` is the first 32 hex characters of the body's SHA-256. Cell ETags therefore change automatically when a point changes; no cache invalidation is needed.
- `backend/content-store.mjs`:
  - `MAP_POINT_SELECT` (L87–93) and `mapPoint` (L94) feed `getMapCell` (L271) and `listMapCells` (L278).
  - `getPublishedPlace(id)` (L288) returns `{...viewPlace(row), text:{id,profile,story,verification,audio,createdAt}}` and is served by `GET /api/content/places/:id` (`backend/server.mjs` L542) through `sendCacheableJson`, which computes the ETag from the body.
- Client:
  - `src/features/explore/map-cells.ts` L5 has `MapPoint` and strict parsing around L80–85, which rebuilds the point from known fields. Unknown fields are dropped, not rejected.
  - Pins are built in `around-screen.tsx` L115 and typed by `StoryPin` in `story-pin.ts`.
  - `place-story.ts` has `parsePlaceStory(value)`, which reads `value.place.text`; `loadPlaceStory` keeps a per-session LRU of 100.
- e2e: `e2e/support/map-catalog.ts` has `CatalogFixture` and `mockMapCatalog(page, places, {intercept})`. They mock the manifest, cells and detail.

**Backend conventions**
- Store:
  - SQLite `jobs.sqlite` through `node:sqlite`. Tables are created in `createContentStore` with `CREATE TABLE IF NOT EXISTS` and additive `ALTER TABLE` after `PRAGMA table_info` (L97–130).
  - `viewPlace(row)` (L56) includes `tags`.
  - `claimContentJob` returns `place: viewPlace(...)` and `identityPolicy`; `getPlace(id)` (admin) returns a place with `tags`.
  - Published means `archived=0` and an existing `place_texts` row with `approved_story_json IS NOT NULL`.
- Publication paths (all must end with a photo when one exists):
  1. **Content pipeline:** `runContentJob` in `backend/content-pipeline.mjs` calls `store.completeContentJob(job.id,{…autoApprove…})` at L150. The store auto-approves only when `requestedAutoApprove && row.identity_policy !== "weak_identity"` (content-store L537). `autoApprove` comes from `CONTENT_AUTO_APPROVE==="true"` (server.mjs L137).
  2. **Manual approval:** `POST /api/story-admin/content/places/:id/approve` → `store.approvePlaceText` (server.mjs L415–419).
  3. **Local test placeholders:** `backend/test-placeholders.mjs` marks every place without texts as published, locally only.
- `importPlaces` (content-store L196) upserts places and recomputes `content_hash` from `{name,location,geometry,tags}`.
- Files:
  - Story audio is content-addressed in `join(DATA_DIR,"audio")` and served by `GET|HEAD /api/story-audio/<64 hex>.mp3` (server.mjs L631) via `sendFile(req,res,path,type,immutable)` (L67). `immutable` sets `Cache-Control: public, max-age=31536000, immutable`.
  - `DATA_DIR` defaults to `backend/data` and is `/data` in the container.
- Workers:
  - Started in `createApp` (server.mjs L136–139), gated by `workerEnabled`, and stopped together in the shutdown path (L661). `startContentWorker` (content-pipeline.mjs L168) is the pattern to copy: `setInterval` + `wake()`, `stop()` aborts a controller and awaits running tasks.
  - `logs?.captureException` / `captureMessage` report errors.
- Retries: `backend/retry.mjs` has `fetchWithRetry(fetchImpl,url,init,options)` and `withRetry`. They honor `Retry-After` but cap any wait at `maxMs` (default 8 s), so a long Wikimedia `Retry-After` needs explicit handling (step 2).
- CLI pattern: `backend/import-open-data.mjs` lives in `backend/` so the backend image ships it. It is run with `docker exec … node import-open-data.mjs …` and opens the DB from `DATA_DIR`. The backend image copies only `backend/*.mjs` and `backend/*.json` (`backend/Dockerfile`), so `content/` is **not** in the image.
- Ops:
  - `Makefile` has `db-prune-audio` → `scripts/prune-audio.mjs`, which deletes unreferenced files older than 7 days.
  - `scripts/prod-db.mjs` dumps, imports and restores `DATA_DIR/audio` alongside the DB (L93–169); place images need the same treatment.
- `docker/nginx.conf`:
  - `/api/` forces `Cache-Control: no-store`; `/api/story-audio/` and the public map and detail locations keep the backend headers.
  - `/images/places/*.jpg` falls into `location /` and is therefore served with `no-store`, which contradicts the hashed names. In production, Traefik routes `/api/` directly to the backend and static files are deployed by the services project, so this file mainly affects the compose setup.
- CSP (`scripts/content-security-policy.mjs` L10): `img-src 'self' data: blob: https://tile.openstreetmap.org`. Same-origin images need no change.
- Service worker (`public/sw.js` L112): it does not intercept unknown same-origin routes, so `/api/place-images/…` goes to the network and the browser HTTP cache.
- Identifier parsing precedent: `backend/walks.mjs` L13 validates QIDs with `/^Q[1-9]\d{0,15}$/`.

## Implementation

### 0. Preconditions

- From the production VPS (inside the backend container), check that these hosts are reachable over HTTPS with a descriptive User-Agent:
  - `https://www.wikidata.org/w/api.php`
  - `https://ru.wikipedia.org/w/api.php`
  - `https://commons.wikimedia.org/w/api.php`
  - one `thumb.wikimedia.org` URL and one `upload.wikimedia.org` URL
- Record the result in `docs/agents/place-photo-preview.md`.
- If any host is blocked, stop and propose a proxy to the user, like `ELEVENLABS_BASE_URL`. Do not build one unasked.
- Work in the current branch (`feat/promo-walks-stories-only`) unless the user asks for a new one.

### 1. Move the editorial catalog to the backend; add the `place_images` table

- `git mv content/place-images.json backend/place-images-editorial.json`, so the backend image ships it.
  - Update the imports in `src/features/explore/place-photo-catalog.test.ts` and `e2e/place-photo.spec.ts`.
  - The JPEGs stay in `public/images/places/`.
- In `createContentStore` (`backend/content-store.mjs`), add:
  ```
  place_images(place_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,            -- 'ready' | 'none' | 'failed'
    source TEXT,                     -- 'editorial' | 'wikidata' | 'wikipedia'
    input_hash TEXT NOT NULL,        -- placeImageInputHash(tags); 'editorial' for editorial rows
    entity_id TEXT, commons_title TEXT, commons_sha1 TEXT,
    thumbnail_url TEXT, src_url TEXT, width INTEGER, height INTEGER,   -- width/height of the full copy
    author TEXT, license TEXT, license_url TEXT, source_url TEXT, alt TEXT,  -- alt: editorial rows only
    reason TEXT, attempts INTEGER NOT NULL DEFAULT 0,
    checked_at TEXT NOT NULL, next_check_at TEXT NOT NULL)
  CREATE INDEX IF NOT EXISTS place_images_due_idx ON place_images(next_check_at)
  ```
  `thumbnail_url` / `src_url` are same-origin URL paths: `/api/place-images/<sha256>.jpg`, or `/images/places/….jpg` for editorial rows.
- Add store methods to `createContentStore`, so they appear on the composed store:
  - `syncEditorialPlaceImages(catalog)`:
    - upserts one `ready` row per editorial entry: `source='editorial'`, `input_hash='editorial'`, `next_check_at='9999-12-31T00:00:00.000Z'`, plus the URLs, sizes, alt, author and license;
    - **deletes** editorial rows whose ids left the catalog, so the worker takes them over;
    - validates entries like the existing vitest catalog test and throws on a malformed catalog (startup fails loudly).
  - `getPlaceImageRow(placeId)`.
  - `savePlaceImage(placeId, fields)`: upsert that never overwrites a `source='editorial'` row.
  - `listDuePlaceImages({limit, now})`: published, unarchived places with no editorial row whose row is missing or has `next_check_at <= now`. Order: missing rows first, then `next_check_at`. Returns `{place: {id,name,tags}, row}`.
  - `markPlaceImagesDue({placeIds|null, now})`: sets `next_check_at=now` for non-editorial rows; `null` means all.
  - `listReferencedPlaceImageFiles()`: file names behind `/api/place-images/` in `thumbnail_url` / `src_url`.
- In `importPlaces`, after each upsert: `UPDATE place_images SET next_check_at=? WHERE place_id=? AND source IS NOT 'editorial' AND input_hash<>?`, with `placeImageInputHash(tags)`. A reimport that changes a place's identifiers forces a recheck.
- Map index:
  - Add `EXISTS(SELECT 1 FROM place_images i WHERE i.place_id=p.id AND i.status='ready') has_photo` to `MAP_POINT_SELECT`.
  - `toMapPoint` (`backend/map-cells.mjs`) emits `photo: true` **only** when it is set. The field is omitted otherwise, so points without photos keep their bytes. Update the JSDoc type.
- `getPublishedPlace`: add `photo` as a sibling of `text`, either `null` or `{thumbnail, src, width, height, alt, author, sourceUrl, license, licenseUrl}`.
  - `author` is `string | null`.
  - `alt` is the editorial alt, else the approved story `title`, else the place `name`.
  - Only `status='ready'` rows produce a photo.

### 2. `backend/place-images.mjs` (new): resolution, download, service, worker

Pure helpers (exported for table-driven tests):
- `PLACE_IMAGE_LIMITS = {previewWidth: 250, previewMaxBytes: 40_000, fullMaxSide: 960, fullMaxBytes: 250_000, fullWidths: [960, 500, 330], minOriginalWidth: 500, recheckMs: 7 days, retryBaseMs: 5 min, retryMaxMs: 24 h}`.
- `placeImageIdentifiers(tags) → {wikidata?: string, wikipedia?: {lang, title}}`:
  - `wikidata` counts only if the trimmed value is exactly one QID. A multi-value such as `Q1;Q2` is ignored, falling back to `wikipedia`.
  - `wikipedia` accepts `lang:Title` (lang `^[a-z][a-z-]{1,11}$`, title ≤ 255 characters) and `https://{lang}.wikipedia.org/wiki/{Title}` (URL-decoded, `_` → space).
  - `subject:wikidata` and every other key are ignored.
- `placeImageInputHash(tags)`: SHA-256 of the stable JSON of the identifiers.
- `selectP18(entity) → string | null`: the first `preferred`-rank claim with a string value, else the first `normal`; `deprecated` is ignored.
- `fullWidthsFor(width, height) → number[]`: the standard widths from `fullWidths` with `w ≤ width` and `round(w*height/width) ≤ fullMaxSide`.
  - Landscape 4000×3000 → `[960,500,330]`.
  - Portrait 3000×4000 → `[500,330]`.
  - Very tall images may give `[]`.
- `attributionFrom(extmetadata) → {author: string|null, license: string, licenseUrl: string|null, attributionRequired: boolean}`:
  - strips tags, decodes entities (`&amp; &lt; &gt; &quot; &#39; &#NNN; &#xHH; &nbsp;`), collapses whitespace and caps at 200 characters on a word boundary with `…`;
  - the author falls back from `Artist` to `Credit`.
- `rejectReason(info) → string | null`:
  - `non_free`: `NonFree` is `true`.
  - `no_license`: empty `LicenseShortName`.
  - `no_attribution`: attribution is required but there is no author.
  - `unsupported_format`: `thumbmime` is not `image/jpeg`.
  - `too_small`: width < `minOriginalWidth`.
  - `unsupported_ratio`: `fullWidthsFor` is empty.

Wikimedia client, `createWikimediaClient({fetch=globalThis.fetch, userAgent, now=Date.now, sleep, apiIntervalMs=250, mediaIntervalMs=100})`:
- **Queues:** one serialized queue for Action API calls (concurrency 1, ≥ `apiIntervalMs` between starts, under 5 req/s) and one for media downloads (concurrency 1, within the policy's limit of 2).
- **Headers:** `User-Agent: Otgolosok/1.0 (+${APP_ORIGIN}; place photo sync)`, built from the configured public origin; API calls also send `Accept-Encoding: gzip`.
- **Retries:** `fetchWithRetry` with 3 attempts for network errors and 5xx.
  - On `429` with `Retry-After` > 8 s (or missing), the client sets `pausedUntil = now + max(Retry-After, 60 s)` and throws `WIKIMEDIA_BUSY` (transient). Every call before `pausedUntil` fails fast with the same code.
  - Other 4xx are deterministic errors.
- `entities(ids, signal)`: chunks of 50; returns `Map<QID, entity>`, resolving redirects through the returned entity id.
- `wikipediaItems(lang, titles, signal)`: chunks of 50; maps every input title through `normalized`/`redirects` to its QID.
- `fileInfo(titles, width, signal)`: chunks of 50, `iiurlwidth=width`; returns `Map<"File:…", info>` and treats missing files as absent.
- `download(url, maxBytes, signal)`:
  - URL must be `https:` and its host one of `upload.wikimedia.org` / `thumb.wikimedia.org`, checked before the request and again on `response.url`;
  - response `Content-Type` must be `image/jpeg`;
  - the body is streamed with a byte cap (abort above `maxBytes`, then throw `TOO_LARGE`) and must start with `FF D8 FF`;
  - returns `{bytes, sha256}`.

Resolution and storage:
- `resolvePlaceImages(places, {client, signal}) → Map<placeId, {candidate} | {reason}>`, fully batched:
  - identifiers → `wikipediaItems` per language → `entities` → `selectP18` → `fileInfo(…, 250)` for the preview URL and metadata → `rejectReason` → `fileInfo(…, w)` grouped by the first width from `fullWidthsFor`;
  - reasons: `no_identifier`, `no_entity`, `no_p18`, `file_missing`, plus the `rejectReason` codes;
  - `candidate = {source, entityId, commonsTitle, commonsSha1, previewUrl, fullWidths, fullUrl, fullSize, author, license, licenseUrl: licenseUrl ?? descriptionurl, sourceUrl: descriptionurl}`.
- `storePlaceImage(candidate, {client, directory, signal}) → {thumbnailUrl, srcUrl, width, height}`:
  - downloads the preview (cap 40 KB; `TOO_LARGE` → reason `too_large`);
  - downloads the full image (cap 250 KB). On `TOO_LARGE` it steps down through the remaining `fullWidths`, with one extra `fileInfo` call per step; when nothing fits → reason `too_large`;
  - writes `<sha256>.jpg` atomically (temp file `.tmp-<random>` in the same directory, then `rename`), skipping existing names.

Service, `createPlaceImageService({store, client, directory, now=Date.now, logs})`:
- **`ensure(place, {signal, timeoutMs})`** — resolves one place; never throws for Wikimedia or file errors and returns the saved row.
  - **Early exits:** an editorial row returns as is. A fresh row (same `input_hash`, `next_check_at > now`) returns without any request.
  - **Abort:** it rethrows only when the *caller's* `signal` aborts. Its own `timeoutMs` expiring counts as a transient failure.
  - **Dedupe:** concurrent calls for the same place share one in-flight promise.
- **`syncDue({limit = 50, signal})`** — processes `store.listDuePlaceImages` as one batched resolution and returns counts by status and reason.
- **Outcome rules** (shared by `ensure` and `syncDue`):
  - **Success** → `status='ready'`, `attempts=0`, `next_check_at = now + recheckMs`.
  - **Skip re-download:** if the previous row is `ready` with the same `commons_sha1` and the same full width, reuse its file URLs and refresh only the metadata.
  - **Deterministic reason** (`no_identifier`, `no_p18`, `too_large`, …) → `status='none'`, `reason`, `next_check_at = now + recheckMs`. This includes a file deleted on Commons or P18 removed: the photo disappears.
  - **Transient failure** (network, 5xx, `WIKIMEDIA_BUSY`, timeout) → `attempts+1`, `next_check_at = now + min(retryMaxMs, retryBaseMs * 2**attempts)`.
    - If the previous row was `ready`, it stays `ready` with its old files. A transient error never removes a visible photo.
    - Otherwise `status='failed'`, `reason='transient'`.
- Unexpected exceptions go to `logs?.captureException(error, {operation: "placeImages", context: {placeId}})`. Retryable Wikimedia errors do not.

Worker, `startPlaceImageWorker({service, intervalMs = 60_000, logs}) → {wake, stop}`:
- Same shape as `startContentWorker`.
- At most one `syncDue` run at a time. `wake()` starts a run if idle, and the timer calls `wake()`.
- `stop()` clears the timer, aborts the controller and awaits the current run.

### 3. Server wiring (`backend/server.mjs`)

- **`main()` setup:**
  - `imageDirectory = join(directory, "place-images")`, created with `mkdir -p`.
  - Read `backend/place-images-editorial.json` (resolved next to `server.mjs`) and call `store.syncEditorialPlaceImages(catalog)` on **every** start, independent of the flag.
  - When `process.env.PLACE_IMAGE_SYNC === "true"`, build the client (User-Agent from `APP_ORIGIN`) and the service.
  - Pass `imageDirectory` and `placeImages` (the service or `null`) into `createApp`.
- **`createApp`:**
  - Start `startPlaceImageWorker` when `workerEnabled && placeImages`.
  - Add `placeImageWorker?.stop()` to the `Promise.all` at L661.
  - Pass `placeImages` into `startContentWorker` options, which forward them to `runContentJob`.
- **Public route:** `GET|HEAD /api/place-images/([a-f0-9]{64}\.jpg)` → `sendFile(req, res, join(imageDirectory, name), "image/jpeg", true)`, placed next to the story-audio route (L631). Any other name gets the router's 404.
- **Manual approve (L415):** before `store.approvePlaceText`:
  - if `placeImages`, load the place with `store.getPlace(id)` and `await placeImages.ensure(place, {timeoutMs: 15_000})`;
  - approval always proceeds afterwards, whatever `ensure` returned.
- `.env.example`: add `PLACE_IMAGE_SYNC=false` with a Russian comment («включает загрузку фото мест из Wikidata/Commons; на production — true»).

### 4. Content pipeline step (`backend/content-pipeline.mjs`)

- In `runContentJob`, directly before `store.completeContentJob` (L150), add:
  `if (autoApprove && job.identityPolicy !== "weak_identity" && placeImages) await placeImages.ensure(job.place, {signal: deadline, timeoutMs: 30_000});`
  - The condition mirrors the store's own auto-approve condition, so the photo row exists before the place becomes visible.
  - A deadline abort propagates and fails the job as `TIMEOUT`, as today. A photo timeout or failure does not stop publication.
- Retried jobs re-run the step. `ensure` is idempotent and makes no requests for a fresh row.
- Add `placeImages` to the JSDoc options type.

### 5. CLI `backend/sync-place-images.mjs` (new), Makefile, prod-db

- Usage: `node backend/sync-place-images.mjs [--dry-run] [--limit N] [--place <placeId>]... [--recheck-all] [--prune]`.
- Opens the store from `DATA_DIR` like `import-open-data.mjs` and builds the client and service. Requires `APP_ORIGIN` for the User-Agent.
- **Modes:**
  - **Default:** `syncDue` repeatedly until nothing is due or `--limit` places are done. Prints a JSON summary `{processed, ready, none: {<reason>: n}, failed, downloadedBytes}`.
  - `--dry-run`: resolution only, no downloads and no DB writes; prints the would-be statuses by reason. Useful for estimating coverage on production.
  - `--place`: marks these places due and processes only them. Each id must be published; otherwise exit 1 with a message.
  - `--recheck-all`: marks all non-editorial rows due, then processes them.
  - `--prune`: deletes `<64 hex>.jpg` files in `DATA_DIR/place-images` that `listReferencedPlaceImageFiles()` does not reference and that are older than 7 days, plus `.tmp-*` files older than 1 day. Mirrors `scripts/prune-audio.mjs`.
- **Exit codes:** 0 on success. 1 on unexpected errors or `WIKIMEDIA_BUSY`, with the pause time printed.
- **`Makefile`:**
  - `place-images: ## Подобрать и обновить фото мест из Wikidata/Commons` → `$(NODE) backend/sync-place-images.mjs $(PLACE_IMAGES_ARGS)`.
  - `place-images-prune: ## Удалить файлы фото мест без ссылок в базе` → `… --prune`.
  - Add both to `.PHONY`.
- **`scripts/prod-db.mjs`:** handle `place-images/` exactly like `audio/` in dump (rsync), import, restore backup and the info report (count missing files).

### 6. nginx (`docker/nginx.conf`)

- Add `location /api/place-images/` that keeps the backend's immutable `Cache-Control`, same body as `/api/story-audio/`.
- Add `location ~ "^/images/places/[a-z0-9-]+\.jpg$"` with `Cache-Control: public, max-age=31536000, immutable`, security headers and `try_files $uri =404`. This fixes the current `no-store` on hashed editorial photos.
- Check the production Traefik / static setup (services project, `docs/production-deployment.md`). Report to the user if production serves `/images/places/` with `no-store` too; do not change the other project unasked.

### 7. Frontend

- `src/features/explore/map-cells.ts`: `MapPoint` gains `photo: boolean`. When parsing, an absent field → `false`, `true` → `true`, any other value → the existing «Некорректная область карты.» error.
- `src/features/explore/story-pin.ts`: `StoryPin` gains `hasPhoto?: boolean`. In `around-screen.tsx` L115, set `hasPhoto: place.photo` for catalog pins.
- `src/features/explore/place-story.ts`:
  - `PlaceStory` gains `photo?: PlacePhoto`.
  - `parsePlaceStory` reads `value.place.photo`. An absent value or `null` gives no photo. A malformed value (bad path pattern, non-positive integer sizes, empty license, non-http(s) `sourceUrl`/`licenseUrl`, author not string/null) also gives no photo. It **never** fails the story.
  - Allowed paths: `^/api/place-images/[a-f0-9]{64}\.jpg$` or `^/images/places/[a-z0-9-]+\.jpg$`.
- `src/features/explore/place-photo.tsx`:
  - Export `PlacePhoto` with `author: string | null`.
  - Remove the JSON import and the `placeId` lookup.
  - New props: `{photo?: PlacePhoto; pending?: boolean; title; address; titleClassName?; addressClassName?}`.
  - `pending && !photo` → the same `.heading` wrapper with `data-photo-heading`, plus a non-interactive placeholder `<span aria-hidden="true" className={styles.placeholder} data-photo-placeholder>` with the preview box size.
  - `photo` → the current preview and dialog.
  - Otherwise → the plain heading, as today.
  - Credit with `author === null`: `Фото: <a>Wikimedia Commons</a> · <a>{license}</a>`.
- `src/features/explore/place-photo.module.css`: `.placeholder` with the `.preview` box (`flex: none`, same `clamp` size, radius) and a `var(--control-soft)` background. It is static, with no animation, so it is reduced-motion safe. Run `pnpm format:css`.
- `src/features/explore/around-sheets.tsx` L51: `<PlacePhotoHeading key={story.id} photo={catalog ? loaded.story?.photo : undefined} pending={catalog && story.hasPhoto === true && loaded.status === "loading"} …/>`. Walk chapters and own jobs pass neither prop.
- `src/features/explore/place-photo-catalog.test.ts`: point it at `backend/place-images-editorial.json`, keep its checks, and adjust the size limits to the new caps for automatic photos only if the editorial files still pass. Editorial files may keep the old limits (< 60 KB / < 1 MB).
- UI text stays in Russian.

### 8. Docs

- `docs/agents/place-photo-preview.md` (Russian): rewrite the "Источники и файлы" and "Отсутствие фото и ошибки" sections. Cover:
  - automatic sources and their priority (editorial > Wikidata P18 > Wikipedia → Wikidata);
  - size limits, storage path and URL, the `PLACE_IMAGE_SYNC` flag, the publication-time step, the worker, the recheck and backoff rules, and the CLI commands;
  - known failure modes: wrong P18 for an OSM object linked to an organization, metro station photos showing platforms;
  - that the editorial JSON is the only override.
  
  Update its line in `docs/agents/README.md`.
- `docs/production-deployment.md` (Russian): the env flag, the `/data/place-images` volume path, the first backfill command (`docker exec <backend> node sync-place-images.mjs --dry-run`, then without `--dry-run`) and the periodic prune.

### 9. Production rollout (only when the user asks to deploy)

1. Set `PLACE_IMAGE_SYNC=true` and deploy the backend.
2. Run `--dry-run` and report the coverage numbers to the user.
3. Run the backfill. The worker would also do it, but the CLI gives an immediate summary.
4. Check a few cards in a fresh browser context: placeholder → preview → dialog with credit, and the image responses have `Cache-Control: … immutable`.

## Testing & verification

Never call Wikimedia from automated tests: inject `fetch` everywhere.

- **`backend/place-images.test.mjs`** (node:test), table-driven where one rule has many inputs:
  - `placeImageIdentifiers`: valid and invalid QIDs, a multi-value `Q1;Q2` that falls back to `wikipedia`, `lang:Title`, wiki URL form, bad lang, title too long, `subject:wikidata` ignored.
  - `selectP18`: preferred, normal, deprecated-only, non-string value.
  - `fullWidthsFor`: landscape, square, 3:4 portrait, 1:3 tall, original narrower than 500.
  - `attributionFrom`: HTML artist, entities, `Credit` fallback, 200-character cap.
  - `rejectReason`: each code.
  - Client with a fake `fetch`:
    - batching splits at 50;
    - API calls are serialized;
    - the User-Agent header is set;
    - a 5xx is retried, then succeeds;
    - a `429` with `Retry-After: 120` sets the pause and fails fast afterwards;
    - a download is refused for a foreign host, for a redirect to a foreign host, for a non-JPEG content type, for bad magic bytes, and when the byte cap is exceeded mid-stream.
  - Service with a temp directory and an in-memory store:
    - happy path stores two files and a `ready` row;
    - a second `ensure` makes no requests;
    - concurrent `ensure` calls dedupe;
    - an oversized full image steps down 960 → 500;
    - an oversized preview gives `none/too_large`;
    - a changed P18 downloads the new file;
    - an unchanged `commons_sha1` reuses the files;
    - a file deleted on Commons gives `none`;
    - a transient failure on a `ready` row keeps the photo and backs off;
    - a transient failure without a photo gives `failed` with growing `next_check_at`;
    - an editorial row is never touched.
  - Worker: `wake` runs once at a time and `stop` aborts.
- **`backend/content-store.test.mjs`:**
  - `place_images` migration on an existing DB;
  - `syncEditorialPlaceImages` upserts and removes rows, and rejects a malformed catalog;
  - `listDuePlaceImages` includes only published, non-editorial, due places, missing rows first;
  - `importPlaces` marks a place due only when its identifiers change;
  - the map point has `photo: true` only for `ready` rows, and the cell ETag changes when a photo is added;
  - `getPublishedPlace` photo shape, alt fallback, `null` for `none`/`failed`.
- **`backend/content-pipeline.test.mjs`:**
  - an auto-approved job calls `ensure` before `completeContentJob`, and the photo row exists at publication;
  - a non-auto-approved or `weak_identity` job skips it;
  - an `ensure` failure or timeout still publishes;
  - a deadline abort still fails as `TIMEOUT`.
- **`backend/server.test.mjs`:**
  - `/api/place-images/<sha>.jpg`: 200 with an immutable `Cache-Control`; HEAD; 404 for a missing file; 404 for a bad name (path traversal, wrong length);
  - the detail includes `photo`;
  - manual approve with a fake service that fails or hangs past its timeout still approves;
  - with `PLACE_IMAGE_SYNC` unset, no service and no worker are created.
- **Frontend vitest:**
  - `place-story.test.ts`: photo parsing, with valid, null, absent and each malformed variant leaving the story intact.
  - `map-cells.test.ts`: the `photo` flag (absent/true/invalid).
  - The editorial catalog test with its new path.
- **e2e:**
  - Extend `CatalogFixture` in `e2e/support/map-catalog.ts` with `photo?: PlacePhoto`. The cell gets `photo: true` and the detail gets the object.
  - Update `e2e/place-photo.spec.ts` to serve the editorial entry through the mocked detail; the existing assertions remain.
  - Add: a delayed detail (via `intercept`) shows `[data-photo-placeholder]` and the title width does not change when the preview arrives.
  - Add: a flag without a photo in the detail removes the placeholder after load.
  - Add: `author: null` credit text.
  - Rerun the layout checks at 320×568, 844×390 and 1440×900 (`e2e/layout-invariants.spec.ts` and the photo spec).
- **Manual local end-to-end:** with `PLACE_IMAGE_SYNC` off, run `node backend/sync-place-images.mjs --place <2–3 real ids with wikidata>` against the local DB. This is real network, manual only. Then open those cards in the dev preview: placeholder, preview, dialog, credit, 304/immutable headers.
- **Before commit:** `pnpm check` (lint, typecheck, vitest, node tests, Python checks, build) and the affected Playwright specs.

## Out of scope

- Photos in walk chapter cards, the walk session screen and offline walk bundles. The service worker and the offline cache are unchanged.
- A moderation UI, review report or per-photo hide command; the user chose fully automatic. The editorial JSON remains the only override.
- OSM `image` / `wikimedia_commons` tags, changes to the OSM importer and a catalog reimport.
- Searching Commons by name or coordinates for places without `wikidata`/`wikipedia`, and the P18 of `subject:wikidata`.
- Galleries or multiple photos per place, and showing photos in `/admin`.
- Hotlinking, re-encoding or converting images (WebP/AVIF). Wikimedia thumbnails are stored as delivered.
- A proxy for Wikimedia. Propose one separately only if step 0 shows the hosts are blocked from the VPS.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
