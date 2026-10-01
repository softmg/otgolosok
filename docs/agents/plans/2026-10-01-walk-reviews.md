# Plan: walk reviews (5-star rating and text)

Status: implemented 2026-10-01 in branch `feat/promo-walks-stories-only`. Caveat: the manual end-to-end check published the guest review directly in SQLite instead of clicking through `/admin?section=reviews` as an editor (no editor account in the local DB); the admin tab is covered by component and HTTP tests. Full `pnpm test:e2e`: 497 passed, 2 failed — `layout-invariants` «прогулка / до старта» 320×568 (chromium, webkit, overlap of map controls and sheet); the same failure reproduces on `39d848b`, before this plan, so it is not caused by reviews.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Walkers have no way to say how a walk went. We add reviews: a required 1–5 star rating plus an optional text. Reviews are public on the walk screen (average rating and the texts), and anyone can leave one, guests included. Most traffic to promo walks comes from YouTube Shorts share links, and those visitors are usually not signed in.

Current behavior:
- `/walk` (`src/features/walks/walk-screen.tsx`) opens four kinds of walks: `?catalog=<slug>` (editorial catalog, `GET /api/story-walks/:slug/view`), `?share=<token>` (shared account walk, promo walks included, `GET /api/story-walks/shared/:token`), `?id=<uuid>` (own account walk, `GET /api/me/walks/:id/view`) and `?local=<id>` (guest walk that exists only in `localStorage`).
- All of them render through `TourExperience` (`src/features/tour/tour-experience.tsx`) in "universal" mode → `WalkSession` (`src/features/tour/walk-session.tsx`). Pressing "Завершить" on the last stop calls `onStop(true)`, and the panel then shows the heading "Прогулка завершена" with a single "На карту" link. Closing with the header ✕ navigates away without that screen.
- No review, rating or feedback storage exists anywhere.

No external services or paid APIs are involved.

## Approved decisions

1. **Public reviews.** The walk screen shows the average and count of published ratings, plus a list of published reviews that have text.
2. **Anyone can review, guests included.** Signed-in users are identified by their account. A guest is identified by a random device key kept in `localStorage`. Abuse is limited by the same-origin check, CSRF for sessions, a per-IP/per-account write limit and one review per walk per account or device.
3. **Reviewable walks:** catalog, shared (including promo) and own account walks, which are all walks the server knows. Local guest walks (`?local=`) get no review UI.
4. **Where the form appears:** inline on the "Прогулка завершена" screen. A "Оценить прогулку" entry in the walk settings drawer covers people who stopped early or come back later.
5. **Text pre-moderation.** A rating without text is published immediately and counts in the average. A review with text is `pending` until an editor approves it; while pending it is neither shown nor counted. An editor can hide any review, which removes its rating from the average too.
6. **Author name:** the account `user.name` for signed-in authors and «Гость» for guests. The form has no extra fields. Email is never exposed publicly.
7. **Average shown from the first published rating.**
8. **The author can edit and delete their own review.** There is one review per (walk, account) or (walk, device key). Re-submitting updates it, and changed text goes back to moderation. A guest can manage their review only from the same browser.
9. **Storage:** a new table `walk_reviews` in `auth.sqlite`, the account database next to `user` and `user_walks`. Reviews are cascade-deleted with their author's account.
10. **Walk deleted or sharing revoked:** reviews are kept. They disappear publicly (the walk is no longer reachable) but stay in the admin with a title snapshot. Re-enabling the same share link brings them back.
11. **Admin:** a new top-level admin tab «Отзывы». By default it shows the «На модерации» queue with a counter. Filters cover status, rating and walk title, and the actions are «Опубликовать», «Скрыть» and «Удалить».
12. **"Оставить отзыв"/"Оценить прогулку" visibility:** only after the walk was started at least once in this browser (a `localStorage` marker), or when the viewer already has a review. This is a UX filter against drive-by ratings, not a security control: the server does not verify it. The public list is always visible.
13. **Text limit:** 1000 characters (Unicode code points, after normalization). Text is optional; the rating is required.
14. **List contents:** only published reviews with non-empty text. The summary counts all published ratings, e.g. «★ 4,6 · 12 оценок».
15. **Write limit:** 20 review writes (PUT + DELETE) per hour per account (`user:<id>`) or, for guests, per client IP (`ip:<X-Real-IP>`). The limiter lives in process memory. Over the limit the server answers 429 with `Retry-After`. Rejected writes do not consume the budget.

## Key codebase facts

- **HTTP server:** `backend/server.mjs` `createApp(...)` is a single `httpServer` handler with inline routing. Helpers `json(res,status,value)` (always `Cache-Control: no-store`) and `body(req,maxBytes=2048)` (JSON only, rejects arrays, oversize → `failure("BAD_REQUEST")`) are module-private. Errors are mapped centrally in the `catch` at the end of the handler (`BAD_REQUEST`→400, `CONFLICT`→409, `QUOTA_EXCEEDED`→429, unknown→500 and `logs?.captureException`).
- **`/api/me/*` block (`server.mjs` ~L153–183):** requires a session and `accountStore`. It checks `Origin` against `origin` and rejects `sec-fetch-site: cross-site`. For every non-GET/HEAD request it requires `X-CSRF-Token` validated by `validSessionCsrf(authSecret, session.session.id, …)` from `backend/auth.mjs`. New account-walk review routes go inside this block.
- **Generic POST gate (`server.mjs` ~L582):** only `POST` requires `Origin===origin` and `sec-fetch-site ∈ {undefined,"same-origin","none"}`. **PUT/DELETE on public routes are not covered**, so the review routes must enforce this themselves.
- **Public walk routes (`server.mjs` ~L554–566):** `publishedWalk` regex `^/api/story-walks/([a-z0-9][a-z0-9-]{0,127})$`, `sharedWalk` `^/api/story-walks/shared/(UUID)$` (404 when `!walk || walk.snapshotError`), `catalogView` `…/view$` → `store.getPublishedWalk(slug)` (implemented in `backend/walk-admin.mjs` ~L490 and mixed into the store). New `/reviews` sub-paths do not collide with these regexes.
- **Client IP:** `/api/walk-plan` uses `String(req.headers["x-real-ip"] ?? req.socket.remoteAddress ?? "")`. nginx overwrites `X-Real-IP` (`docker/api-proxy.conf`), and the `location /api/` in `docker/nginx.conf` already proxies any new `/api/*` route with `no-store` and `client_max_body_size 128k`. The README explains the shared-IP caveat behind an extra proxy.
- **Account DB:** `backend/account-store.mjs` `createAccountStore(db, now=Date.now)` runs `PRAGMA foreign_keys = ON` and `CREATE TABLE IF NOT EXISTS …` at startup; these are the migrations, there is no migration framework. It has a nested-safe `transaction(fn)` helper (`BEGIN IMMEDIATE`) and the cursor helpers `cursor()`/`page()` (base64url `{time,id}` keyset). It spreads in `createSharedWalkAdminStore(db, viewWalk)` from `backend/shared-walk-admin.mjs`, which registers the SQLite function `walk_search(value)` (NFKC + ru lowercase) used for admin title search.
- **Account data:** `user_walks(id, user_id → user ON DELETE CASCADE, title, snapshot_json, revision, created_at, updated_at, visibility 'private'|'shared', share_token)`. `getSharedWalk(token)` returns `viewWalk(row)` (with `title`, `revision`, `snapshotError?`). `getWalk(userId,id)` is owner-scoped. `deleteAccountData(userId)` deletes the `user` row and relies on cascades.
- **Auth DB connection:** `createAuth` in `backend/auth.mjs` returns `accountDatabase`, a separate connection to `auth.sqlite` with `foreign_keys=ON`. `user` has `id, name, email, role, …`. The promo owner `promo-walks` has role `service` and no credential account.
- **Admin API:** `/api/story-admin/*` (`server.mjs` ~L308) allows an `editor` session, whose non-GET calls need CSRF, or the legacy bearer token. Responses use `json`. Validation follows the pattern "unknown or duplicate query keys → 400" (see `/api/story-admin/walks/shared`).
- **Admin UI:** `src/features/admin/admin-desk.tsx` has `type AdminSection = "addresses"|"walks"|"content"|"drafts"` (L15), the tab buttons (~L307–312) and the deep link `?section=` (~L205, an allow-list array). `api: AdminApi` (L121) maps `path` to `/api/story-admin…` by prefix (`/walks`, `/content/`, otherwise `/jobs`). It uses only GET (no body) or POST (with body + `csrfHeaders()`) and `readFetch` for `/walks/shared?` GETs. Follow `src/features/admin/shared-walk-admin.tsx` (+ `.module.css`, `.test.ts` with a jsdom harness around `AdminRun`) for list, filter and pagination UI.
- **Client fetch helpers:** `src/features/walks/walk-loader.ts` `loadJson(url, signal, validate, attempts=3, payload?)` does bounded retries (network, timeout, 408/429/5xx, `Retry-After` capped at 5 s, jitter, 20 s per attempt) and exports `WalkLoadError(message,status,retryable,retryAfterMs)`. It only does GET or POST. `src/features/auth/client.ts` exports `getSession()` (stores the CSRF token in `sessionStorage`), `csrfHeaders()` and `accountApi`. `src/lib/errors/user-message.ts` `toUserMessage(error, fallback)` converts errors to Russian UI text.
- **Service worker (`public/sw.js`):** handles only GET, passes through unknown `/api/*` paths and never caches `/api/me/*`. New review endpoints are therefore network-only. No change needed.
- **WalkSession:** a presentational component that receives `player`, `story` and `settings` as `ReactNode` slots. Its local `drawer` state is `"stops"|"story"|"settings"|null`. The drawer body is `.walk-session-drawer` (max-height 26dvh, scrolls). The settings button and drawer are hidden when `completed`. Tests: `src/features/tour/walk-session.test.ts` (static markup, `ExploreMap` mocked) and `e2e/walk-session.spec.ts`.
- **Started marker inputs:** `TourExperience.startTour()` is the single entry point that starts a session; `stopTour(true)` marks completion.
- **localStorage conventions:** keys are prefixed `otgolosok:` (e.g. `otgolosok:walks:v2`, `otgolosok:walk-settings`). Storage access may throw (private mode or quota), so wrap it.
- **E2E stubs:** most scenarios route `**/api/**` to a generic `{ user: null }` JSON (`e2e/support/scenarios.ts`, `e2e/walk-session.spec.ts`). The reviews client must treat a schema-invalid response as "reviews unavailable" and must not break the walk screen.
- **Design:** `DESIGN.md` requires Manrope UI text, the 18/16/14/12 px scale, primary controls ≥48 px and secondary ≥44 px, visible focus, inline confirmation for irreversible actions, and state not conveyed by color alone. The walk panel uses `#203e38` text and the `#b64b28` primary button (`src/features/tour/walk-session.css`).
- **Parallel sessions:** other sessions may have uncommitted edits in `walk-session.tsx` and `e2e/walk-session.spec.ts`; there were some on the plan date. Commit only your own hunks.

## Implementation

### 0. Domain module and storage — `backend/walk-reviews.mjs` (new)

Pure helpers (exported, unit-tested):
- `REVIEW_TEXT_MAX = 1000`, `REVIEW_PAGE_SIZE = 20`.
- `normalizeReviewText(value)` takes `undefined`, `null` or a string; anything else → `BAD_REQUEST`. It applies NFC, converts `\r\n?` to `\n`, removes `\p{Cc}` except `\n` and all `\p{Cf}` (bidi overrides, zero-width), trims each line's trailing spaces, collapses 3+ newlines to 2 and trims the whole text. If the result is longer than `REVIEW_TEXT_MAX` code points (`[...text].length`) → `BAD_REQUEST`. `<`/`>` are allowed (React escapes output), so «<3» survives.
- `validateRating(value)` accepts only an integer 1–5, otherwise `BAD_REQUEST`.
- `nextReviewStatus(previous, nextText)` is the moderation state machine. The table:
  - no previous: `text === ""` → `published`, else `pending`;
  - previous `hidden` → stays `hidden` (the editor's decision sticks, and the author can still delete);
  - `nextText === ""` → `published`;
  - `nextText === previous.text && previous.status === "published"` → `published` (rating-only change);
  - otherwise → `pending`.
- `guestKeyHash(key)` checks `key` against `/^[A-Za-z0-9_-]{43}$/` (32 random bytes, base64url), else `BAD_REQUEST`, and returns the SHA-256 hex. The key is high-entropy, so no HMAC is needed. The raw key is never stored or logged.
- `createReviewRateLimiter({ limit = 20, windowMs = 3_600_000, maxKeys = 10_000, now = Date.now })` returns `{ check(key) → { allowed: true } | { allowed: false, retryAfterSec }, record(key) }`. It is a sliding window of timestamps per key; `record` is called only after a successful write. When `maxKeys` is reached, keys with no timestamps inside the window are pruned first; if the map is still full, the oldest-inserted key is evicted. Memory stays bounded, and the limit resets on restart (documented).

Store, `createWalkReviewStore(db, { now, transaction })`, spread into the object returned by `createAccountStore` (pass the existing `transaction` helper):
- Schema (inside `db.exec` at creation):
  - `walk_reviews(id TEXT PRIMARY KEY, walk_kind TEXT NOT NULL CHECK(walk_kind IN ('catalog','account')), walk_id TEXT NOT NULL, walk_title TEXT NOT NULL, walk_revision INTEGER NOT NULL, user_id TEXT REFERENCES user(id) ON DELETE CASCADE, guest_key_hash TEXT, rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5), text TEXT NOT NULL DEFAULT '', status TEXT NOT NULL CHECK(status IN ('pending','published','hidden')), created_at TEXT NOT NULL, updated_at TEXT NOT NULL, moderated_at TEXT, moderated_by TEXT, CHECK((user_id IS NULL) <> (guest_key_hash IS NULL)))`.
  - Partial unique indexes on `(walk_kind, walk_id, user_id) WHERE user_id IS NOT NULL` and `(walk_kind, walk_id, guest_key_hash) WHERE guest_key_hash IS NOT NULL`.
  - Index `(walk_kind, walk_id, status, created_at DESC, id DESC)` for public reads and `(status, updated_at DESC, id DESC)` for moderation.
  - There is no FK to `user_walks`, by decision 10: reviews outlive the walk.
- `target` = `{ kind: "catalog" | "account", id, title, revision }`, always resolved by the server and never taken from the client. `viewer` = `{ userId } | { guestKeyHash } | null`.
- `getWalkReviews(target, viewer, { after = null, limit = REVIEW_PAGE_SIZE })` → `{ summary: { average: number | null, count }, reviews: [{ id, author, rating, text, createdAt }], nextCursor, mine }`.
  - `summary` covers `status='published'`, with `average` rounded to 2 decimals or `null` when `count = 0`.
  - `reviews` are published with `text <> ''`, newest first, keyset cursor on `(created_at, id)`.
  - `author` = `user.name` via `LEFT JOIN user`, falling back to «Пользователь» if blank; «Гость» for guests.
  - `mine` = `{ rating, text, status, updatedAt } | null` for the viewer.
- `saveWalkReview(target, viewer, { rating, text })` runs in one `transaction`. It upserts by the viewer's unique key, sets `status` via `nextReviewStatus`, refreshes `walk_title`/`walk_revision` from `target` and bumps `updated_at`. It returns `{ mine, summary }`. A null viewer → `BAD_REQUEST`.
- `deleteWalkReview(target, viewer)` → `{ mine: null, summary }`. It is idempotent: deleting nothing is not an error.
- `listWalkReviewsAdmin({ status = "pending", rating = null, q = "", limit = 25, offset = 0 })`.
  - Validation: `status ∈ pending|published|hidden|all`, rating 1–5, `q ≤ 120`, limit 1–50, offset ≥ 0; otherwise `BAD_REQUEST`.
  - Query: `LEFT JOIN user` for author `{kind:"user",id,name,email}` / `{kind:"guest"}`, plus `LEFT JOIN user_walks w ON r.walk_kind='account' AND w.id=r.walk_id` to compute `shareToken` only when `w.visibility='shared'`. Title search uses `walk_search(r.walk_title)`. The offset is clamped like `listSharedWalksAdmin`.
  - Returns `{ reviews, total, offset, hasMore, pending }`, where `pending` is the total pending count regardless of filters.
- `moderateWalkReview(id, action, editorId)`: `action ∈ publish|hide` → sets the status, `moderated_at` and `moderated_by` (editor user id, or null for the legacy token). Returns the admin row or `null`.
- `deleteWalkReviewAdmin(id)` → boolean.

### 1. Server routes — `backend/server.mjs`

New `createApp` option `reviewLimiter = createReviewRateLimiter()`, injectable for tests.

Target resolution:
- Catalog: `store.getPublishedWalk(slug)`, which must have `walk.steps.length`, → `{kind:"catalog", id: slug, title: route.title, revision: 0}`.
- Share: `accountStore.getSharedWalk(token)`, excluding `snapshotError`, → `{kind:"account", id: walk.id, title: walk.title, revision: walk.revision}`.
- Own: `accountStore.getWalk(session.user.id, id)` → same `account` shape.

Every unknown, private, revoked or broken walk returns the same `404 {error:{code:"NOT_FOUND",message:"Прогулка не найдена."}}`. Without `accountStore`, review routes answer `503 {code:"UNAVAILABLE"}`.

Viewer resolution: a session → `{ userId: session.user.id }`; otherwise the `X-Review-Key` header → `{ guestKeyHash }`. A malformed key → 400. A missing key → `null` for GET and 400 `{code:"REVIEW_KEY_REQUIRED"}` for writes.

Routes:
- Public, placed before the `publishedWalk` match:
  - `GET|PUT|DELETE /api/story-walks/:slug/reviews(/mine)?`
  - `GET|PUT|DELETE /api/story-walks/shared/:token/reviews(/mine)?`
- Own walks, inside the `/api/me` block (session, Origin and CSRF are already enforced there): `GET|PUT|DELETE /api/me/walks/:id/reviews(/mine)?`.
- `GET …/reviews`: the only allowed query key is `cursor` (single), anything else → 400. Returns the `getWalkReviews` result.
- `PUT …/reviews/mine`: body via `body(req, 8192)`, keys only `rating` and `text` (optional) → upsert → 200 `{ mine, summary }`.
- `DELETE …/reviews/mine` → 200 `{ mine: null, summary }`.
- Write gate for the public routes:
  - require `req.headers.origin === origin` and `sec-fetch-site ∈ {undefined, "same-origin", "none"}`, otherwise 403 `{code:"FORBIDDEN"}`;
  - with a session, also require a valid `X-CSRF-Token`, otherwise 403 `{code:"CSRF", message:"Обновите страницу и повторите действие."}`;
  - then run `reviewLimiter.check(key)` with key `user:<id>` or `ip:<x-real-ip|remoteAddress>`. Over the limit → 429 `{code:"RATE_LIMITED", message:"Слишком много изменений отзывов. Попробуйте позже."}` with a `Retry-After` header. `record(key)` runs only after success. The `/api/me` routes use the same limiter.
- Other methods → 405 with an `Allow` header.

Admin routes, inside the `/api/story-admin` block:
- `GET /api/story-admin/reviews?status&rating&q&limit&offset`: strict query validation like `/walks/shared` (unknown or duplicate keys → 400). Each row is mapped with `walk.url`: catalog → `/walk?catalog=<slug>` if `store.getPublishedWalk` still returns it; account → `/walk?share=<token>` if currently shared; otherwise `null`.
- `POST /api/story-admin/reviews/:id/moderate` `{action}` → `{review}`, or 404.
- `POST /api/story-admin/reviews/:id/delete` `{}` → `{success:true}`, or 404. `:id` is a UUID.

### 2. Client model and API — `src/features/reviews/` (new)

- `model.ts`:
  - `type ReviewTarget = { kind: "catalog"; id: string } | { kind: "share"; token: string } | { kind: "account"; id: string }`.
  - `reviewsPath(target)` returns `/api/story-walks/:id/reviews`, `/api/story-walks/shared/:token/reviews` or `/api/me/walks/:id/reviews`, with segments URL-encoded.
  - `targetKey(target)` returns a string such as `catalog:<id>`.
  - Types `ReviewSummary`, `PublicReview`, `MyReview`, `ReviewPage`, and strict validators `validateReviewPage(value)` / `validateReviewWrite(value)` that throw on any malformed field.
  - `REVIEW_TEXT_MAX = 1000`.
  - `formatRatingSummary(summary)` returns `"★ 4,6 · 12 оценок"` (ru-RU, one decimal, plural forms via `Intl.PluralRules("ru")`), or `""` when `count === 0`.
- `device.ts` holds all `localStorage` access, wrapped in try/catch and returning null/false on failure:
  - `getReviewKey({ create })`: key `otgolosok:review-key:v1`, 32 bytes from `crypto.getRandomValues`, base64url;
  - `markWalkStarted(target)` / `wasWalkStarted(target)`: key `otgolosok:walk-reviews:started:v1`, a JSON array of target keys capped at the newest 200;
  - `saveReviewDraft` / `loadReviewDraft` / `clearReviewDraft`: key `otgolosok:walk-reviews:draft:v1:<targetKey>`.
- `api.ts`: `loadReviews(target, cursor, signal)`, `saveReview(target, input, signal)` and `deleteReview(target, signal)`.
  - Extend `loadJson` in `walk-loader.ts` with an optional trailing `init?: { method?: "PUT" | "DELETE"; headers?: Record<string,string> }`. Existing callers keep their behavior.
  - Requests send `X-Review-Key` for guests (signed-out session) and `csrfHeaders()` for signed-in users.
  - The session state comes from `getSession()`, which also refreshes the CSRF token; a session-check failure is treated as a guest.
  - PUT (upsert) and DELETE are idempotent, so they may use the same bounded retries. A `429` whose `Retry-After` is longer than 5 s is **not** retried: surface it immediately with the server message.
- `use-walk-reviews.ts`: hook `useWalkReviews(target | null)`.
  - Loads the first page on mount and aborts on unmount.
  - Exposes `{ state: "idle"|"loading"|"ready"|"unavailable", summary, reviews, nextCursor, mine, loadMore(), save(input), remove() }`.
  - A load failure, network or schema, yields `"unavailable"` and never throws into the walk UI.
  - `save` and `remove` update `summary` and `mine` from the response.
  - A save failure keeps the draft in `localStorage` and returns a Russian message from `toUserMessage`.

### 3. Review UI components — `src/features/reviews/`

- `walk-reviews.tsx`: `WalkReviews({ reviews, intent: "read" | "rate", canRate, signedInName })`, where `reviews` is the hook result.
  - **Summary:** «★ 4,6 · 12 оценок», or «Оценок пока нет».
  - **List:** author, stars (`aria-label="Оценка 4 из 5"`), date (`toLocaleDateString("ru-RU")`) and text with `white-space: pre-line`; a «Показать ещё» button pages through.
  - **Form:** shown when `intent === "rate"`, or when the user taps «Оставить отзыв» (visible only if `canRate`).
  - **Unavailable state:** «Отзывы сейчас недоступны.» plus a «Повторить» button.
- `review-form.tsx`, opened pre-filled from `mine` or the saved draft:
  - **Stars:** a native `radiogroup` of 5 visually hidden radios with star labels («1 звезда из 5» … «5 звёзд из 5»), so arrow keys work natively. Targets are ≥44 px, focus is visible and the selection is shown by both fill and outline, not color alone.
  - **Text:** a `textarea` with `maxLength={1000}`, a live counter «N / 1000» and the label «Отзыв (необязательно)».
  - **Disclosure line:** «Отзыв будет опубликован с именем «{name}».» for signed-in users. For guests: «Отзыв будет опубликован от имени «Гость». Изменить его можно только в этом браузере.»
  - **Submit:** «Отправить отзыв», or «Сохранить изменения» when `mine` exists; disabled until a rating is chosen and while busy.
  - **Result messages** by returned status: `published` → «Спасибо! Оценка учтена.»; `pending` → «Спасибо! Отзыв появится после проверки редакцией.»; `hidden` → «Отзыв скрыт редакцией.»
  - **Own pending review:** marked «На модерации».
  - **Delete:** «Удалить отзыв» with inline confirmation («Удалить отзыв?» → «Удалить» / «Отмена»).
  - **Errors** use `role="alert"`. Status messages use `role="status"`.
  - **Guest without storage** (`getReviewKey` returns null): «Браузер не даёт сохранить ключ отзыва. Войдите, чтобы оставить отзыв.» with a login link `/login?returnTo=<current walk URL>`.
- `walk-reviews.module.css`: CSS Modules (stylelint and prettier run on `src/**/*.css`). Use the walk-panel palette and the DESIGN.md scale.

### 4. Integration into the walk screen

- `src/features/walks/walk-screen.tsx`: derive `reviewTarget` from `selectedKind`: `catalog` → `{kind:"catalog", id: catalogId}`, `share` → `{kind:"share", token: shareToken}`, `id` → `{kind:"account", id: accountId}`, `local` → `null`. Pass it as a new prop to `TourExperience`. The offline copy path is unchanged; reviews simply load or show "unavailable".
- `src/features/tour/tour-experience.tsx`:
  - Accept `reviewTarget?: ReviewTarget | null` and call `useWalkReviews(reviewTarget ?? null)` only in universal mode.
  - In `startTour`, call `markWalkStarted(target)` and keep a `started` state, initialised from `wasWalkStarted`.
  - Compute `canRate = Boolean(target) && (started || Boolean(mine))`.
  - Pass to `WalkSession`: `ratingLabel = formatRatingSummary(summary)`, `canRate`, and `reviews = target ? (intent) => <WalkReviews … intent={intent} /> : null`.
  - Fetch the signed-in name once via `getSession()` for the disclosure line.
- `src/features/tour/walk-session.tsx`:
  - New props: `ratingLabel?: string`, `canRate?: boolean`, `reviews?: ((intent: "read" | "rate") => ReactNode) | null`.
  - Drawer union: add `"reviews"` plus a separate `reviewIntent` state.
  - **Reading phase** (`!active && !completed`):
    - append `ratingLabel` to the meta line when non-empty, e.g. «35 мин · 2,4 км · ★ 4,6 · 12 оценок»;
    - add a tools button «Отзывы» (`aria-expanded`) that opens the drawer with intent `read`.
  - **Settings drawer**, active or reading phase: when `canRate && reviews`, render a «Оценить прогулку» button under the settings slot. It switches the drawer to `"reviews"` with intent `rate`.
  - **Completed:** render `reviews("rate")` inline between the heading and the footer when `reviews` is non-null, inside a scrollable container. It must respect the same height budget as `.walk-session-drawer`, so the footer «На карту» stays visible on a 568×400 landscape phone.
  - The «Оставить отзыв» button inside the list (intent `read`) appears only when `canRate`.

### 5. Admin tab «Отзывы»

- `src/features/admin/reviews-admin.tsx` (+ `reviews-admin.module.css`): `ReviewsAdmin({ api, run, busy })`, modelled on `SharedWalkAdmin`.
  - Heading «Отзывы» with «На модерации: N».
  - Filters: status (`На модерации` default / `Опубликованные` / `Скрытые` / `Все`), rating (`Любая`, 1–5), walk title search.
  - Table: rating, text (pre-line), walk (link opening in a new tab, or «Прогулка удалена или закрыта»), author (name + email, or «Гость»), dates, status, actions.
  - Actions: «Опубликовать» (shown for pending/hidden), «Скрыть» (pending/published), «Удалить» with inline confirmation. Each action reloads the current page.
  - Paging: «Назад/Далее», page size 25, using the server-clamped offset.
- `src/features/admin/admin-desk.tsx`: add `"reviews"` to `AdminSection`, a tab button «Отзывы», `"reviews"` to the `?section=` allow-list, and the `api` prefix mapping `path.startsWith("/reviews")` → `/api/story-admin${path}`. Use `readFetch` for `/reviews?` GETs, as for `/walks/shared?`.

### 6. Documentation

- `docs/agents/walk-reviews.md` (Russian) covers the data model, the moderation state machine, the endpoints, guest key semantics, the limiter (in-memory, resets on restart, shared IP behind CGNAT/proxy) and the privacy notes: public account name with an in-form disclosure, no IP stored, cascade on account deletion. Add a two-sentence entry to `docs/agents/README.md`.
- `README.md` «Универсальные прогулки»: one short paragraph about reviews and moderation.
- `docs/agents/walks.md` «Аккаунт и ссылка»: list the new review endpoints.

## Testing & verification

Backend (`node --test`, run via `pnpm test`):
- `backend/walk-reviews.test.mjs` (in-memory `DatabaseSync` with a minimal `user` table, as in `shared-walk-admin-api.test.mjs`):
  - table-driven `nextReviewStatus` covering every row of the state machine;
  - table-driven `normalizeReviewText`: CRLF, control chars, bidi/zero-width removal, newline collapsing, boundary 1000 vs 1001 code points (emoji count as one), non-string → 400, `<3` kept;
  - `validateRating`: 0, 1, 5, 6, 1.5, "5", null;
  - `guestKeyHash` format checks;
  - upsert uniqueness per user and per guest key;
  - summary and list contain only published reviews (list: non-empty text only); cursor pagination;
  - user deletion cascades reviews; walk deletion and sharing revocation keep them, and the admin list shows `walk.url = null`;
  - admin filters, pending counter and offset clamp;
  - the rate limiter: 20 allowed, 21st rejected with `retryAfterSec`, window slides, a rejected check does not consume budget, key eviction at `maxKeys`.
- `backend/walk-reviews-api.test.mjs` (HTTP via `createApp`, real `createAuth({databasePath:":memory:"})` fixture as in `account-api.test.mjs`):
  - guest PUT without `Origin`, cross-site or with a missing/malformed key → 403/400;
  - signed-in PUT without CSRF → 403;
  - catalog unknown slug, revoked or unknown share token, and another user's account walk → identical 404;
  - pending text hidden from the public GET but visible in `mine`;
  - publish via the admin endpoint makes it public; hide removes the rating from the summary;
  - author email never appears in public responses;
  - 429 with `Retry-After` after 20 writes using an injected limiter clock;
  - admin endpoints 401 for non-editors and 400 for bad query params;
  - `/api/me/walks/:id/reviews` works for the owner.

Frontend (vitest + jsdom):
- `src/features/reviews/model.test.ts`: validators reject malformed pages and accept valid ones; `reviewsPath` encoding; `formatRatingSummary` plural forms (1 оценка, 2 оценки, 5 оценок, 21 оценка) and decimals.
- `src/features/reviews/device.test.ts`: key creation and reuse, storage throwing → null, started-list cap at 200, drafts.
- `src/features/reviews/review-form.test.ts`:
  - radios and keyboard;
  - counter;
  - each status message;
  - a failed save keeps the draft and shows the error with retry;
  - inline delete confirmation;
  - the guest-without-storage message;
  - the signed-in name disclosure.
- `src/features/tour/walk-session.test.ts`: extend the table for `ratingLabel` in the meta line; «Отзывы» button only when `reviews` is set; «Оценить прогулку» only when `canRate`; completed state renders `reviews("rate")`.
- `src/features/admin/reviews-admin.test.ts`: rendering, filters → query string, actions call `/reviews/:id/moderate` and `/reviews/:id/delete`, empty and error states.

E2E (Playwright, `pnpm test:e2e`):
- Extend `e2e/walk-session.spec.ts` with a catalog-walk scenario that mocks `/api/story-walks/<id>/view` and `…/reviews` (GET, PUT):
  - the meta line shows the summary;
  - after «Завершить», choose 4 stars, type text and submit; assert the PUT body and the «появится после проверки» message;
  - on 390×844 and 568×400 the completed panel stays inside the viewport and «На карту» is visible.
- Keep the existing local-walk scenarios passing: no review UI for `?local=`, and the catch-all `{user:null}` stub must not break the screen.

Run before each commit: `pnpm lint`, `pnpm typecheck`, `pnpm test` (plus `pnpm test:e2e` for the UI phase). End-to-end: `pnpm build` + `pnpm generator:dev`, open a catalog and a shared walk in the browser, complete them, submit a review as guest and as a signed-in user, moderate it in `/admin?section=reviews` with an editor account, and confirm the public list and average update.

### Implementation notes (divergences from the plan above)

- Server routes live in `backend/walk-review-routes.mjs` (`createWalkReviewRoutes` → `public`, `own`, `admin`); `server.mjs` only creates it and calls the three handlers at the planned spots. Those `server.mjs` lines landed in commit 7037022 of a parallel session that committed the whole file.
- `backend/walk-reviews-api.test.mjs` uses a stub `auth.api.getSession` (as in `shared-walk-admin-api.test.mjs`) with real `sessionCsrfToken`, not a real `createAuth` fixture.
- `loadJson` no longer retries a 429 whose `Retry-After` exceeds 5 s for every caller, not just reviews.
- `WalkReviews` takes `{ reviews, intent, canRate }`; the signed-in name comes from the hook (`reviewer`, resolved once via `getSession()`), not a separate `signedInName` prop. The hook also exposes `reviewer`, `reload` and `loadingMore`.
- A guest GET sends `X-Review-Key` only when a key already exists; the key is created on the first write.
- With an existing review the list button reads «Изменить отзыв» instead of «Оставить отзыв».
- The stars are radios inside a `fieldset` with a legend (no extra `role="radiogroup"`).

Suggested atomic commits: (1) backend store + limiter + tests; (2) server routes + API tests; (3) client model/api/hook + tests; (4) walk-screen UI + e2e; (5) admin tab + tests; (6) docs.

## Out of scope

- Reviews for local guest walks (`?local=`) and for the legacy home-page tour in `ClassicWalkView` (`/`).
- Merging a guest's device review into their account after sign-in; multiple devices for one guest.
- Showing ratings on `/history` cards, on catalog cards or on the map; sorting walks by rating.
- Notifications about new reviews (email, Telegram) and a pending badge on the admin tab itself.
- Author replies, likes, "report abuse" buttons and moderation by the walk owner.
- Persisting rate-limit state across restarts or across several backend processes.
- Storing walk-progress context (completed or not, stops heard) with the review.
- Offline queueing or background sync of unsent reviews; the draft stays in `localStorage` and is re-sent manually.
- Ratings for individual stories or stops.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
