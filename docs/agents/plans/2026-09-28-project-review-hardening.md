# Plan: Project review round 2 — reliability, offline, quotas and tooling

Status: implemented 2026-09-28 in branch `feat/auth-account-osm-pipeline`. Docker could not run on the dev machine: `nginx -t`, `docker compose build/up` and the nginx/valhalla image pins (4.4) are not done; 1.4 `engine-strict` skipped. After 5.2 the whole video package was removed from the repository at the user's request (archived in tag `video-archive-2026-09-28` on the fork).

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

A second whole-project review (2026-09-28) covered the backend HTTP API and stores, the static-export frontend with its offline mode, and repository tooling. The first review (`docs/agents/project-code-review-2026-09-21.md`) and its fixes (`docs/agents/plans/2026-09-21-project-review-reliability.md`) are still intact; this plan covers only new findings.

Baseline on the review date (Windows, Node 24.18.0 — below the declared `>=24.20.0`):
- `pnpm lint`, `pnpm typecheck`: pass.
- Vitest: 53 files / 355 tests pass.
- `node --test backend/*.test.mjs`: 272/276 — the 4 failures are all in `backend/admin-make.test.mjs` (need `make` and `/bin/sh`, absent on Windows), so `pnpm test` is always red locally.
- Branch `feat/auth-account-osm-pipeline` was 32 commits behind `origin/main` (and 23 ahead, almost all video work). `origin/main` contains relevant fixes: `cbc3e42` (CSP + security headers, `docker/security-headers.conf`), `2e7a6b0` (worker lease / default secret in external TTS API), TTS recovery commits, `88f68c1` (domain `otgolosok.online`).
- Other agent sessions were concurrently committing video work (`src/video/`, `scripts/*video*`, `video/`) in the same checkout. Phases touching those areas are placed last.

Production topology (from `docs/production-runbook.md` on `origin/main`): Traefik routes `PathPrefix(/api/)` of `otgolosok.online` directly to the generator backend; production nginx serves only the static export. `docker/nginx.conf` applies only to the local/dev Compose stack.

No paid external API is called by anything in this plan.

## Approved decisions

1. One plan for everything: backend defects, frontend/offline defects, tooling and repository hygiene. Implement in phases with atomic commits.
2. Phase 0 merges `origin/main` into the current branch first; every item below is re-verified after the merge and dropped (noted in this plan) if main already fixed it.
3. Offline copies must work for **all** walk kinds (catalog, shared link, local, account), with a UI to remove a saved copy and correct audio cleanup on sign-out.
4. Add a `check` script to `package.json`; **no CI workflow** (YAGNI).
5. Generation quota is **per user only**: `USER_DAILY_GENERATION_LIMIT`, default 6 units per rolling 24 h. The site-wide daily cap (`MAX_DAILY_JOBS` / `DAILY_LIMIT`) is **removed**. The concurrency cap (`maxActive`, `QUEUE_FULL`) stays. Consequence: paid generation must never run without an authenticated user (see 2.2).
6. Per-account storage caps: 200 saved walks, 1000 favorites; `importLocal` respects the walk cap. Exceeding returns 409 with a Russian message.
7. No email verification (would need a mail provider).
8. Binary media: stop tracking `artifacts/*.wav` and `video/assets/**/*.png` screenshots; ignore them. Do not rewrite history. Voice MP3s and `targets.json`/manifests stay tracked (MP3s need an external TTS to regenerate).
9. Move video (Remotion) into its own pnpm workspace package. Backend dependencies are **not** split into a separate package.
10. Enable `checkJs` for the **whole backend** at once (`backend/**/*.mjs`), wired into `pnpm typecheck`.
11. `backend/admin-make.test.mjs`: skip with an explicit reason when `make` or `/bin/sh` is unavailable (Windows). Makefiles stay POSIX-only.
12. Hard-coded production host (`$VPS (см. .env.ops)`) and personal paths in Makefile/scripts/docs **stay as is**.
13. Python: add `pyproject.toml` with ruff, pyright and pytest run through `uv`; a `test:py` script is part of `pnpm check`.
14. (Added at implementation start) Everything that makes `pnpm check` fail on the developer machine (Windows) must be fixed within this plan, including pre-existing failures unrelated to the review findings (e.g. Windows `EPERM` temp-dir cleanup in tests that came from `origin/main`).

## Key codebase facts

Line numbers drift quickly in this repo (files are dense, often one-line functions); locate code by function name.

Backend
- `backend/server.mjs`: single HTTP handler; entry block at the bottom (`if(process.argv[1]&&import.meta.url===…)`) builds `createStore(join(directory,"jobs.sqlite"),{maxDaily:Number(process.env.MAX_DAILY_JOBS??6),maxActive:2,…})` and `createAccountStore(authRuntime.database)`. Error → status mapping is one expression near the end of the handler (`["QUEUE_FULL","DAILY_LIMIT","QUOTA_EXCEEDED","UPLOAD_BUSY"]→429`, conflicts → 409). `close()` does `stop workers → server.close(done) → closeAllConnections() → closeAuth()`; SIGINT/SIGTERM handler then closes logs and store.
- `backend/auth.mjs` `createAuth()` opens `new DatabaseSync(databasePath)` (WAL, busy_timeout 5000, foreign_keys) and passes it to better-auth 1.7.5, which runs `BEGIN`/`COMMIT` on that same connection across `await`s (sign-up hashes the password mid-transaction; see `node_modules/@better-auth/kysely-adapter/dist/node-sqlite-dialect.mjs` and `better-auth/dist/api/routes/sign-up.mjs`). `ipAddress.ipAddressHeaders: ["x-real-ip"]`. `authRequestHandler(auth)` passes the raw request stream to better-auth (no body cap).
- `backend/account-store.mjs` `createAccountStore(db)`: uses `db.exec("BEGIN IMMEDIATE")` **before** `try` in `createWalk`, `beginGeneration`, `importLocal` etc. `reserveGeneration()` returns `false` when the `(user_id, request_id)` row already exists, `true` when it inserted. `createWalk` reuses `snapshot.id` when it is a UUID (`user_walks.id` is a global primary key). `setFavorite`, `createWalk`, `importLocal` have no count limits.
- Global daily cap: `backend/store.mjs` `checkCapacity(units)` — throws `QUEUE_FULL` when active jobs ≥ `maxActive`, and `DAILY_LIMIT` when today's jobs + retries + units > `maxDaily`. `checkCapacity` is also injected into `createWalkAdminStore` (`backend/walk-admin.mjs`). User-facing message: `backend/pipeline.mjs` `DAILY_LIMIT`. `compose.yaml` sets `MAX_DAILY_JOBS` and `USER_DAILY_GENERATION_LIMIT` (both default 6).
- Walk-research endpoints (`/api/walk-research-jobs…` in `server.mjs`) apply the personal quota only `if(auth)`; with auth disabled there is no per-user limit — today only the global cap protects spend.
- Walk-research retry: `quotaKey=walk-retry-<id>-<revision>`; `reserveGeneration(...)` result is ignored and `releaseGeneration` runs on any error → a stale retry (key already charged, store throws `CONFLICT`) deletes the original charge.
- Retries: `backend/provider.mjs` has a private `fetchWithRetry(fetchImpl,url,options,signal)` used only by `response()`; `speech()` calls `fetchImpl` directly. `backend/yandex-tts.mjs` calls fetch directly. `backend/tts-api-client.mjs` marks `error.transient` and `backend/safe-fetch.mjs` marks `retryable`, but nothing reads these flags. `Retry-After` is ignored. `scripts/build-guide-voice.mjs` already exports `isTransient` and `withRetry` (video tooling) — reuse its ideas, not the import.
- `backend/tts-api-worker.mjs` (44 lines): `wait(ms,signal)` adds an `abort` listener to a process-lifetime `controller.signal` and never removes it on normal resolve; the `while(!stopped)` poll loop over `client.get()` has no overall deadline; one network error while polling fails the job.
- `backend/walks.mjs` `createWalkPlanner(... timeoutMs=12000, minIntervalMs=2000)`: a process-wide `active`/`lastStart` gate throws `WALK_BUSY` immediately. `/api/walk-plan` needs no session. **Another session is editing `backend/walks.mjs` (walk duration plan `2026-09-28-walk-duration-target.md`) — rebase onto it, don't fight it.**
- `backend/audio-ingest.mjs` writes `.upload-*` temp files in the audio directory; nothing sweeps orphans.
- `backend/store.mjs` worker claim path parses every queued job's `payload_json` on each claim; `getExternalAudioStats` loads all attempt/artifact rows.
- Worker endpoints in `server.mjs`: `WORKER_API_TOKEN` compared with `!==` (admin/CSRF use `timingSafeEqual`); non-array `profileIds` → `TypeError` → 500; one `try{…}catch(e){throw e}` no-op.
- `docker/nginx.conf` (local Compose): `/api/` has `client_max_body_size 64m`, `proxy_hide_header Cache-Control` + `add_header Cache-Control "no-store"` — this overrides the backend's `immutable` header for content-addressed `/api/story-audio/<sha256>.mp3`; `location /` sets `no-store` for everything including static MP3/fonts. Security headers come from `origin/main` (`docker/security-headers.conf`) after Phase 0.

Frontend
- `src/features/walks/walk-screen.tsx`: only the `selectedKind === "id"` branch uses `loadAccountWalkWithOfflineCopy`; `local`, `catalog` and shared (`shareToken`) branches go to network loaders (`loadLocalWalkView`, `loadCatalogWalk`, `loadSharedWalk` in `src/features/walks/walk-loader.ts`).
- `src/features/tour/tour-experience.tsx` (~910 lines): `saveOffline()` calls `saveWalkOffline(view, scope)` from `src/features/walks/offline.ts`; the save button is rendered for any `view`. Initial status `"Офлайн-копия ещё не сохранена"` regardless of existing copy; after SW registration failure it still shows `"Оболочка офлайн готова…"`. `getWalkChapters(route, universal)` is recomputed on every render, including every audio `timeupdate` (`setPlaybackTime`), which rebuilds all map markers (`src/features/explore/explore-map.tsx` `markers.clearLayers()` + re-add) via `walk-session.tsx` / `walk-map.tsx`. The diagnostics panel prints raw `trigger.phase` ("inside"/"cooldown"), source ("browser"/"replay") and English geolocation messages (`src/lib/position/browser.ts`). Dead: second save button guarded by `view` that can't render, `initialTab` prop. SW-activation listener not removed on unmount.
- `src/features/tour/published-route-cache.ts`: on each home visit downloads **all** generated audio with `cache: "no-store"` in parallel (`Promise.all`), holds it in memory, one shared timeout, even when content-addressed URLs are already cached.
- `src/features/walks/offline.ts`: walk audio is cached under `/api/story-audio/<sha>.mp3` (shared key space with the published-route cache), outside the per-user scope, so `clearOfflineScope`, `removeStage`, `removeOfflineWalk` never delete it. `removeOfflineWalk` and `isWalkOffline` are unused; no UI removes a saved walk (up to ~60 MB each). `clearOfflineScope` throws when Cache Storage is unavailable.
- `src/features/account/account.tsx`: sign-out does `await clearOfflineScope(user.id)` **before** `signOut()` — a cache failure blocks sign-out.
- `public/sw.js` `activate`: old caches are deleted only when no window clients exist; the `/update.html` flow always has a window open, so every deploy leaves a full old cache (~4 MB).
- Raw English errors reach users from: `around-screen.tsx` (`response.json()` without catch), `generator/story-generator.tsx` (abort reason after timeout), `walk-builder/request.ts` (rethrows `TypeError`), `walks/walk-loader.ts` → `walk-screen.tsx`, `auth/read-fetch.ts`, `auth/client.ts` (`AbortSignal.timeout`), `walks/offline.ts` ("Download timed out").
- A11y: `aria-label` on role-less elements in `explore-map.tsx` (map container) and the trigger meter in `tour-experience.tsx`; a link labelled "на главную" targets `#top`.
- Dead code: `src/features/walk-builder/walk-builder.css` (imported nowhere); unused exports `deleteLocalWalk`, `exportLocalWalks`, `routeToWalkView`, `moveStop`. Leak: geolocation callback in `walk-creation-panel.tsx` may call `w.resolve` after unmount.

Tooling / repo
- `package.json` scripts: `lint`, `typecheck` (`tsc --noEmit`), `test` (`vitest run && node --test backend/*.test.mjs`); no `check` although AGENTS.md references it; `Makefile` has `check: lint typecheck test build`. `start` is `pnpm dlx serve out` (unpinned runtime download).
- `tsconfig.json`: `allowJs` without `checkJs`; includes only `*.ts/*.tsx/*.mts`.
- ESLint flat config lints `.kilo/worktrees/**` (a stale registered git worktree) — ~143 of 390 linted files.
- `backend/walk-discovery-catalog.mjs` (≈586 KB, 2140 lines) is generated by `scripts/build-walk-discovery.py` and parsed by ESLint every run.
- Docker: root `.dockerignore` doesn't exclude `artifacts/`, `video/`, `docs/`, `e2e/`, `.kilo/`, `.agents/`, `.claude/`; frontend `Dockerfile` does `COPY . .`. Compose builds backend with `context: .`, so `backend/Dockerfile.dockerignore` is effective and `backend/.dockerignore` is dead; test files (`backend/*.test.mjs`) end up in the image. `backend/Dockerfile` uses floating `node:24-bookworm-slim`; `.nvmrc` / frontend image use `24.20.0`. nginx and valhalla images are floating tags.
- `.agents/skills/` and `.claude/skills/` are tracked as two identical regular-file copies.
- Media: `artifacts/*.wav` (~13 MB, unreferenced Silero samples) tracked although README says artifacts are local; `video/assets/guide/**/*.png` (~37 MB) are Playwright screenshots produced by `e2e/video-guide.spec.ts` / `e2e/video-create-guide.spec.ts` with `CAPTURE_VIDEO_GUIDE=1`; `scripts/prepare-video-assets.mjs` copies them into the Remotion public dir.
- `src/video/*` imports from `../../scripts/*.mjs` (`build-guide-audio.mjs`, `prepare-video-assets.mjs`, `build-guide-voice.mjs`, `render-kinetic-video.mjs`) and `../../video/assets/**` JSON; nothing in `src/app|features|lib` imports `src/video`. `pnpm-workspace.yaml` currently has only `ignoredBuiltDependencies` (no `packages:`).
- Python: `scripts/test-import-osm-attractions.py` (unittest) is not run by any script; no `pyproject.toml`. `scripts/generate-walk-audio.py` `urlopen(..., timeout=180)` has no retry, catches only `HTTPError`, and reads `OPENAI_BASE_URL`/`OPENAI_API_KEY` via `os.environ[...]` (bare `KeyError`).
- Plans without an English `Status:` on line 3: `2026-09-16-auth-and-account.md`, `2026-09-16-osm-worker-pipeline.md`, `2026-09-17-easy-tts-extraction.md`. `2026-09-17-tts-docker-api-deployment.md` still says "production deployment remain" although F5/just-tts runs in production (`docs/agents/tts-production-incident-2026-09-22.md`).

## Implementation

Each numbered phase ends with `pnpm check` green and an atomic commit (`type(scope): описание по-русски`). Stage only your own files — other sessions may have staged work in the same checkout (`git commit -- <paths>` or careful `git add -p`).

### 0. Sync with `origin/main`

- `git fetch origin && git merge origin/main` (the desktop app's `sync_with_base_branch` tool if available). Resolve conflicts preserving both sides' intent; video work on this branch and content/TTS work on main are mostly disjoint.
- Run lint, typecheck, full tests, `pnpm build`.
- Re-verify each finding below against the merged tree. Mark anything main already fixed as "dropped — fixed in main by <sha>" directly in this plan.
- Commit: merge commit (`chore(merge): синхронизировать ветку с main`).
- Done 2026-09-28 (`e4cba19` + `94283a0`, two merge commits because a concurrent video session committed in between). Conflicts were additive (`backend/server.test.mjs`, `docs/agents/README.md`); the guest-walk test fixture now passes explicit `placeIds` because main tightened batch eligibility. Re-verification: 2.11 constant-time token compare and `profileIds` validation are already fixed in main (only the rethrow-only `catch` remains); nginx security headers come from main (`docker/security-headers.conf`), the caching issues of 2.12 remain; all other items still reproduce.

### 1. Test baseline and `check`

1.1 `backend/admin-make.test.mjs`: compute once `const posix = process.platform !== "win32" && spawnSync("make",["--version"]).status === 0 && existsSync("/bin/sh")`; pass `{ skip: posix ? false : "requires make and /bin/sh (POSIX)" }` to each `test(...)`. Tests still run on Linux/macOS.

1.2 Python tooling:
- `pyproject.toml` (root): project metadata without packaging, `requires-python` matching the scripts, dev deps `pytest`, `ruff`, `pyright`; `[tool.ruff]` (target version, line length consistent with scripts), `[tool.pyright]` (`include = ["scripts", "backend/normalize-tts.py"]`, basic mode), `[tool.pytest.ini_options]` (`testpaths = ["scripts"]`, `python_files = ["test-*.py"]`). Keep runtime deps in `backend/requirements.txt` unchanged (`ru-normalizr==0.3.0`) — the backend image installs from it.
- Make `scripts/test-import-osm-attractions.py` collectable by pytest (it is unittest-based; pytest runs unittest classes). If the hyphenated filename blocks import, rename to `scripts/test_import_osm_attractions.py` and update references.
- Fix all ruff/pyright errors in `scripts/*.py` and `backend/normalize-tts.py`.
- `scripts/generate-walk-audio.py`: read env vars with a clear error message; retry transient failures (429, 5xx, `URLError`, `TimeoutError`, `ConnectionResetError`) with bounded exponential backoff (4 attempts, 2 s base, 30 s cap, honour `Retry-After`); never include the host or body in error text.
- `package.json`: `"test:py": "uv run ruff check . && uv run pyright && uv run pytest"`.
- Add `.venv/`, `.ruff_cache/`, `.pytest_cache/` to `.gitignore` if missing.

1.3 `package.json`: `"check": "pnpm lint && pnpm typecheck && pnpm test && pnpm test:py && pnpm build"`. Update `Makefile` `check` to call `pnpm check`. Mention `pnpm check` (and the uv requirement) in README «Запуск».

1.4 `.npmrc` with `engine-strict=true` so an older Node fails fast (document Node 24.20+ in README already present). **Skipped during implementation:** the dev machine runs Node 24.18, so engine-strict would block every local command; README already documents the requirement.

1.5 Commit(s): `test(admin): пропускать проверки Makefile без POSIX-окружения`, `chore(python): добавить ruff, pyright и pytest через uv`, `chore(scripts): добавить общую проверку pnpm check`.

### 2. Backend correctness and abuse resistance

2.1 **Separate SQLite connection for the account store.**
- In `server.mjs` entry, open a dedicated `DatabaseSync` on the same `auth.sqlite` path (WAL, `busy_timeout=5000`, `foreign_keys=ON`) and pass it to `createAccountStore`; close it in `close()`. Keep better-auth on its own connection.
- In `account-store.mjs` move every `db.exec("BEGIN IMMEDIATE")` inside the `try` (or a small `transaction(fn)` helper that does BEGIN IMMEDIATE / COMMIT / ROLLBACK and rethrows).
- Test (`backend/account-api.test.mjs` or a new `backend/auth-concurrency.test.mjs`): real `createAuth` + account store on a temp file; start a sign-up and, while its transaction is open (stub the password hasher to await a deferred promise), call `createWalk` / `beginGeneration` → both succeed; roll back the sign-up → the account-store writes persist.

2.2 **Per-user quota only.**
- Remove `maxDaily` / `DAILY_LIMIT` from `store.mjs` `checkCapacity` (keep `QUEUE_FULL`), from the `createStore` options, from `server.mjs` (env `MAX_DAILY_JOBS`, status mapping), `pipeline.mjs` messages, `compose.yaml`, `.env.example`, README, and any frontend code mapping `DAILY_LIMIT`. Keep `quotaExempt` handling only if still used elsewhere; otherwise remove.
- Single source for the limit: `const userDailyLimit = parsePositiveInt(process.env.USER_DAILY_GENERATION_LIMIT, 6)` read once at startup (invalid value → startup error), passed into the handler instead of repeated `Number(process.env…)`.
- Paid generation requires an authenticated user: when `auth` is not configured, `/api/story-jobs` and `/api/walk-research-jobs` creation/retry return 503 `AUTH_REQUIRED` («Генерация доступна только после входа.»); reading existing jobs keeps working. Admin/editor batch generation (walk-admin, content pipeline) stays editor-only and limited by `maxActive` only.
- Fix stale-retry refund: `const reserved = accountStore.reserveGeneration(...)`; in `catch`, call `releaseGeneration` only when `reserved === true`. Same rule wherever `reserveGeneration` is paired with `releaseGeneration`.
- Tests: user A exhausting 6 units does not block user B; retry at revision R twice (second → 409) keeps exactly one charge; auth-less server refuses creation with 503; `checkCapacity` never throws `DAILY_LIMIT`.

2.3 **Per-account storage caps.**
- Constants in `account-store.mjs`: `MAX_WALKS_PER_USER = 200`, `MAX_FAVORITES_PER_USER = 1000`. Check inside the same transaction as the insert (`createWalk`, `importLocal` — reject the whole import if it would exceed, before inserting anything; `setFavorite` — skip the check when the row already exists).
- New error code `STORAGE_LIMIT` → HTTP 409 with Russian messages («Можно сохранить не больше 200 прогулок. Удалите ненужные.» / «В избранном может быть не больше 1000 записей.»). Frontend surfaces `error.message` from the server as-is.
- Tests: boundary 199→200 ok, 201st rejected; import that would cross the cap inserts nothing; re-favoriting an existing item at the cap succeeds.

2.4 **Account walk IDs.** In `createWalk`, if `snapshot.id` already exists for a **different** user, generate a new `randomUUID()` (never reveal existence, never 409). Verify the client adopts the returned `id` (`src/features/walk-builder/use-walk-draft.ts` save path); fix if it keeps the old one. Test: two users saving documents with the same UUID both succeed with distinct IDs.

2.5 **Retry policy for outbound calls.**
- New `backend/retry.mjs`: `withRetry(fn, { attempts = 4, baseMs = 500, maxMs = 8000, signal, isTransient })`, full-jitter exponential backoff, honours `Retry-After` (seconds or HTTP date, capped at `maxMs`), aborts promptly on `signal`. `isTransient` default: network errors (`TypeError` from fetch, `ECONNRESET`, `ETIMEDOUT`, `UND_ERR_*`), 408, 425, 429, 5xx; never other 4xx.
- Replace `provider.mjs` private `fetchWithRetry` with it and apply to `speech()`; apply to `yandex-tts.mjs`; in `tts-api-client.mjs` wrap `create` (idempotent via `requestId`), `get`, `audio`, `ack` and use the existing `error.transient` flag as `isTransient`; in `safe-fetch.mjs` consumers, use `retryable`.
- Tests with fake fetch + fake timers: 503→200 succeeds after one retry; 429 with `Retry-After: 2` waits ~2 s; 400 is not retried; attempts are bounded; abort cancels the backoff wait.

2.6 **TTS HTTP worker.** In `tts-api-worker.mjs`: `wait()` removes its abort listener on resolve; the poll loop has an overall deadline (implemented as a fixed 15 min constant, no env var) after which the job fails with a transient `TTS_TIMEOUT`; single poll errors go through `withRetry` instead of failing the job. Test: listener count stays constant over many waits; deadline fails the job; a transient poll error does not.

2.7 **Graceful shutdown.**
- `server.mjs` `close()`: `server.close()` (stop accepting) → `server.closeIdleConnections()` → wait for in-flight requests up to `SHUTDOWN_GRACE_MS` (default 20 s) → `closeAllConnections()` → stop workers → close auth, account-store DB, logs, store. Signal handler awaits it and exits with code 0; a second signal forces exit.
- **As implemented:** jobs aborted by shutdown go straight back to the queue with the attempt refunded, instead of a separate `INTERRUPTED` state (same outcome, simpler). Original text: jobs aborted by shutdown are recorded as `INTERRUPTED` and **do not consume an attempt** (today `safeError` in `pipeline.mjs` maps `AbortError` to `TIMEOUT`); pass a distinguishable abort reason from `stop()`. `store.recoverInterrupted()` already requeues on start — verify it covers this state.
- On startup, delete `.upload-*` files older than 1 hour in the audio directory (log count, ignore ENOENT).
- `compose.yaml` backend: `stop_grace_period: 30s`.
- Tests: in-flight request completes during shutdown; worker abort on stop yields `INTERRUPTED` with unchanged attempt count; orphan sweep removes only old `.upload-*` files.

2.8 **Request body limits.** `authRequestHandler` rejects bodies over 16 KiB with 413 before handing the request to better-auth (check `Content-Length`, and cap streamed bytes). In `docker/nginx.conf` set `client_max_body_size 64k` (implemented as 128k: walk document JSON bodies reach ~110 KB; the backend keeps tighter per-endpoint limits) for `/api/` and a dedicated `location` for the worker result upload path with `64m` (confirm exact path in `server.mjs`). Test: 17 KiB sign-in body → 413.

2.9 **Walk planner fairness.** Replace the immediate process-wide `WALK_BUSY` with: a FIFO wait queue (max 8 waiters, max wait 10 s, then `WALK_BUSY`) that preserves the existing one-at-a-time + `minIntervalMs` spacing toward Valhalla, plus a per-client limit (key: `x-real-ip`, same trusted header as auth) of 1 request per `minIntervalMs` → 429 `WALK_RATE_LIMITED`. Coordinate with the concurrent walk-duration work in `backend/walks.mjs`. Tests with fake clock: two clients each get served; one client spamming gets 429 while the other is served.

2.10 **Store query efficiency.** Worker claim: filter by preparation version/profile in SQL and `LIMIT` the candidate scan instead of parsing all queued payloads; `getExternalAudioStats`: aggregate in SQL (`COUNT`/`GROUP BY`). Existing store tests must stay green; add one with 5000 queued items asserting correct claim order.

2.11 **Worker endpoint hygiene.** Constant-time compare for `WORKER_API_TOKEN` (reuse the existing `timingSafeEqual` helper pattern); validate `profileIds` is an array of strings (else 400 `BAD_REQUEST`); remove the rethrow-only `try/catch`.

2.12 **nginx (local Compose).** Add `location /api/story-audio/` that keeps the backend `Cache-Control` (no `proxy_hide_header`), and `location` blocks giving hashed static audio/fonts/map tiles under `/audio/`, `/_next/static/media/` long-lived caching (verify real paths in `out/`). Keep `no-store` for HTML and the rest of `/api/`. Add commented guidance (and README note) on `set_real_ip_from` / `real_ip_header X-Forwarded-For` when an extra HTTPS proxy sits in front of nginx, since better-auth rate limiting keys on `X-Real-IP`.

Commits per sub-item group, e.g. `fix(auth): вынести account store в отдельное соединение SQLite`, `feat(quota): оставить только персональный суточный лимит генераций`, `fix(quota): не возвращать списание при устаревшем повторе`, `feat(account): ограничить число прогулок и избранного`, `fix(net): повторять временные сбои внешних API с backoff`, `fix(server): корректно завершать работу по SIGTERM`, `fix(walks): ставить запросы маршрута в очередь вместо отказа`, `perf(store): выбирать задания воркера запросом SQL`.

### 3. Frontend: offline, performance, errors, a11y

3.1 **Offline copies for every walk kind.**
- Generalise `loadAccountWalkWithOfflineCopy` into `loadWalkWithOfflineCopy(kind, key, userId, signal)` in `src/features/walks/offline.ts` / `walk-loader.ts`: try network; on network failure (not on 404/403) fall back to the saved copy for that kind/key; return `{ view, offline, savedAt }`. Use it for all four branches in `walk-screen.tsx` and show the existing «Офлайн-копия от …» notice.
- Saved-copy keys: account walks stay per-user scoped; catalog and shared walks are keyed by catalog id / share token (public data); local walks by local id. Shared-link copies of private content must be removed on sign-out only if they were saved under a user scope — define and document.
- The offline manifest of each saved walk records its audio URLs. Audio removal uses reference counting across all saved walks **and** the published-route cache (same `/api/story-audio/<sha>.mp3` keys): delete a URL only when no remaining manifest references it.
- UI: on the walk screen, when a copy exists show «Офлайн-копия сохранена · N записей» and a «Удалить офлайн-копию» button (uses `removeOfflineWalk`); initial status reflects `isWalkOffline()`.
- Sign-out (`account.tsx`): call `signOut()`/`signOutEverywhere()` first, then best-effort `clearOfflineScope(user.id)` in `finally`/after, never blocking sign-out; the cleanup also removes that user's walk audio via the refcount above. Account deletion same.
- Tests (Vitest, fake Cache Storage): catalog/shared/local walk opens offline from the saved copy; 404 does not fall back; removing one walk keeps audio still referenced by another; sign-out succeeds when `caches` is undefined.
- Playwright: extend `e2e/walk-session.spec.ts` (or new `e2e/offline-walk.spec.ts`) — save a catalog walk, `context.setOffline(true)`, reload, walk opens with text. As implemented, `e2e/offline-walk.spec.ts` aborts the walk API requests (`internetdisconnected`) instead of `context.setOffline(true)`; the page itself is still served by the dev server.

3.2 **Published-route audio cache** (`published-route-cache.ts`): for each URL first `cache.match(url)`; download only missing files, sequentially (or concurrency 2), each with its own timeout (e.g. 30 s) and abort support; put each file as soon as it's verified so progress survives interruptions. Remove `cache: "no-store"` for content-addressed URLs. Tests: cached files are not fetched; one slow file doesn't lose the others.

3.3 **Render churn during playback.** `useMemo(() => getWalkChapters(route, universal), [route, universal])` in `tour-experience.tsx`; keep playback time out of marker props. In `explore-map.tsx`, update markers by id (add/remove/update changed ones) instead of `clearLayers()`; keep keyboard focus on the focused marker. Test: rerender with the same items does not recreate marker elements.

3.4 **User-facing error text.** Add `src/lib/errors/user-message.ts` `toUserMessage(error: unknown, fallback: string): string` mapping `TypeError` network failures, `AbortError`/`TimeoutError`, JSON `SyntaxError`, `QuotaExceededError` and non-JSON 5xx responses to Russian messages; server-provided `error.message` (from our API JSON) passes through. Use it at every site listed in Key facts. Table-driven unit test over error kinds.

3.5 **Offline status honesty and SW cache cleanup.** Show «Офлайн-режим недоступен в этом браузере» when SW registration/installation fails. In `public/sw.js` `activate`, always delete caches older than the previous version (keep current + one previous for open tabs); verify via the generated manifest/versioning in `scripts/build-service-worker.mjs`. Test in `src/lib/offline/service-worker.test.ts`: three versions → oldest deleted even with a window open.

3.6 **Diagnostics panel.** Render it only in replay/debug mode (`?replay=` or `?debug=1`); translate phase/source labels and the browser geolocation messages in `src/lib/position/browser.ts` to Russian.

3.7 **A11y.** Map container `role="region"` + label; trigger meter `role="meter"` with `aria-valuenow/min/max` (or `role="img"` if not numeric); fix the «на главную» link target to `/`.

3.8 **Dead code and leaks.** Delete `walk-builder.css`, the unreachable save button, `initialTab` prop, unused exports (`deleteLocalWalk`/`exportLocalWalks` only if 3.1 doesn't use them; `routeToWalkView`, `moveStop`) — `routeToWalkView` was kept: the e2e capture specs use it; remove the SW-activation listener on unmount; guard the geolocation callback in `walk-creation-panel.tsx` with an unmounted/aborted flag.

3.9 **Split `tour-experience.tsx`** (after 3.1–3.8, behaviour-preserving): `use-offline-shell.ts` (SW update + offline status), `use-walk-audio.ts` (play/toggle/seek/finish/checkpoints), `use-walk-position.ts` (tracking + trigger), and components for the classic walk view and reading view. As implemented, offline-copy state and controls got their own `offline-copy.tsx`, and the debug panel lives in `walk-diagnostics.tsx`. No behaviour change; existing tests and e2e stay green.

Commits: `fix(offline): открывать сохранённые прогулки любого типа без сети`, `feat(offline): удалять офлайн-копию прогулки`, `fix(account): не блокировать выход из-за очистки кеша`, `perf(tour): не перекачивать закешированное аудио маршрута`, `perf(map): не пересоздавать маркеры при воспроизведении`, `fix(ui): показывать понятные ошибки сети по-русски`, `fix(sw): удалять устаревшие кеши после обновления`, `fix(a11y): …`, `refactor(tour): разделить экран прогулки на хуки`.

### 4. Tooling and backend type checking

4.1 **ESLint scope.** Add `.kilo/**`, `.claude/worktrees/**`, `artifacts/**` to `globalIgnores` in `eslint.config.mjs`. Do not remove the `.kilo` worktree itself (it belongs to another tool; mention to the user).

4.2 **Generated discovery catalog as JSON.** Change `scripts/build-walk-discovery.py` to emit `backend/walk-discovery-catalog.json`; import it with `import catalog from "./walk-discovery-catalog.json" with { type: "json" }` in its consumers; delete the `.mjs`. Verify the backend Docker image copies the JSON (`backend/Dockerfile` currently copies `backend/*.mjs`). Keep the output byte-stable (sorted keys) so diffs stay reviewable.

4.3 **checkJs for the whole backend.**
- `tsconfig.backend.json`: extends nothing Next-specific; `allowJs`, `checkJs`, `noEmit`, `strict: false` initially with `noImplicitAny: false` (then tighten per module later — out of scope), `module`/`moduleResolution: "nodenext"`, `target: "es2024"`, `types: ["node"]`, `resolveJsonModule`, `include: ["backend/**/*.mjs"]`, exclude generated/test files only if they cannot be typed (prefer including tests).
- `"typecheck": "tsc --noEmit && tsc -p tsconfig.backend.json"`.
- Fix all reported errors with minimal JSDoc (`@param`, `@returns`, `@typedef` for store records and API payloads). No behaviour changes; where a real bug surfaces, fix it with a test in a separate commit.

4.4 **Docker hygiene.** Root `.dockerignore`: add `artifacts/`, `video/`, `docs/`, `e2e/`, `.kilo/`, `.agents/`, `.claude/`, `test-results/`, `playwright-report/`. `backend/Dockerfile.dockerignore`: add `backend/*.test.mjs`, `backend/**/*.test.mjs`; delete dead `backend/.dockerignore`. Pin `node:24.20.0-bookworm-slim` in `backend/Dockerfile`, pin nginx and valhalla image versions in `compose.yaml`/`Dockerfile` to the currently resolved versions (look them up with `docker image inspect`, record in comments). **Not done:** Docker Desktop was unavailable, so the pins and the compose verification remain open. Unify pnpm installation (corepack in both images). Verify `docker compose build` and `docker compose up -d` + healthchecks locally.

4.5 **`start` script.** Add `serve` as a pinned devDependency; `"start": "serve out"`.

4.6 **Skills duplication.** Keep `.claude/skills/` as the source of truth; add a Node test (`backend/repo-skills.test.mjs` or a Vitest in `src/`) asserting each file under `.agents/skills/` is byte-identical to its `.claude/skills/` counterpart and vice versa, so drift fails `pnpm test`. (Symlinks are avoided because the team develops on Windows.)

4.7 **Plan status lines.** Put a proper `Status:` on line 3 of `2026-09-16-auth-and-account.md`, `2026-09-16-osm-worker-pipeline.md`, `2026-09-17-easy-tts-extraction.md` (verify real state from git history/README before writing), and update `2026-09-17-tts-docker-api-deployment.md` to reflect production deployment (cite `docs/agents/tts-production-incident-2026-09-22.md`; readiness/CDI caveats stay).

Commits: `chore(lint): исключить локальные worktree из ESLint`, `refactor(walks): хранить каталог маршрутов в JSON`, `chore(types): проверять типы backend через checkJs`, `chore(docker): сократить контекст сборки и закрепить версии образов`, `chore(scripts): закрепить serve для pnpm start`, `test(repo): проверять совпадение копий навыков агентов`, `docs(plans): обновить статусы старых планов`.

### 5. Media and video workspace (coordinate with ongoing video work)

Do this phase last and only when no other session is actively changing `src/video/`, `video/`, `scripts/*video*`/`*voice*`. Check `git status` and recent `git log -- src/video video scripts` first; if work is in flight, stop and ask the user.

5.1 **Untrack binary media.**
- `git rm --cached artifacts/*.wav artifacts/*.txt`; `.gitignore`: `/artifacts/` (replacing `/artifacts/video/`).
- `git rm --cached` all `video/assets/**/*.png` produced by the capture specs; `.gitignore` them. Keep `targets.json`, voice `manifest.json` and voice MP3s, `video/assets/video/*.webp`/`*.wav` tracked unless reproducible (check `scripts/build-video-bed.mjs`: if `ad-bed.wav` is fully reproducible, untrack it too and have `video:prepare` build it).
- `scripts/prepare-video-assets.mjs`: when a required PNG is missing, fail with a Russian message naming the capture command (`CAPTURE_VIDEO_GUIDE=1 pnpm test:e2e e2e/video-guide.spec.ts`, and the create-guide spec). As implemented, `ad-bed.wav` is byte-reproducible (`adBedWav()` in `build-video-bed.mjs`), so it is untracked and generated by `video:prepare`; the `video:bed` script was removed. The PNG size test in `guide-timeline.test.ts` is skipped while screenshots are absent.
- Update README «Видео Remotion» and `docs/agents/video-guide.md`: renders now require a fresh capture; screenshots reflect the current UI, so re-rendering after UI changes is expected to change the video.

5.2 **Video workspace package.**
- `pnpm-workspace.yaml`: add `packages: ["video"]` (keep `ignoredBuiltDependencies`).
- `video/package.json` (`"name": "@otgolosok/video"`, private, `type: module`) with all Remotion deps moved from the root; move `src/video/**` → `video/src/**`, and the video-only scripts (`prepare-video-assets.mjs`, `build-guide-audio.mjs`, `build-guide-voice.mjs`, `build-video-bed.mjs`, `render-*.mjs`, `build-*-voice.mjs`, `scripts/lib/voice-audio.mjs` and any other video-only helpers — verify by import graph) → `video/scripts/`. Fix relative imports (`video/assets/**`).
- `video/tsconfig.json` and a Vitest config for video tests; root `vitest` must not pick up `video/**`; root `tsconfig.json` excludes `video`. `pnpm test` runs video tests via `pnpm --filter @otgolosok/video test`.
- Root scripts `video:*` become thin proxies: `pnpm --filter @otgolosok/video <script>`. As implemented, `video:prepare` maps to the package script `assets` (a script named `prepare` would run on every install). Video scripts resolve files from the repo root via `video/scripts/lib/paths.mjs` / `import.meta.url`, not from the working directory. `scripts/build-map.mjs` stays at the root (the site build uses it) and `video/scripts/build-centre-walk-video.mjs` imports it from there. The frontend install filter was verified with a local `pnpm install --frozen-lockfile --filter otgolosok` simulation (506 packages, no Remotion), not with a Docker build.
- Frontend `Dockerfile`: install only the root package (e.g. `pnpm install --frozen-lockfile --filter otgolosok`); read pnpm docs for the exact filter semantics before choosing, then verify the image builds without Remotion (`docker compose build` + check `node_modules` size / absence of `@remotion`).
- Update `docs/agents/video-guide.md` paths and README.

Commits: `chore(repo): убрать тестовые WAV и скриншоты видео из git`, `refactor(video): вынести видео в отдельный workspace-пакет`.

**After implementation:** the user decided the site repository should not carry the video code at all. `video/`, the capture specs `e2e/video-*.spec.ts`, `e2e/fixtures/` and the video docs were deleted; the workspace, Docker filter and root `video:*` scripts were reverted. The last state lives in the fork tag `video-archive-2026-09-28`.

### 6. Documentation

- README: env var changes (no `MAX_DAILY_JOBS`; `USER_DAILY_GENERATION_LIMIT` per user; storage caps; shutdown grace — implemented as a 20 s `createApp` option, not an env var; no `TTS_API_POLL_DEADLINE_MS`), `pnpm check`, uv requirement, offline behaviour for all walk kinds, video workflow.
- `docs/agents/project-code-review-2026-09-28.md` (Russian): findings, evidence, what was fixed/dropped; add it to `docs/agents/README.md` with a two-sentence description.
- Update this plan's `Status:` line.

## Testing & verification

- Per phase: `pnpm check` (lint, typecheck incl. backend checkJs, Vitest, node tests, Python ruff/pyright/pytest, build). On Windows the Makefile tests are reported as skipped, not failed; confirm they run on Linux (e.g. inside `docker run node:24.20.0` with `make` installed) at least once.
- New/updated tests are listed per sub-step above: happy path, failure path, boundaries (quota 6/7 units, storage 200/201 and 1000/1001, body 16 KiB ±1, retry attempt bounds, poll deadline).
- Concurrency regression: sign-up transaction interleaved with account-store writes (2.1).
- E2E: Playwright offline walk (3.1); existing `e2e/*.spec.ts` stay green.
- Manual: `docker compose up -d --build` — site loads at `http://localhost:8080`, `/api/story-audio/*.mp3` responses carry `immutable`, `docker compose stop backend` finishes within the grace period with a clean shutdown log, backend image has no `*.test.mjs` and (after 5.2) the frontend build stage has no `@remotion` packages.
- Never call OpenAI/Yandex/just-tts from tests; use fakes. Do not touch production data or the production host.

## Out of scope

- Email verification, password reset, CAPTCHAs or any new external integration.
- CI workflow (GitHub Actions) — rejected for now.
- Splitting backend dependencies into their own package.
- Rewriting git history to drop already-committed media (`git filter-repo`), Git LFS.
- Replacing hard-coded production host/paths in Makefile, scripts and docs.
- Tightening backend checkJs to `strict` (only whole-backend basic checking now).
- just-tts server-side changes (`/readyz` CUDA readiness, CDI migration) — tracked in `docs/agents/tts-production-incident-2026-09-22.md`, different repository.
- Production ingress (Traefik) configuration changes.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
