# Plan: three walk access levels and a public "Top walks" ranking

Status: plan, 2026-10-01.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Account walks have two access states today: `private` (owner only) and `shared` (anyone with the `/walk?share=<token>` link). Nobody can discover other people's walks. There is no public list of user walks (`docs/agents/walks.md`: «Общего каталога пользовательских публикаций нет»), and walk launches are not counted anywhere.

We add a third level, «Доступно всем». A public walk keeps working by link, and after editorial approval it joins a public ranking, «Топ прогулок». The ranking lives on a new tab of `/history` and combines launch counts with the existing review ratings (`walk_reviews`, see `docs/agents/walk-reviews.md`). Catalog (editorial) walks and promo walks for YouTube Shorts take part in the ranking too.

No external services or paid APIs are involved.

## Approved decisions

1. **Three access levels:** «Только я» (`private`, unchanged), «По ссылке» (`shared`, unchanged) and «Доступно всем» (`public`, new). A public walk is also reachable by its share link. A draft (a walk with no built route) cannot be made public. Local guest walks (`?local=`) get no access control because they exist only in the browser.
2. **A launch** is a press of «Начать прогулку» (`TourExperience.startTour()`). Each viewer counts **at most once per walk per day**. A viewer is a signed-in account or, for guests, the device key. The owner's launches of their own walk never count. Launches are recorded for walks opened through `?catalog=` and `?share=`, which covers link-only and public walks. Recording link-only walks means a walk already has history when it goes public. `?id=` (owner) and `?local=` are never recorded.
3. **Pre-moderation for the top.** The link of a public walk works immediately. The walk enters the top only after an editor approves it in the admin. Listing states: `pending` → `approved` | `hidden`.
4. **Top members:** approved public user walks, catalog walks, and promo walks. Promo walks are created as `public` and auto-approved because the promo service is trusted. Existing promo walks (`shared`, owner `promo-walks`) are converted once to `public` + `approved`.
5. **Ranking formula:** a Bayesian-smoothed rating multiplied by `ln(1 + launches)`:
   `score = ((C × m) + Σratings) / (C + n) × ln(1 + launches)`, where `n` is the walk's count of published ratings, `m` is the global average of all published ratings (4.0 when there are none) and `C = 5`. Walks with zero launches score 0 and fall to the bottom. Ties break by launches desc, then rating count desc, then listing approval time desc, then id.
6. **Period:** launches count over all time. Daily aggregates are stored, so a time window can be added later without losing data.
7. **Placement:** two tabs on `/history`, «Мои прогулки» and «Топ прогулок». The tab is reflected in the URL (`?tab=top`). With no explicit tab, «Мои» opens, unless the viewer has no own walks (local + account), in which case «Топ» opens. The top replaces the current empty-state block «Попробуйте готовый маршрут».
8. **Top card contents:** rank, title (a link that opens the walk), the rating summary («★ 4,6 · 12 оценок» or «Пока без оценок»), and walking time, distance and stop count («45 мин · 3,2 км · 6 историй»). **No launch count and no author name** are shown, and the public API does not return them.
9. **Re-moderation on edit:** an approved public walk goes back to `pending` (and leaves the top) only when its **moderated texts** change: title, description, start/destination addresses, stop addresses, stop `transition`/`nextHint`. Rebuilding the route without changing those texts keeps it approved.
10. **Hidden is final for the owner:** an editor-hidden walk stays `hidden` whatever the owner edits or toggles, and its link keeps working. Only an editor can approve it back into the top. The owner sees «Скрыта редакцией из топа».

## Key codebase facts

- **Account walks:** `backend/account-store.mjs` `createAccountStore(db, now)` owns `user_walks(id, user_id → user ON DELETE CASCADE, title, snapshot_json, revision, created_at, updated_at, visibility TEXT DEFAULT 'private', share_token)`. The columns `visibility`/`share_token` were added by `PRAGMA table_info` + `ALTER TABLE`; follow the same pattern for new columns (there is no migration framework). A unique partial index `user_walks_share_token` exists.
- `viewWalk(row)` and `listItem(row)` (same file) return `visibility` and `shareToken` (only when `visibility === 'shared'`). **Every such check must become "shared or public"**. Grep for `'shared'`/`"shared"` across `backend/` and `src/` so that no check is missed. Known spots: `viewWalk`, `listItem`, `getSharedWalk` (`… AND visibility='shared'`), `setWalkSharing`, `backend/shared-walk-admin.mjs` (`w.visibility = 'shared'` and its partial index `user_walks_shared_updated`), `backend/promo-walks.mjs` (`walk.visibility === "shared"` in the replay path), and `src/features/walks/walk-library.tsx`.
- `setWalkSharing(userId,id,revision,enabled)`: when the revision is stale it returns the current view if the state already matches the request, otherwise throws `CONFLICT`. The first enable creates a `randomUUID()` token and later enables reuse it. Disabling sets `private` and keeps the token. Every change bumps `revision` and `updated_at`.
- `updateWalk(userId,id,{title,snapshot,revision})` normalizes through `normalizeWalk` → `validateWalkDocument` (`backend/walk-document.mjs`). The user-visible texts of a `WalkDocument` v2 are `title` (≤120), `description` (≤1000), `start.address`, `destination?.address`, `stops[].place.address` (≤180) and `stops[].transition` / `stops[].nextHint`.
- **HTTP routes** live in `backend/server.mjs`, one handler with inline routing:
  - `PUT /api/me/walks/:id/sharing` (~L179) accepts only `{revision, enabled}`. Everything under `/api/me/*` already has session, same-origin and CSRF checks.
  - `GET /api/story-walks/shared/:token` (~L571) → `accountStore.getSharedWalk`. Unknown, private, revoked or damaged walks give the same 404.
  - `GET /api/story-walks` (~L570) lists `builtinRoutes` with steps (currently one walk, `msk-kozhevniki-zindel-short`). `store.getPublishedWalk(slug)` (`backend/walk-admin.mjs` ~L490) returns the route with published chapters. `catalogWalkView(route)` (`backend/walk-catalog.mjs`) returns a validated `WalkView` whose `document.route.walkingMinutes/distanceM` and `document.stops` give the catalog card metadata.
  - The slug regex `^/api/story-walks/([a-z0-9][a-z0-9-]{0,127})$` would capture a path like `/api/story-walks/top`. That is why the top endpoint is **`/api/top-walks`**.
  - POST block (~L582): a generic `Origin === origin` and `sec-fetch-site` gate applies to all POSTs. `/api/story-walks/resolve` is handled inside it **before** the `if(!provider)` / auth checks, and new public POST routes go in the same place. PUT/DELETE are not covered by the gate.
  - Admin `/api/story-admin/*` (~L308–331) accepts an `editor` session (non-GET needs CSRF) or the legacy bearer token. `GET /api/story-admin/walks/shared` rejects unknown and duplicate query keys with 400 and calls `accountStore.listSharedWalksAdmin({limit,offset,q,author,mode})`.
  - Central error mapping: `BAD_REQUEST`→400, `CONFLICT`→409 and so on, `failure(code)` helper. `json(res,status,value)` always sends `no-store`.
- **Reviews** (`backend/walk-reviews.mjs`, `backend/walk-review-routes.mjs`): a target is `{kind:'catalog'|'account', id}`, where `id` is the slug or the `user_walks.id` UUID. A shared token resolves to the account target of the walk's UUID. The `summary(target)` SQL aggregates only `status='published'`. Guest identity comes from the `X-Review-Key` header, hashed by `guestKeyHash(key)` (SHA-256; verify the accepted key format there). `createReviewRateLimiter({limit, windowMs, maxKeys, now})` is a generic in-memory sliding-window limiter with `check(key)`; reuse it rather than writing a new one. The route module pattern `createWalkReviewRoutes({store, accountStore, origin, authSecret, limiter, json, body})` returns `public/own/admin` handlers that `server.mjs` calls. Follow it.
- **Promo walks** (`backend/promo-walks.mjs`): owner `PROMO_WALKS_USER_ID = "promo-walks"` (role `service`). The service creates the walk with `createWalk(..., {maxWalks: Infinity})` and then calls `setWalkSharing(PROMO_WALKS_USER_ID, id, revision, true)`. A replay finishes sharing when the walk is not yet shared. The module imports `account-store.mjs` only in a JSDoc type, so importing `PROMO_WALKS_USER_ID` from `account-store.mjs` creates no runtime cycle. Verify this, and if a cycle appears, move the constant to a tiny shared module.
- **Frontend:**
  - `/history` = `src/app/history/page.tsx` → `WalkLibrary` (`src/features/walks/walk-library.tsx`, styles in `history.css`). It loads local walks, account walks (`/api/me/walks`, cursor paging) and catalog cards (`loadCatalogCards`). Account cards have a «Поделиться»/«Закрыть доступ» toggle (`PUT …/sharing`, then the link is copied) and «Скопировать ссылку». Filter buttons «Все прогулки»/«Черновики» use `aria-pressed`.
  - `WalkCard.visibility` is typed `"private" | "shared"` in `src/features/walks/walk-loader.ts`.
  - `src/app/walk/page.tsx` wraps `WalkScreen` (which uses `useSearchParams`) in `<Suspense>`; follow the same pattern for `/history`. The app is a static export (`output: "export"`). Read the relevant guide in `node_modules/next/dist/docs/` about `useSearchParams` under static export before writing code (AGENTS.md).
  - `src/features/walks/walk-screen.tsx` (~L80) builds the `ReviewTarget` (`catalog`/`share`/`account`) from the query and passes it to `TourExperience`. The launch report uses the same target, but only for `catalog` and `share`.
  - `src/features/tour/tour-experience.tsx` `startTour()` (~L167) is the single entry point that starts a session and runs inside the click's user activation. Nothing slow or awaited may come before `audio.begin(...)`.
  - Review client (`src/features/reviews/`): `device.ts` `getReviewKey({create})` (`otgolosok:review-key:v1`, 32 random bytes, base64url, `null` when storage is unavailable), `api.ts` `resolveReviewer()` + `identityHeaders()` (CSRF headers for users, `X-Review-Key` for guests), `model.ts` `formatRatingSummary(summary)` and `ratingCountLabel(count)` (ru plural rules). `loadJson(url, signal, validate, attempts, payload?, init?)` in `walk-loader.ts` gives bounded retries for network errors, timeouts, 429 and 5xx. It does not retry a 429 whose `Retry-After` exceeds 5 s.
  - Walk builder save: `src/features/walk-builder/use-walk-draft.ts` `saveToAccount()` (~L302) PATCHes `/api/me/walks/:id` and shows `setMessage("Прогулка сохранена в личном кабинете.")`.
  - Admin: `src/features/admin/shared-walk-admin.tsx` (`SharedWalkAdmin`, list + filters + pagination; `WalkAdminSection` holds the tabs «По ссылке» / «Редактор глав»), with `.module.css` and a `.test.ts` jsdom harness. `admin-desk.tsx` `AdminApi` maps the `/walks…` prefix to `/api/story-admin/walks…` and sends GETs to `/walks/shared?` through `readFetch`. Use the reviews tab (`reviews-admin.tsx`) as the reference for a moderation queue with actions and a pending counter.
- **Design:** `DESIGN.md` covers Manrope text, primary controls ≥48 px and secondary ≥44 px, visible focus, and state never shown by color alone. `ReviewDialog` (native `<dialog>`) is the reference for a modal.
- **Parallel sessions** may have uncommitted edits in the same files. Commit only your own hunks and watch for CRLF.

## Implementation

### 0. Storage: access level and listing state — `backend/account-store.mjs`

- New columns on `user_walks`, added with the existing `PRAGMA table_info` + `ALTER TABLE` pattern:
  - `listing_status TEXT` — `NULL` | `'pending'` | `'approved'` | `'hidden'`. The value persists across visibility changes, so a hidden walk stays hidden after private→public toggles.
  - `listing_text_hash TEXT` — SHA-256 of the moderated texts at the moment of approval.
  - `listing_updated_at TEXT` — when the listing status last changed. It orders the moderation queue and breaks ties in the ranking.
- `visibility` gets the new value `'public'`. The DB value for link-only stays `'shared'`, so no data migration is needed. The API keeps the same strings: `"private" | "shared" | "public"`.
- Add a partial index `user_walks_public_listing ON user_walks(listing_status, listing_updated_at DESC, id DESC) WHERE visibility='public'`.
- New pure helper `moderatedTextHash(title, document)` (exported for tests). It returns the SHA-256 of a JSON array of `[title, document.title, document.description, start?.address, destination?.address, ...stops.map(s => [s.place.address, s.transition, s.nextHint])]`. Strings are `normalize("NFC")`'d; geometry, coordinates and storyRefs are excluded.
- **One-time promo backfill:** in the same branch that adds `listing_status` (so it runs exactly once), inside a transaction, for every row with `user_id = PROMO_WALKS_USER_ID AND visibility = 'shared'` with a valid snapshot: set `visibility='public'`, `listing_status='approved'`, `listing_text_hash=moderatedTextHash(...)` and `listing_updated_at=now`. Leave `revision` and `updated_at` unchanged, because this is a system migration, not an owner edit. Rows whose snapshot fails to decode are skipped and stay `shared`.
- `viewWalk` and `listItem`: `shareToken` is returned for `shared` **and** `public`. Add `listingStatus`, set only when `visibility === 'public'` (otherwise `null`), so the owner never sees a stale state of a non-public walk.
- `getSharedWalk(token)`: `visibility IN ('shared','public')`.
- New `getLaunchTarget(token)` returns `{id, userId}` for a shared/public walk with a valid snapshot, otherwise `null`. The public view never carries the owner id.
- Replace `setWalkSharing` with `setWalkVisibility(userId, id, revision, visibility, {autoApprove = false} = {})`:
  - Validation: UUID id, non-negative safe-integer revision, `visibility ∈ {'private','shared','public'}`, otherwise `BAD_REQUEST`.
  - Stale revision: return the current view if `row.visibility === visibility`, otherwise `CONFLICT` (generalizes the current behaviour).
  - `public` requires a valid snapshot with `route !== null`, otherwise throw code `WALK_NOT_READY`. Map it in `server.mjs` to 409 with the message «Сначала постройте маршрут — черновик нельзя открыть всем.».
  - Token: reuse `share_token`, or create one for `shared`/`public`. `private` keeps the token, as it does today.
  - Listing on → `public`: `hidden` stays `hidden`. With `autoApprove`, the walk becomes `approved` with the current hash. If it is `approved` and the current text hash equals `listing_text_hash`, it stays `approved`. Otherwise it becomes `pending`. Set `listing_updated_at` only when the status actually changes.
  - Leaving `public` does not touch `listing_status`.
  - Bumps `revision` and `updated_at`, as today.
- `updateWalk`: in the same UPDATE transaction, when the row is `public` + `approved` and the new `moderatedTextHash` differs from `listing_text_hash`, set `listing_status='pending'` and `listing_updated_at=now`. `pending` and `hidden` are left alone (decision 10).

### 1. Admin moderation of public walks — `backend/shared-walk-admin.mjs` + `server.mjs`

- `listSharedWalksAdmin` should include `visibility IN ('shared','public')`. Add two filters:
  - `access ∈ {all, shared, public}`, default `all`;
  - `listing ∈ {all, pending, approved, hidden}`, default `all`; it applies to public walks only.
  Each row gains `visibility` and `listingStatus`. The response gains `pending`: the total count of `public` + `pending` walks, regardless of filters, as the reviews tab does. Replace the partial index `user_walks_shared_updated` with one whose predicate is `visibility IN ('shared','public')`: drop the old index and create the new one under a new name.
- New `moderateWalkListing(id, {action, revision})`, where `action ∈ {'approve','hide'}`:
  - only `public` walks qualify; otherwise `CONFLICT`;
  - a mismatched `revision` gives `CONFLICT` with the message «Прогулка изменилась — обновите список.», so an editor never approves texts they did not see;
  - `approve` → `approved`, `listing_text_hash = current hash`; `hide` → `hidden`. Both set `listing_updated_at`, and neither changes `revision` or `updated_at`, because owners must not get edit conflicts from moderation;
  - unknown id → `null` (404).
- `server.mjs`:
  - the existing `GET /api/story-admin/walks/shared` route accepts the new `access` and `listing` keys, keeping the strict unknown/duplicate-key rule;
  - new `POST /api/story-admin/walks/shared/:id/listing` with body `{action, revision}`. Any other key → 400; it returns `{walk}` with the updated admin row or a 404.
- Admin list rows must expose `revision` so the UI can send it. Add it if it is missing.

### 2. Owner API — `server.mjs`

- `PUT /api/me/walks/:id/sharing` accepts `{revision, visibility}`. For one release it also accepts the legacy `{revision, enabled}`, so service-worker-cached clients keep working: `true` → `'shared'`, `false` → `'private'`. Mark this with a comment saying it can be removed once old clients are gone. Both shapes at once, or unknown keys → 400.
- `GET /api/me/walks` and `GET /api/me/walks/:id` already return `listItem`/`viewWalk`, so they now carry `listingStatus`.
- Promo service (`backend/promo-walks.mjs`): replace `setWalkSharing(..., true)` with `setWalkVisibility(PROMO_WALKS_USER_ID, id, revision, 'public', {autoApprove: true})`. The replay check `walk.visibility === "shared"` becomes `walk.visibility === "public"`, so a previously `shared` promo walk is made public on replay. Update the contract text in `docs/agents/promo-walks-service-api.md`.

### 3. Launch counting — `backend/walk-launches.mjs` (new) + `backend/walk-launch-routes.mjs` (new)

- Store `createWalkLaunchStore(db, {now, transaction})`, mixed into `createAccountStore` like the review store. Tables live in `auth.sqlite`:
  - `walk_launch_marks(walk_kind TEXT CHECK(walk_kind IN ('catalog','account')), walk_id TEXT, viewer_hash TEXT, day TEXT, PRIMARY KEY(walk_kind, walk_id, viewer_hash, day)) WITHOUT ROWID`, used only for deduplication;
  - `walk_launch_days(walk_kind, walk_id, day, launches INTEGER NOT NULL, PRIMARY KEY(walk_kind, walk_id, day)) WITHOUT ROWID`, the aggregates.
  - `day` is the Moscow calendar date (fixed UTC+3; Russia has no DST since 2014), computed as `new Date(now() + 3 * 3600_000).toISOString().slice(0, 10)`.
  - Like reviews, these tables have no foreign key: deleting a walk leaves orphan aggregates, which the top query ignores.
- `recordLaunch({kind, id}, viewerHash)`: in one transaction, `INSERT OR IGNORE` the mark; only if `changes === 1`, upsert `walk_launch_days` with `launches = launches + 1`. It returns `{counted: boolean}`. Prune marks with `day < yesterday` at most once per hour, using an in-memory timestamp. Marks then never hold more than about two days of pseudonymous viewer hashes.
- `launchTotals()` returns `Map<"kind:id", number>` from `SELECT walk_kind, walk_id, SUM(launches) … GROUP BY walk_kind, walk_id`.
- Viewer hash: `sha256("user:" + userId)` for sessions, and `sha256("device:" + key)` for guests with a valid `X-Review-Key`. Reuse the same key validation as `guestKeyHash`; the raw key is never stored or logged.
- Routes, in the `createWalkReviewRoutes` style: `POST /api/story-walks/:slug/launches` and `POST /api/story-walks/shared/:token/launches`. They are wired in `server.mjs` inside the POST block, next to `/api/story-walks/resolve`, before the provider/auth checks:
  - body must be `{}`; anything else → 400;
  - with a session, require a valid `X-CSRF-Token` (`validSessionCsrf`), as the review writes do;
  - target: a catalog slug resolves through `store.getPublishedWalk`; a token resolves through `accountStore.getLaunchTarget`; an unknown target gives the uniform 404 `NOT_FOUND`;
  - owner (`session.user.id === target.userId`) → `200 {counted:false}`;
  - no session and no valid key → `200 {counted:false}`; a malformed key → 400.
  - Abuse limits use two `createReviewRateLimiter` instances created in `createApp` (injectable, like `reviewLimiter`):
    - `launchLimiter` (60 per hour per `user:<id>` / `ip:<X-Real-IP>`): over the limit → 429 `RATE_LIMITED` with `Retry-After`;
    - `launchWalkLimiter` (30 per 24 h per `ip:<X-Real-IP>:<kind>:<id>`): over the limit → `200 {counted:false}`. This caps key rotation from one IP while leaving room for CGNAT crowds. Document the trade-off.
  - Response: `200 {counted}`. Never return totals.

### 4. Top ranking — `backend/walk-top.mjs` (new) + route

- Pure `rankTopWalks(candidates, {priorMean, priorWeight = 5, limit = 20})`. A candidate is `{key, ratingSum, ratingCount, launches, listedAt}`; the function returns the sorted top `limit` by the formula and tie-breaks of decision 5. Export it for table-driven tests.
- Account-store query `listTopCandidates()` returns all `public` + `approved` walks (`id, title, share_token, listing_updated_at`) with their published rating sum/count, using a `LEFT JOIN` aggregate over `walk_reviews` (`walk_kind='account'`). It also returns the global prior: `avg(rating)` over all published reviews, or 4.0 when there are none. Snapshots are **not** decoded here.
- `createTopWalks({accountStore, store, builtinRoutes})` → `list()`:
  1. Candidates are the catalog walks (`builtinRoutes` with steps whose `store.getPublishedWalk(id)` is non-null, rating from the review summary of `{kind:'catalog', id}`, `listedAt` = epoch) plus `listTopCandidates()`. Launches come from `launchTotals()`.
  2. Rank them, then decode details only for the ranked items, walking further down the list when a snapshot is damaged or has no route, so the top stays full. Public walks use `viewWalk` snapshots; catalog walks use `catalogWalkView(route).document`.
  3. Each item is `{kind: 'catalog' | 'shared', id: <slug | share token>, title, walkingMinutes, distanceM, stopCount, rating: {average, count}}`, where `average` is rounded to one decimal like the review summary.
- Route `GET /api/top-walks`: the query must be empty (otherwise 400), the response is `json(res, 200, {walks})`. It is computed per request, which is fine at the current scale. Do not add caching.

### 5. Owner UI — access dialog and history tabs

- `src/features/walks/walk-loader.ts`:
  - `WalkCard.visibility` → `"private" | "shared" | "public"`;
  - add `listingStatus?: "pending" | "approved" | "hidden" | null`.
- New `src/features/walks/access-dialog.tsx`: a native `<dialog>` modelled on `ReviewDialog`, titled «Доступ к прогулке». It holds a radio group with descriptions:
  - «Только я» — «Прогулку видите только вы.»;
  - «По ссылке» — «Открыть сможет любой, у кого есть ссылка.»;
  - «Доступно всем» — «По ссылке и в «Топе прогулок» после проверки редакцией.».
  For drafts, «Доступно всем» is disabled with the hint «Сначала постройте маршрут.». The «Сохранить» button calls `PUT …/sharing {revision, visibility}`. On success the card is updated; for `shared`/`public` the link is copied and a notice is shown («Ссылка скопирована. Прогулка появится в топе после проверки.» for a new `pending`). Errors go through `toUserMessage` inside the dialog; a 409 conflict tells the user to reload. The dialog can be closed with ✕, Escape or a backdrop click, and focus returns to the opener.
- `walk-library.tsx`:
  - replace the «Поделиться»/«Закрыть доступ» toggle with a «Доступ» button that opens the dialog (account cards only); keep «Скопировать ссылку» for `shared`/`public`;
  - each account card gets an access line that is not conveyed by color only: «Только я», «По ссылке», «Всем · на проверке», «Всем · в топе», «Всем · скрыта редакцией из топа».
- Tabs: «Мои прогулки» | «Топ прогулок» as an accessible tablist (`role="tablist"`/`tab`/`tabpanel`, `aria-selected`, arrow-key navigation, ≥44 px targets).
  - `?tab=top` selects the top. The default follows decision 7 and is applied only after own walks have loaded. A tab change updates the URL with `history.replaceState` (no navigation, no reload).
  - Wrap the page in `<Suspense>` like `src/app/walk/page.tsx` if `useSearchParams` is used.
  - The existing «Все прогулки»/«Черновики» filter and the «Новая прогулка» button stay inside the «Мои» panel.
- New `src/features/walks/top-walks.tsx` loads `/api/top-walks` through `loadJson` with a strict validator in `src/features/walks/top-model.ts`; a schema failure counts as a load error. It loads lazily on first open of the tab and renders an ordered list of cards (decision 8):
  - the rank as a visible number;
  - the title linking to `/walk?catalog=<slug>` or `/walk?share=<token>`;
  - `formatRatingSummary`, or «Пока без оценок»;
  - meta «N мин · X,Y км · K историй» with ru plural rules (`Intl.PluralRules("ru")`, as in `reviews/model.ts`).
  States:
  - loading: `role="status"`;
  - error: `role="alert"` with «Повторить»;
  - empty: «В топе пока пусто. Откройте свою прогулку всем — после проверки она появится здесь.».
- Remove the «Попробуйте готовый маршрут» block. Drop `loadCatalogCards` from the library, and delete it if it has no other users (grep first).
- `history.css` gets the tab, top-list and dialog styles, using the existing tokens (stylelint + prettier).
- Walk builder (`use-walk-draft.ts` `saveToAccount`): if the PATCH response has `visibility === "public"` and `listingStatus === "pending"`, the success message is «Прогулка сохранена. В топе она появится после проверки редакцией.».

### 6. Launch reporting on the client

- New `src/features/walks/launches.ts` `reportWalkLaunch(target, signal)` for `catalog`/`share` targets only (`launchesPath(target)` mirrors `reviewsPath`):
  - POSTs `{}` via `loadJson` with up to 3 attempts; the call is safe to retry because the server deduplicates per day;
  - sends CSRF headers for a signed-in user, otherwise `X-Review-Key` from `getReviewKey({create: true})`; with no key it sends nothing and returns;
  - reuses `resolveReviewer()` to decide session vs guest.
  Every failure is swallowed (`.catch(() => {})`) because counting must never break or delay a walk.
- `TourExperience` gets a new optional prop `launchTarget` (`ReviewTarget | null`), passed from `walk-screen.tsx` only for `catalog`/`share`. In `startTour()`, **after** `audio.begin(...)` and the phase change, fire `void reportWalkLaunch(...)` once per mounted walk; a ref guards against re-sending on resume or restart in the same page session. Abort the request on unmount.

### 7. Admin UI — `src/features/admin/shared-walk-admin.tsx`

- Rename the tab «По ссылке» to «Пользовательские». Show the pending counter in the tab title when it is above 0 («Пользовательские · 3»). Update the section description to cover link-only and public walks, including service-created ones.
- Add the filters «Доступ» (Все / По ссылке / Всем) and «Топ» (Все / На проверке / В топе / Скрытые). The «Топ» filter defaults to «На проверке» when `pending > 0`, otherwise «Все». Each row shows its access and listing state as text.
- Public rows get the actions «Одобрить для топа» (shown for `pending`/`hidden`) and «Скрыть из топа» (shown for `pending`/`approved`). They send `POST …/listing {action, revision}` through the existing `run` + CSRF path and reload the page of results after success. A 409 shows «Прогулка изменилась — обновите список.».

### 8. Docs

- Update `docs/agents/walks.md` (access levels, the moderated-text rule, launch counting and the top), `docs/agents/walk-reviews.md` (ratings now feed the top) and `docs/agents/promo-walks-service-api.md` (promo walks are public + auto-approved, one-time backfill).
- Add `docs/agents/walk-top.md`: the formula and constants, launch deduplication and limits, the CGNAT trade-off, and privacy (pseudonymous hashes, marks pruned after two days, launch counts never public). Link it from `docs/agents/README.md` with a two-sentence description.
- In `README.md` (Russian), add the three access levels and the top if the README describes walk sharing; check first.

## Testing & verification

Backend (`node --test`):
- `backend/account-store` tests (extend the existing account/user-walk tests):
  - `setWalkVisibility` transitions as a table over all from→to pairs: token reuse, `WALK_NOT_READY` for drafts, stale-revision idempotency vs `CONFLICT`;
  - hidden survives public→private→public;
  - approved survives a round-trip only with an unchanged text hash;
  - `autoApprove`.
- `updateWalk` re-moderation as a table:
  - each moderated text changed → `pending`;
  - geometry/route-only change → stays `approved`;
  - `hidden` stays `hidden`;
  - `pending` stays `pending`.
- `moderatedTextHash` is stable for equal texts and differs for each listed field.
- Promo backfill: runs once (a second store creation is a no-op), touches only `promo-walks` + `shared`, skips damaged snapshots, and keeps `revision` unchanged.
- `shared-walk-admin` tests:
  - the new filters, strict query validation and the `pending` count;
  - `moderateWalkListing` approve/hide;
  - a revision mismatch → `CONFLICT`;
  - a non-public walk → `CONFLICT`;
  - moderation does not bump `revision`.
- `walk-launches` tests:
  - deduplication per viewer/day;
  - the day boundary at the Moscow date (fake `now`);
  - pruning;
  - totals.
- Launch API tests (HTTP, like `walk-reviews-api.test.mjs`):
  - catalog and shared targets count;
  - private, revoked and unknown targets → 404;
  - the owner → `counted:false`;
  - a guest without a key → `counted:false`; a malformed key → 400;
  - a session without CSRF → 403;
  - a cross-site Origin → 403;
  - a non-empty body → 400;
  - both limiters behave as specified.
- `rankTopWalks` as a table:
  - the prior pulls a single 5★ below many 4.6★;
  - zero launches → bottom;
  - each tie-break rule;
  - the `limit`.
- `GET /api/top-walks`:
  - includes the catalog walk and approved public walks;
  - excludes pending, hidden, shared and private walks;
  - skips a damaged snapshot and backfills the next item;
  - never contains launch counts, owner ids, emails or names;
  - a query string → 400.
- Owner API: `PUT …/sharing` with `visibility`, with legacy `enabled`, with both → 400; a draft → public → 409 `WALK_NOT_READY`.
- Promo tests: new promo walks are `public` + `approved`; a replay upgrades a `shared` promo walk to `public`.

Frontend (vitest + jsdom):
- `walk-library.test.ts`:
  - the access line texts for every state;
  - the dialog opens, saves and copies the link;
  - public is disabled for drafts;
  - the default tab is «Топ» when there are no own walks and «Мои» otherwise;
  - `?tab=top` is respected.
- `top-walks` tests: validator rejects bad payloads; rank/title/href/rating/meta rendering; plural forms (1/2/5 истори-); empty, error and retry states.
- `launches` tests: catalog/share only; headers for user vs guest; no request without a key; failures are swallowed.
- `TourExperience`/walk-screen: one report per mounted walk across stop/restart, and none for `id`/`local`. Assert the request, not just that a mock was called.
- `shared-walk-admin.test.ts`: the filters, the actions per state, the pending counter in the tab title, and the 409 message.

E2E (Playwright, stubbed APIs as in `e2e/walk-session.spec.ts`): open `/history`, switch to «Топ», open a walk from the top, press «Начать прогулку» and assert one `POST …/launches`. Extend `e2e/shared-walk-admin.spec.ts` for approve/hide.

Commands before every commit: `pnpm lint`, `pnpm typecheck`, `pnpm test`, plus the relevant e2e specs. Before the final commit run the full `pnpm check`.

Manual end-to-end check on `pnpm build` + `node backend/server.mjs` (as in `walk-reviews.md`):
1. Make an account walk public and see «на проверке».
2. Approve it as an editor.
3. Launch it from another browser (guest) and see it in the top.
4. Edit its title and see it leave the top.
5. Hide it and confirm the link still opens.

## Out of scope

- Showing launch counts or author names publicly, or exposing launches in the admin.
- Time-windowed ranking (30/90 days). The daily aggregates make it possible later.
- City/mode filters, search or pagination in the top. The top is the 20 best walks.
- A public profile or author pages, and comments other than the existing reviews.
- Moderation reasons or notifications to owners about hide/approve decisions.
- Server-side caching of `/api/top-walks`.
- Removing the legacy `enabled` field from `PUT …/sharing`, which is a follow-up after old clients age out.
- Changing how link-only walks behave.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
