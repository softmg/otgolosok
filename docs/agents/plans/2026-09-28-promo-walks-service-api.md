# Plan: Service API for promo walks (YouTube Shorts)

Status: implemented 2026-09-28 in branch `feat/auth-account-osm-pipeline` — step 7 (production token and deploy) and the production smoke are not done: they need the user's go-ahead.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

A separate repository, `C:\00_projects\otgolosok-content`, gets an automatic YouTube Shorts worker (plan: `otgolosok-content/docs/agents/plans/2026-09-28-youtube-shorts-generator.md`). It publishes 3 Shorts per day. Every video ends with the CTA «Маршрут — в описании», and the description links to the exact walk shown in the video: `https://otgolosok.online/walk?share=<uuid>`.

Today a shared walk can only be created from a signed-in account. Automating that is fragile, and it is capped:

- Better Auth email/password session cookies, CSRF and `Origin` would all have to be handled.
- `MAX_WALKS_PER_USER = 200` would run out in about two months at 3 walks per day.
- The public planner `POST /api/walk-plan` rejects any request whose `Origin` is not `APP_ORIGIN`. A server-side worker would have to spoof the header.

The user chose a token-authenticated service API in otgolosok over a bot account. This plan is a prerequisite for the Shorts «Прогулка» template. The Shorts worker is the only client.

No paid external APIs are involved. The endpoint uses the existing planner (self-hosted Valhalla plus the bundled discovery catalog) and the existing account database.

## Approved decisions

1. **Endpoint.** New `POST /api/service/promo-walks`, authenticated with `Authorization: Bearer <PROMO_WALKS_TOKEN>`.
   - Unset token: the endpoint answers 404, as if it did not exist.
   - Token shorter than 32 characters: server startup fails.
2. **Server-side flow.** The endpoint plans the walk itself (the same planner instance as public traffic), converts the plan into a WalkDocument v2, stores it for a dedicated system user, enables sharing, and returns the share token/URL plus the resolved WalkView.
   - The worker never sends a fake `Origin` and never holds a session.
3. **Dry run.** `dryRun: true` plans and resolves the view without writing anything. The worker uses it to check story coverage before it commits to a walk.
4. **Storage.** Promo walks are ordinary `user_walks` rows owned by the system user `promo-walks`.
   - The user has role `service` and no credential account, so nobody can sign in as it.
   - It is exempt from the 200-walk cap; every other user keeps the cap.
   - Share links work through the existing `/walk?share=` flow; no frontend change.
5. **Idempotency.** Keyed by `idempotencyKey`, scoped to the system user.
   - Same key and same request: the stored walk is returned with 200, without re-planning.
   - Same key, different request: 409 `CONFLICT`.
   - A replay that finds the walk stored but not yet shared enables sharing and succeeds.
6. **YAGNI.** No list/update/delete API, no UI, no per-walk analytics, no new rate limiter beyond the planner's own queue and the failed-auth bucket.

## Key codebase facts

- **Routing** — `backend/server.mjs`:
  - A plain `node:http` handler: an ordered chain of `if`s on `url.pathname` (~128–575).
  - The Origin gate (~505–506) applies to every POST that reaches it: `req.headers.origin!==origin` or a `sec-fetch-site` outside `[undefined,"same-origin","none"]` gives 403.
  - A service route must be dispatched before ~505. The worker API block (~166–222) is the model to copy: Bearer parse, 401 with `WWW-Authenticate: Bearer`, `{error:{code,message}}` bodies, 405 for other methods.
- **Auth helpers:**
  - `adminAuth(token, now)` in `backend/admin.mjs:7–23` returns `authorization => 200|401|429`. It parses `/^Bearer ([^\s]+)$/i`, compares SHA-256 digests with `timingSafeEqual`, and returns 429 after 20 failures per 60 s (fixed bucket). Reuse it for the promo token.
  - `sameSecret` (`server.mjs:34–38`) is the lower-level equivalent.
- **`createApp`** (`server.mjs:~117`) takes options with env defaults, e.g. `workerToken=process.env.WORKER_API_TOKEN`. The account store is `accountStore` (`createAccountStore(authRuntime.accountDatabase)`, ~605).
  - The DB is `${DATA_DIR}/auth.sqlite`: WAL, `foreign_keys=ON`.
  - Stories live in `${DATA_DIR}/jobs.sqlite` (`store`). Walk → story links are resolved at view time.
- **Planner** — `createWalkPlanner` in `backend/walks.mjs`; the shared instance is created at `server.mjs:~119`.
  - Call: `walkPlanner(input, {client})`.
  - Input keys: only `start, mode, minutes, stops?, destination?`.
    - A place is `{address (≤240, no \p{Cc}\p{Cf}<>), location:{lat,lon} inside the Moscow box lat 55.48–55.98 / lon 37.30–37.95, contentId? /^osm:(node|way|relation):\d+$/}`.
    - `mode` is `loop|open`; `minutes` is the number 30, 60 or 90.
    - The presence of `stops` switches to manual mode (1–10 stops, order kept, never dropped).
  - Response: `{stops:[{address,location,contentId?}], geometry:[{lat,lon}] (2–12000), distanceM, walkingMinutes, attribution}`. Stops exclude start and destination.
    - In automatic mode, `contentId` is set only when the place has published content (readiness `story|audio`). Discovery prefers such places.
    - The result is deterministic for the same input and the same content/graph state.
  - Limits: one plan at a time, plans start ≥2 s apart globally, ≤8 waiters, ≤10 s wait, 12 s per plan, one plan per client key per 2 s.
  - Errors and statuses, mapped inline at `server.mjs:~511–514`:

    | Code | Status |
    |---|---|
    | `WALK_INVALID` (also `BAD_REQUEST`) | 400 |
    | `WALK_BUSY`, `WALK_RATE_LIMITED` | 429 + `Retry-After: 2` |
    | `WALK_NOT_FOUND`, `WALK_STOPS_NOT_FOUND` | 404 |
    | `WALK_DISCOVERY_UNAVAILABLE`, `WALK_UNAVAILABLE` | 503 |

    Russian messages live in the same block.
- **Account store** — `backend/account-store.mjs`:
  - `user_walks.user_id` has an FK to the Better Auth `user(id)` with `ON DELETE CASCADE`.
  - `MAX_WALKS_PER_USER=200` (line 26) is checked inside the `createWalk` transaction.
  - `createWalk(userId,{title,snapshot,idempotencyKey})`:
    - key `/^[\w.-]{8,100}$/`, title 1–120 characters;
    - a replay with the same key compares a fingerprint of `{title, snapshot}` and throws `CONFLICT` on mismatch;
    - it reuses `snapshot.id` when it is a UUID that no other user owns.
  - `setWalkSharing(userId,id,revision,enabled)` mints `randomUUID()` as the share token, keeps it when sharing is disabled, and bumps the revision.
  - `getSharedWalk(token)` requires `visibility='shared'`.
  - Idempotency table: `user_walk_idempotency(user_id, idempotency_key, walk_id)`.
- **Better Auth user** — `backend/auth.mjs:22–23`: email/password is enabled; `user.additionalFields.role` defaults to `"user"`, and editors use `"editor"`. Tests insert users with `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt)` (`backend/account-api.test.mjs:27`).
- **WalkDocument v2** — `validateWalkDocument` in `backend/walk-document.mjs:26`:
  - Keys: `version:2, id (UUID|slug), title 1–120, description ≤1000 (required, may be empty), city:"Москва", mode, minutes ∈ {15,30,60,90}, start, destination?, stops ≤10 unique ids, route, fieldChecked`.
  - A place in a document is `{address ≤180, location}`, with no `contentId`.
  - A stop is `{id, place, storyRef ({kind:"osm",id}|{kind:"job",id}|{kind:"catalog",id}|null), transition ≤1200, nextHint ≤1200}`.
  - A route is `{geometry 2–12000, 0<distanceM≤8100, 0<walkingMinutes≤90, attribution 1–2000}`.
  - Whole document ≤100000 characters.
- **Planner → document** only exists on the frontend: `draftToWalkDocument` in `src/features/walks/adapters.ts:35–68`. Its rules:
  - stop id `` `${walkId}-stop-${index}`.slice(0,128) ``;
  - place `{address, location}`;
  - `storyRef` is `{kind:"osm", id: contentId}` when present, else null;
  - `transition`/`nextHint` are `""`;
  - route `{geometry, distanceM, walkingMinutes, attribution}`;
  - `fieldChecked:false`.

  The planner allows addresses up to 240 characters; the document allows 180.
- **View** — `resolveWalkView(snapshot, revision, store)` in `backend/walk-view.mjs:70` is synchronous and read-only.
  - It returns `{document, revision, contentVersion, chapters}`.
  - An `osm` storyRef resolves to status `ready` (with audio) or `text_ready` when a published place text exists within 100 m. Otherwise it is `unavailable`; a null ref gives `not_requested`.
  - The chapter `story` carries full `paragraphs[{text,factIds}]`, `facts[{id,claim,sourceIds}]`, `sources[{id,title,url,publisher}]` and `checkedAt?`.
  - `audio` is `{url:/api/story-audio/<sha>.mp3, sha256, durationSec}`.
- **Public share page:**
  - `GET /api/story-walks/shared/:token` (`server.mjs:~479–484`) has no auth or Origin check, returns `Cache-Control: no-store` and 404 `NOT_FOUND` when absent.
  - The frontend share URL is `${origin}/walk?share=${token}` (`src/features/walks/walk-library.tsx:53`).
- **Environment and infrastructure:**
  - Backend env lives in `.env.example` and passes through `compose.yaml` (e.g. `TTS_API_URL: ${TTS_API_URL:-}`). The production file is `/srv/sites/otgolosok.softmg.tech/.generator.env`; never print it.
  - Traefik routes all of `/api/` to the backend. The repo nginx sets `client_max_body_size 128k` for `/api/` and passes `Authorization` through.
- **Tests and checks:** backend tests use `node --test backend/*.test.mjs`. `pnpm check` runs lint, typecheck (`tsc --noEmit && tsc -p tsconfig.backend.json`, backend checked via checkJs), vitest, node tests, the Python checks and the build.

## Implementation

### 0. Configuration

- `.env.example`: add `PROMO_WALKS_TOKEN=` with a Russian comment: «≥32 символов; то же значение, что `OTGOLOSOK_SERVICE_TOKEN` у Shorts-воркера; пусто — эндпоинт выключен».
- `compose.yaml` (backend service): add `PROMO_WALKS_TOKEN: ${PROMO_WALKS_TOKEN:-}`.
- `createApp` gets the option `promoWalksToken=process.env.PROMO_WALKS_TOKEN`:
  - if it is non-empty and shorter than 32 characters, throw at startup with a message naming the variable (never its value);
  - build `authorizePromo=adminAuth(promoWalksToken)` once.

### 1. System user — `backend/promo-walks.mjs` (new)

- `export const PROMO_WALKS_USER_ID = "promo-walks"`.
- `ensurePromoWalksUser(db)`:
  - An idempotent `INSERT OR IGNORE` into Better Auth's `user` table: `id="promo-walks"`, `name="Отголосок · промо-прогулки"`, `email="promo-walks@service.invalid"`, `emailVerified=1`, `role="service"`, `createdAt`/`updatedAt` = now.
  - Before relying on the `role` column, verify it exists with `PRAGMA table_info(user)`.
  - Never create an `account` (credential) row, so the user cannot sign in.
- Call it once at server startup, only when `promoWalksToken` is configured, on the same `authRuntime.accountDatabase` connection the account store uses.

### 2. Cap exemption — `backend/account-store.mjs`

- Change the signature to `createWalk(userId, {title, snapshot, idempotencyKey}, {maxWalks = MAX_WALKS_PER_USER} = {})`. The transaction checks `count >= maxWalks`.
- All existing callers are unchanged. Only the promo service passes `{maxWalks: Infinity}`.
- Add `findWalkByIdempotencyKey(userId, key)`: a read-only lookup through `user_walk_idempotency` that returns the same view shape as `getWalk`, or null.

### 3. Plan → document — `backend/walk-plan-document.mjs` (new, pure)

`planToWalkDocument(plan, {id, title, description, mode, minutes, start})` follows the frontend rules listed in Key codebase facts.

- `version: 2`, `city: "Москва"`, `fieldChecked: false`; `destination` is omitted (as in the frontend adapter).
- `start` is `{address, location}` taken from the request.
- Stops map from `plan.stops`, with `storyRef` from `contentId`.
- The route is copied from the plan.
- Addresses longer than 180 characters are cut to 179 characters (`Array.from` code points) plus `…`.
- The result is passed through `validateWalkDocument`. A validation failure is a programming error: it is rethrown as a code-less `Error` (with `cause`), which the server's generic handler turns into a logged 500.

### 4. Service — `backend/promo-walks.mjs`

`createPromoWalkService({accountStore, planWalk, store, origin})` exposes `async create(input)`.

**Input** (strict: unknown keys give `BAD_REQUEST`):

```
{idempotencyKey: /^[\w.-]{8,100}$/,
 title: 1–120 chars (same forbidden characters as cleanTitle),
 description?: ≤1000 chars, single line (the document forbids \p{Cc}),
 dryRun?: boolean,
 walk: {start, mode, minutes, stops?}}
```

`walk` is forwarded to the planner, which validates it. `stops` enables manual mode. The Shorts «Место» and «Факты» templates need it: they start at a metro station and pass the featured places as stops, because the start point never becomes a chapter.

**Dry run.** `planWalk(walk, {client: "service:promo-walks"})` → `planToWalkDocument` with a fresh `randomUUID()` id → return `{status: 200, body: {view: resolveWalkView(document, 0, store)}}`. No DB writes and no replay check. `idempotencyKey` and `title` are still required and validated, so one input schema serves both modes.

**Create:**
1. Replay check. `findWalkByIdempotencyKey(PROMO_WALKS_USER_ID, key)`. If found, compare the request with the stored document: `title`, `mode`, `minutes`, start `location`, and the manual stop locations when `stops` were sent.
   - Mismatch: `CONFLICT` (409).
   - Match and private: call `setWalkSharing(...)` first.
   - Match: return 200 with the same body shape as a new walk.
2. Otherwise plan, map with a fresh UUID, then `accountStore.createWalk(PROMO_WALKS_USER_ID, {title, snapshot, idempotencyKey}, {maxWalks: Infinity})`, then `setWalkSharing(PROMO_WALKS_USER_ID, walk.id, walk.revision, true)`.
   - A concurrent duplicate that gets `CONFLICT` from `createWalk` re-reads by key and returns the stored walk if it matches.
3. Response `201`:

   ```
   {walk: {id, title, revision, shareToken, shareUrl: `${origin}/walk?share=${shareToken}`, createdAt},
    view: resolveWalkView(snapshot, revision, store)}
   ```

**Planner errors** keep their codes. Move the inline status and message maps from `server.mjs:~511–514` into an exported `walkPlanErrorResponse(error)` in the new `backend/walk-plan-errors.mjs`; it returns `{status, headers, body}` so that `/api/walk-plan` and the service share one mapping. `Retry-After: 2` stays on 429.

### 5. Route — `backend/server.mjs`

Add a block after the worker API block and before the generic POST/Origin block: `if (url.pathname === "/api/service/promo-walks")`.

- Token not configured: 404 `NOT_FOUND` (same body as other unknown API paths).
- `authorizePromo(req.headers.authorization)`:
  - 401 with `WWW-Authenticate: Bearer` and `{error:{code:"UNAUTHORIZED"}}`;
  - 429 with `Retry-After: 60` for the failure bucket.
- Method other than POST: 405 `METHOD_NOT_ALLOWED` with `Allow: POST`. No query string allowed (`BAD_REQUEST`).
- Body: `body(req, 8192)`, which requires `application/json`. Run `service.create(input)` and send its status/body with the standard `json()` headers (`no-store`).
- Token configured but no account store: 503 `PROMO_WALKS_UNAVAILABLE`.
- No Origin check here — this is the point of the endpoint. Errors from `createWalk`/`setWalkSharing` go through the existing error serialization.
- Log unexpected failures through the existing `logs` handle without request headers.

### 6. Documentation (Russian)

- **README.md**, section «Служебный API промо-прогулок»:
  - purpose, the env var, a `curl` example with a placeholder token;
  - request/response shape;
  - the dry run;
  - idempotency semantics.
- **`docs/production-runbook.md`:**
  - add `PROMO_WALKS_TOKEN` to `.generator.env` (a new random value of 64 hex characters, e.g. `openssl rand -hex 32`);
  - redeploy with the standard generator target;
  - state that user `promo-walks` must never be deleted: `ON DELETE CASCADE` removes every promo walk and breaks every published Shorts link.
- **`docs/agents/promo-walks-service-api.md`:** a short note with the contract and the cascade risk, indexed in `docs/agents/README.md`.
- Propose to the user (do not add without approval) an AGENTS.md gotcha: «Пользователь `promo-walks` владеет промо-прогулками из YouTube Shorts; его удаление каскадно удалит их и сломает ссылки в роликах.»

### 7. Deployment

- Merge, then set `PROMO_WALKS_TOKEN` in production `.generator.env` (keep a backup of the file as the deployment docs require) and deploy with the documented generator target. Get the user's confirmation before touching production.
- Hand the same value to the Shorts worker as `OTGOLOSOK_SERVICE_TOKEN` through a private channel, never through chat or git.

## Testing & verification

- **`backend/walk-plan-document.test.mjs`** (table-driven):
  - `contentId` → osm `storyRef`; a missing `contentId` → null;
  - loop and open;
  - addresses of exactly 180 characters and of 240 characters (truncated with `…`);
  - geometry and route are copied;
  - every result passes `validateWalkDocument`.
- **`backend/account-connection.test.mjs`** (where the cap tests already live):
  - the default cap still rejects the 201st walk with `STORAGE_LIMIT`;
  - `{maxWalks: Infinity}` allows it;
  - `findWalkByIdempotencyKey` returns null for another user's key.
- **`backend/promo-walks.test.mjs`** (fake planner, real SQLite in a temp dir):
  - dry run writes nothing and returns a view whose chapters follow `contentId`;
  - create returns 201 with a UUID `shareToken`, and `getSharedWalk(token)` finds the walk;
  - a replay with the same request returns 200 and the same walk, and the planner is not called;
  - a replay with different `minutes` returns 409;
  - a walk stored but still private (simulated crash) is shared on replay;
  - planner errors are mapped to 404/429/503 with `Retry-After`;
  - `ensurePromoWalksUser` is idempotent and creates no credential row.
- **`backend/server.test.mjs`:**
  - token unset → 404;
  - wrong or missing token → 401 with `WWW-Authenticate`;
  - 21 bad attempts → 429;
  - GET → 405;
  - a correct token with **no** `Origin` header → 201;
  - `/api/story-walks/shared/<token>` serves the created walk;
  - `/api/walk-plan` still returns 403 without `Origin` (regression).
- Run `pnpm check`.
- **Production smoke after deploy** (with the user's confirmation):
  1. A dry-run `curl` from a station start (e.g. `{"address":"метро «Чистые пруды»","location":{"lat":55.7650,"lon":37.6386}}`, loop, 60), checking that chapters have `ready|text_ready` stories.
  2. One real create.
  3. Open `shareUrl` in a browser: the story chapters load.

## Out of scope

- Listing, updating, deleting or unsharing promo walks through the API.
- Any UI for the system user's walks.
- Analytics on share-link opens.
- Changes to `/api/walk-plan` behaviour, the planner algorithm or its rate limits.
- Multiple service clients or scoped tokens (there is one client, the Shorts worker).

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
