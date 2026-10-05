# Plan: promo queue — walks picked in the admin are published as Shorts + Telegram posts on a fixed schedule

Status: plan, 2026-10-05.

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Context

Today a promo set for a walk (YouTube Shorts video, a Telegram channel post about a different story of
the same walk, a Telegram illustration and a YouTube cover) is produced by hand with the `/walk-promo`
command in this repo, which drives the sibling repo `../otgolosok-shorts` (journal:
`../otgolosok-shorts/docs/agents/spartak-tushino-short-2026-10-05.md`). Covers are drawn with Codex
`image_gen` on the owner's Mac; publication and scheduling are manual.

The owner wants: pick walks "without promo" in the admin → they enter a queue → each queued walk is
published automatically, one per day, **Mon–Thu at 19:00 MSK, Fri–Sun at 21:00 MSK**, on YouTube and in
the Telegram channel. Notifications, previews and the links go to the owner through the Telegram bot.

Two repos are involved:

- **otgolosok** (this repo, Next.js frontend + Node backend `backend/server.mjs`, SQLite) — owns the queue:
  admin UI, order, statuses, links. Source of truth for "what is promoted".
- **otgolosok-shorts** (`../otgolosok-shorts`, Node 24 TS CLI, SQLite state, Docker) — executor: builds,
  previews, publishes, reports statuses back. It has never been deployed to the VPS; this plan includes
  its first deployment (`docs/agents/deployment.md` there).

External services (all already used by Shorts, except the image endpoint):

- AIrouter (OpenAI-compatible, `AIROUTER_BASE_URL`, `AIROUTER_API_KEY`): text via `/responses`
  (existing `src/text/airouter.ts`). **Images the Codex way** (owner's decision): `POST /responses` with
  the Codex text model (`AIROUTER_MODEL`, e.g. `codex/gpt-6-sol-medium`), `input` = the image prompt,
  `tools: [{type: "image_generation", model: "gpt-image-2.5-flare", size}]`,
  `tool_choice: {type: "image_generation"}` → `output[]` item `type: "image_generation_call"`,
  `status: "completed"`, `result` = base64 PNG, plus `size`, `quality`, `revised_prompt`. Verified
  2026-10-05: HTTP 200, 1024×1536 PNG in 40–65 s with `codex/gpt-6-sol-medium` and 100–155 s with
  `codex/gpt-6.1-sol-medium` (owner's current `AIROUTER_MODEL`); keep the 300 s timeout. **Caveat:** the router ignores the tool's `model`
  (a made-up model name also succeeded), so the Codex backend picks its own image model; the response
  does not say which. `/images/generations` rejects `cs/gpt-image-2.5-flare` ("Invalid image model");
  `openai/gpt-image-2.5-flare` on `/images/generations` (sizes 1024x1024, 1024x1792, 1792x1024) is the
  explicit-model alternative if the owner later wants a guaranteed model.
- YouTube Data API v3 (resumable upload, `thumbnails.set` ≤ 2 MB), ElevenLabs, Wikimedia, Telegram Bot API
  (`sendMessage`, `sendPhoto`, `sendVideo` ≤ 50 MB, `getUpdates`, `answerCallbackQuery`,
  `editMessageReplyMarkup`). The Bot API cannot schedule messages.

## Approved decisions

1. **Review:** on the publication day the bot sends the owner a preview (video, post text, both covers)
   with inline buttons «Отменить» and «Перенести на следующий слот». No reaction = publish on schedule.
2. **Covers:** generated through the AIrouter image API (no Codex/Mac dependency). The YouTube cover's
   Cyrillic title, plaque «N ИСТОРИЙ МОСКВЫ» and «ОТГОЛОСОК» are rendered by code over a text-free
   generated background (no model-drawn letters).
3. **Where:** everything runs in Shorts on the site VPS. The heavy build runs at night (03:00 MSK) with the
   existing container limits; a resource preflight precedes enabling cron.
4. **Slots:** automatic, in queue order: each queued walk gets the next free slot (Mon–Thu 19:00,
   Fri–Sun 21:00 MSK). The admin shows the planned date of each item and allows removing and moving up.
5. **Eligible walks:** any walk in the admin list of user walks (`visibility IN ('shared','public')`),
   including link-only walks of other authors (owner's decision; see risk in step 1.4).
6. **Failure or cancel:** the slot is taken by the next queue item that is already built (the night build
   prepares **two** items ahead). A failed or cancelled item leaves the queue with status `failed` /
   `cancelled` and the reason; the owner can re-queue it in the admin.
7. Image provider: AIrouter, Codex image generation (`/responses` + `image_generation` tool, requested
   model `gpt-image-2.5-flare`; see the caveat in Context). Voice: Alex Bell narrator + «Отголосок2» stories
   (current Shorts defaults for `--voice alex-bell`).
8. The existing Shorts `auto` (3 random videos per day) stays **disabled**; only the queue publishes.

## Key codebase facts

otgolosok:
- Service API pattern: `backend/server.mjs` dispatches `/api/service/promo-walks` before the same-origin
  POST gate, authorises `Authorization: Bearer <PROMO_WALKS_TOKEN>` via `authorizePromo` (rate-limited,
  ≥ 32 chars), 404 when disabled. Reuse the same token and pattern for the new queue endpoints.
- Admin list of user walks: `backend/shared-walk-admin.mjs` `createSharedWalkAdminStore(db, …)` →
  `listSharedWalksAdmin({limit, offset, q, author, mode, access, listing})` over `user_walks` joined with
  `user`; routes `GET /api/story-admin/walks/shared` and `/api/story-admin/walks/shared/<id>/listing` in
  `server.mjs` (~line 352). UI: `src/features/admin/shared-walk-admin.tsx` (+ `.module.css`, tests
  `shared-walk-admin.test.ts`), tabs in `src/features/admin/admin-desk.tsx`.
- Rows carry `id`, `shareToken`, `revision`, `title`, `visibility`, `author`. Public walk URL:
  `https://otgolosok.online/walk?share=<shareToken>`; public JSON `GET /api/story-walks/shared/<token>`.
- Tables are created with `CREATE TABLE IF NOT EXISTS` in the store constructors (`backend/store.mjs`).
- Public repo: no server addresses, IPs or deploy journals in commits.

otgolosok-shorts:
- `run --template walk --walk <url> --no-upload` builds a video for an existing walk
  (`src/templates/walk/*`, steps `select→prepare→script→voice→mix→render→verify` with checkpoints in
  `run_steps`). Walks whose start is > 400 m from a metro station fail with `WALK_START`.
- `publish --run <id> [--publish-at] [--thumbnail]` (`src/cli.ts`, `src/youtube/*`): idempotent upload,
  `thumbnails.set`, `YOUTUBE_SCHEDULE_DROPPED` guard.
- Telegram: `src/telegram/client.ts` (`createTelegramClient`, `checkPost`, 429 handling, no retry of
  ambiguous writes), `publish.ts` (`publishTelegram` with `telegram-delivery.json` receipt + lock),
  `schedule.ts` (`telegram:schedule` / `telegram:due`).
- Text generation with validation: `src/text/airouter.ts` (`cachedJson`), `src/text/generate.ts`
  (`generateScript`, one repair pass), `src/text/validate.ts` (facts/numbers/names/tone checks).
- Rendering HTML to PNG: Playwright Chromium is already bundled (`src/render/frame-render.ts`,
  `renderStills`); fonts and brand palette live in `src/scenes/shared/`.
- Config: `src/core/config.ts` (`loadConfig(env, needs)`), errors `src/core/errors.ts`
  (`transient|permanent|auth|config|quota|locked`), HTTP with retries `src/core/http.ts`.
- Cover art rules: `docs/agents/cover-art.md`; Telegram post format: `docs/agents/telegram.md`.
- VPS host clock is UTC; Moscow has no DST (UTC+3): 19:00 MSK = 16:00 UTC, 21:00 MSK = 18:00 UTC.

## Implementation

### 0. Shared contract

Queue item (otgolosok is the owner, Shorts reads/updates it):

```
{ id, walkId, shareToken, title, position, status, slotAt|null, runId|null,
  youtubeUrl|null, telegramUrl|null, error|null, revision, createdAt, updatedAt }
status: queued → building → ready → published
                         ↘ failed        ready → cancelled | (postponed → queued)
```

Slot rule (pure function, implemented in both repos with the same table-driven tests): slots are
`19:00 MSK` Mon–Thu and `21:00 MSK` Fri–Sun; `nextSlots(now, count)` returns the next `count` slots
strictly after `now + 30 min`. Planned dates in the admin = slots assigned to `queued|building|ready`
items in `position` order, skipping slots already taken by a `ready` item with a fixed `slotAt`.

### 1. otgolosok — queue storage, API, admin

1.1 `backend/promo-queue.mjs` (new): `createPromoQueueStore(db, { now })` with table `promo_queue`
(columns as in step 0; `UNIQUE(walk_id) WHERE status IN ('queued','building','ready')`). Methods:
`enqueue(walkId)` (refuses walks without share token or with an active item; position = max+1),
`remove(id, revision)` (only `queued|failed|cancelled`), `moveUp(id, revision)`, `list()` (with planned
`slotAt` computed by `nextSlots`), `claim(count)` for Shorts (atomically `queued→building` for the first
`count` items, returns them), `report(id, patch, revision)` (validated transitions only; optimistic
`revision` check → 409). `promotedWalkIds()` for the «без промо» filter (any item `published`).

1.2 `backend/server.mjs`: admin routes (existing admin auth) `GET/POST /api/story-admin/promo-queue`,
`POST /api/story-admin/promo-queue/<id>/(remove|up)`; service routes (Bearer `PROMO_WALKS_TOKEN`)
`POST /api/service/promo-queue/claim` `{count}` and `POST /api/service/promo-queue/<id>/report`.
Error mapping like `promo-walks` (400/401/404/409/429).

1.3 `backend/shared-walk-admin.mjs`: add `promo` field to admin rows (`null | {status, slotAt}`) and a
filter `promo=none|queued|published|all` («без промо» = no published and no active item).

1.4 UI `src/features/admin/shared-walk-admin.tsx`: column «Промо» (status text, planned date), button
«В очередь промо» for rows without an active item, filter «Без промо». For link-only walks of other
authors the button asks for confirmation: «Прогулка доступна только по ссылке. В промо ссылка станет
публичной в YouTube и Telegram.» New panel/tab «Очередь промо» (`promo-queue-admin.tsx`): ordered list
with planned date/time (MSK), status, links, error, buttons «Выше», «Убрать», «Вернуть в очередь» for
failed/cancelled. UI text in Russian, no colour-only states.

### 2. Shorts — queue client and state machine

2.1 `src/sources/promo-queue.ts`: `claim(count)`, `report(id, patch, revision)` over the service API with
existing `requestJson` (retries on transient, no retry on 4xx; 409 → reload and re-apply once).

2.2 Local state migration (`src/core/state.ts`): table `promo_items(queue_id PK, run_id, status,
slot_at, preview_message_ids, decision, updated_at)` — local execution state; otgolosok holds the
public status.

2.3 `src/promo/tick.ts` + CLI `promo:tick` (cron every minute, `flock`). Each call is idempotent and does
at most one of these, by time (MSK):
- **Build** (03:00–06:00, if fewer than 2 local items are `ready` for the coming slots): `claim(1)`,
  `run --walk <share URL> --no-upload` in-process (`runOnce`), then steps 3–4 (post + covers); on
  success `ready` + report; on failure `failed` + report + bot message with the error code.
- **Preview** (10:00 on a slot day, once): assign today's slot to the first `ready` item, send the owner
  `sendVideo` (video), `sendPhoto` ×2 (covers), `sendMessage` (post text as it will look, without
  sending to the channel) with inline buttons `cancel:<queueId>` / `postpone:<queueId>`.
- **Callbacks** (every call): `getUpdates` with stored offset; accept only `TELEGRAM_OWNER_CHAT_ID`;
  `cancel` → `cancelled` (report), the next `ready` item takes the slot and gets its own preview;
  `postpone` → back to `queued` at the head (report). `answerCallbackQuery` + remove buttons.
- **Publish** (at `slotAt`, until `slotAt + 2 h`): `publish` as public with `youtube-cover.jpg`, then
  finalize the post with the video URL and `publishTelegram`; report `published` with both URLs and send
  the owner «Опубликовано: <YouTube> · <Telegram>». Past `slotAt + 2 h` → `failed` with
  `PROMO_SLOT_MISSED`, owner notified. YouTube failure → TG post is not sent.

2.4 Config (`src/core/config.ts`, `.env.example`): `TELEGRAM_OWNER_CHAT_ID`, `PROMO_IMAGE_MODEL`
(tool model, default `gpt-image-2.5-flare`), `PROMO_BUILD_HOUR`/`PROMO_PREVIEW_HOUR` constants (not env). Helper CLI
`telegram:whoami` prints chat ids from `getUpdates` so the owner can set `TELEGRAM_OWNER_CHAT_ID` after
sending /start to the bot.

### 3. Shorts — automatic Telegram post

`src/promo/post.ts`: choose a stop **not** among the video beats; LLM (existing `cachedJson`, new prompt
version) returns `{ stopId, emoji, headline, paragraph, teaser }` using only that story's facts; validate
with `validate.ts` rules (numbers and names from the story facts, tone, no links/markup). Code assembles
Telegram HTML per `docs/agents/telegram.md`: headline, paragraph + «Подробнее» link to the first
Wikipedia/Wikidata source of the story, 🎬 teaser with the video link (filled at publish time), 🚶 distance /
walking time / total listening time from the walk JSON, 🎧 walk link, «Обложка — художественная
иллюстрация.» Enforce ≤ 1024 chars of HTML with the longest possible video URL; one repair pass, then fail.

### 4. Shorts — covers

4.1 `src/images/airouter-image.ts`: `generateImage(prompt, size)` → PNG bytes via `/responses` with the
`image_generation` tool (Context). Validate the answer with zod: exactly one `image_generation_call`
with `status: "completed"` and a base64 `result` that decodes to PNG of the requested size; otherwise
`permanent` `IMAGE_CONTRACT`. Timeout 300 s, retries on 5xx/429/timeouts (bounded backoff), permanent on
4xx; log requested model, size, `quality`, duration and `revised_prompt` length (never the key or the
image). Do not use `src/text/airouter.ts` caching for images.

4.2 `src/promo/covers.ts`: LLM writes two text-free image prompts from the cover-art template
(`docs/agents/cover-art.md`): Telegram 4:5 (`1024x1280` or nearest supported) about the post's story
detail; YouTube background 9:16 (`1024x1536`) about the video episodes, upper 40 % calm for text.
YouTube cover = HTML template (title «От … до …» from the walk title, plaque «N ИСТОРИЙ МОСКВЫ», small
«ОТГОЛОСОК», brand fonts) over the background, rendered with Playwright to 1080×1920 PNG, then JPEG ≤ 2 MB.
Save prompts next to images. If image generation fails → item `failed` (no fallback to screenshots).

### 5. Deployment (Shorts) and docs

Follow `../otgolosok-shorts/docs/agents/deployment.md` preflight (CPU/RAM/disk, `.env` with
`AIROUTER_*`, `ELEVENLABS_*`, `YOUTUBE_*`, `TELEGRAM_*`, `OTGOLOSOK_SERVICE_TOKEN`, YouTube token copy,
`youtube:check`, `telegram:check`, one `run --no-upload` with memory peak recorded). Cron: only
`promo:tick` every minute with `flock` (no `auto`). Update `/walk-promo` skill to mention the queue,
Shorts `README.md`, `docs/agents/telegram.md`, `docs/agents/deployment.md`. otgolosok deploy per its usual
process (background deploy; check recent backups first).

## Testing & verification

- Slot rule: table-driven tests in both repos (each weekday, 30-min lead boundary, Sunday→Monday,
  midnight UTC vs MSK).
- otgolosok: store tests for enqueue/duplicate/remove/moveUp/claim/report transitions and 409 on stale
  revision; API tests for auth (401/429), 404 when disabled, admin filter «без промо»; UI tests for the
  confirmation on link-only walks and planned dates.
- Shorts: tick state machine with a fake clock and fake clients (build window, two-ahead, preview once,
  cancel → next ready takes slot, postpone, slot missed, YouTube failure blocks TG); callback filtering
  by owner chat; post builder (stop not in video, ≤ 1024 boundary, facts-only validation); image client
  (retry policy, 4xx permanent); cover HTML render snapshot dimensions. No paid API calls in tests.
- End-to-end on the VPS: enqueue a test walk with a slot moved to "now + 40 min" via a test-only CLI flag
  `promo:tick --now <ISO>`; verify night build artefacts, preview in the owner chat, cancel and postpone
  paths, then one real publication; record results in a Shorts `docs/agents/` note.

## Out of scope

- Shorts `auto` random videos (stays off), analytics, A/B of covers, editing the post text from the bot
  (cancel and re-queue instead), several videos per day, other social networks.
- Replacing the Shorts-feed thumbnail in YouTube Studio (no API; the owner checks it by hand).
- Migrating the already scheduled one-off VPS Telegram job of 2026-10-05.

---
**Maintenance note (for the implementing agent):** when this plan is implemented, update the `Status:` line above, e.g. `Status: implemented YYYY-MM-DD in branch `feat/<name>``. If the plan changes during implementation, update the affected sections too — the plan must not lie about what was built.
