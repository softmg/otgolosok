# План: еженедельный цикл ретро, A/B-экспериментов в worktree, ревизий и откатов пайплайнов

Status: plan (2026-11-25).

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of 2026-11-25 (`otgolosok` `main`, `otgolosok-creative` `master`, `otgolosok-shorts` `main`, `bb-plugins/bb-plugin-otgolosok-releases`). Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## 1. Контекст и цель

Нужно превратить выпуск YouTube Shorts проекта «Отголосок» в замкнутый, измеримый цикл режиссёрского улучшения пайплайнов с безопасными откатами — целиком управляемый из BB-плагина **«Выпуски Отголоска»** (`bb-plugin-otgolosok-releases`):

1. Раз в неделю по расписанию (независимо для `otgolosok-creative` и `otgolosok-shorts`) собирается свежая YouTube-аналитика и кривые удержания (`retention`).
2. Агент-режиссёр анализирует метрики и прошлые выпуски, формирует 2–4 гипотезы по перестройке роликов, автоматически выбирает топ-1 и запускает **Team Workflow** (`Architect → Executor → Reviewer`) в изолированном git worktree.
3. На следующем свежем сюжете рендерятся **два ролика**: базовый (текущий `HEAD`) и экспериментальный (из worktree) + формируется пакет отличий `ab-manifest.json` (таймкоды, кадры «Было / Стало», git diff).
4. Утром приходит BB push-уведомление. В плагине владелец смотрит **синхронный A/B-плеер** с кликабельными таймкодами отличий и принимает решение:
   - **Применить ревизию** (`test → squash merge → push → запись ревизии`), опционально **забрав экспериментальный ролик в боевую очередь** (со штатными editorial/Final Gate проверками, без автопубликации);
   - **Отклонить эксперимент** (с опцией забрать базовый ролик в очередь) или **запустить другую гипотезу** из того же ретро.
5. Каждый последующий выпуск штампуется `pipelineGitSha`. В плагине ведётся история ревизий пайплайна и когортная аналитика по ревизиям. При просадке метрик новой ревизии >15% (после ≥72ч лага YouTube и минимальной контрольной выборки) плагин поднимает красный алерт, шлёт push-уведомление и даёт кнопку **«Откатить ревизию»** (`git revert → test → push`).

## 2. Согласованные решения (итоги `/grill-me`)

| Тема | Принятое решение |
|---|---|
| Пайплайны | Оба (`otgolosok-creative` и `otgolosok-shorts`), с независимыми ретро, экспериментами, ревизиями, метриками и откатами. |
| Автономность | «Авто-прототип к утру»: еженедельный автозапуск ретро → автовыбор топ-1 → Team Workflow в worktree → A/B-рендер; ручной гейт на просмотр и мерж/отклонение. Остальные гипотезы доступны для ручного запуска кнопкой. |
| Эталон A/B | Новый сюжет из очереди собирается двумя пайплайнами: текущим (baseline) и пересобранным в worktree (experiment). |
| Рычаги и TTS | Режиссёру доступны любые правки (сценарий, хук, темп, монтаж, визуал, субтитры, обложка, звук). Если текст не меняется — TTS ElevenLabs v4 переиспользуется (0 доп. трат). Если меняется сценарий/хук — разрешена 1 перегенерация строго `eleven_v4`, голос «Отголосок2». |
| Просмотр A/B | Синхронный двойной `<video>` плеер (Текущий vs Эксперимент) с переключением аудио A/B, кликабельными таймкодами отличий, кадрами «Было / Стало» и git diff. |
| Судьба ролика после ревью | Возможность забрать одобренный экспериментальный ролик (или базовый при отклонении) в боевую очередь — строго через штатные editorial/Final Gate проверки и без автопубликации в обход гейтов. |
| Мерж и prod | «Применить ревизию»: проверка чистоты целевого репо → тесты (`npm test` / `pnpm check`) → `squash merge` в `master`/`main` → `git push` → очистка worktree (MP4 и кадры кэшируются на 30 дней). Для `otgolosok-shorts` в UI отображается статус VPS-деплоя (`scripts/deploy.sh`), без слепого автодеплоя. |
| Версионирование и откат | Каждое принятое изменение = git-ревизия (`commitSha`) в `pipeline_revisions`. Откат = `git revert <commitSha>` по клику с подтверждением → тесты → `git push` → новая запись ревизии (`reverted_by`). Без переписывания git history. |
| Атрибуция выпусков | Запись `pipelineGitSha` в артефакты сборки обоих репо + проброс в `release-snapshot.py` и `host.ts`; для исторических выпусков fallback по интервалам `[promotedAt, nextPromotedAt)`. |
| Критерий просадки | Учитываются выпуски старше ≥72ч; минимальная выборка ≥3 ролика (`shorts`) / ≥2 ролика (`creative`). Сравнение медиан новой ревизии с предыдущей по `averageViewPercentage`, удержанию на хуке (~3с) и `engagedViews / views`. Просадка >15% → алерт + push + кнопка «Откатить». |
| Расписание | Дефолт: `creative` — Пт утро MSK (например `06:00`), `shorts` — Вс утро MSK (`06:00`). Настраивается в UI плагина + кнопка «Запустить ретро сейчас». |
| UI и уведомления | 2 новые вкладки верхнего уровня в плагине (`Ретро и A/B`, `Ревизии`; итого 5 вкладок) + BB push-уведомления через `push-notifications` RPC. |

## 3. Проверенные факты о кодовой базе (на 2026-11-25)

- **Плагин `bb-plugin-otgolosok-releases`** (`/Users/user/projects/ai/bb-plugins/bb-plugin-otgolosok-releases`):
  - `server.ts`: SQLite (`queue_snapshots`, `analytics_cache`, `launches`), HTTP-маршрут `GET /covers` (`auth: 'local'`), RPC-контракт в `src/contracts.ts`, CLI `bb otgolosok-releases ...`.
  - `host.ts`: вызывает `release-snapshot.py`, сканирует `creativeRoot/data/daily/YYYY-MM-DD/` (`plan.json`, `built.json`, `status.json`, `youtube-publish.json`), запрашивает YouTube Analytics + `getAudienceRetention` + Data API v3 live stats через модули `otgolosok-shorts`.
  - `app.tsx`: 3 вкладки (`queue`, `published`, `schedule`), React 19, `@get-bb/plugin-sdk/app`.
  - SDK `@get-bb/plugin-sdk@0.6.157` поддерживает:
    - `bb.background.schedule(name, cron, fn)` (серверное локальное время; для динамического MSK-расписания из настроек используем тик каждые 15 минут с проверкой слота и идемпотентным ключом в SQLite);
    - `bb.sdk.plugins.callRpc({ pluginId: 'push-notifications', method: 'notifications.send', ... })`;
    - `bb.http.route(...)` со стандартным `Response` (поддерживает `206 Partial Content` и `Range`).
- **`otgolosok-creative`** (`/Users/user/projects/ai/otgolosok-creative`, ветка `master`):
  - Сборка: `scripts/build-for-slot.mjs`, `scripts/pipeline.mjs`, `scripts/durable-video.mjs`.
  - Финализация: `scripts/finalize-daily-publication.mjs` (пишет `status.json`, `morning-report.json`, `work/upload.json`), `scripts/handoff.mjs` (пишет `creative-package/<id>/release.json`).
  - Снимок очереди: `scripts/release-snapshot.py` читает `shorts.sqlite` (`promo_items` + `runs`) и `data/creative/*/release.json`.
  - Тесты: `npm test` (`node --test tests/*.test.mjs`).
  - **Важное ограничение**: в рабочем дереве `otgolosok-creative` часто присутствуют незакоммиченные артефакты текущего выпуска (`data/work/...`). Операции `squash merge` и `git revert` обязаны проверять чистоту отслеживаемых файлов (`git status --porcelain --untracked-files=no`) и безопасно отказывать с понятной подсказкой, если целевое дерево грязное, либо выполнять merge/revert в чистом временном worktree от `origin/master` с fast-forward проверкой.
- **`otgolosok-shorts`** (`/Users/user/projects/ai/otgolosok-shorts`, ветка `main`):
  - SQLite-схема в `src/core/state.ts` (7 миграций: `runs`, `run_steps`, `uploads`, `usage`, `station_stats`, `cache`, `lease`, `promo_items`, `settings`, `crossposts`).
  - Проверки: `pnpm check` (`format:check && lint && typecheck && test`).
  - Деплой на VPS: `scripts/deploy.sh`.
- **`bb-plugin-team-workflow`** (`/Users/user/projects/ai/bb-plugins/bb-plugin-team-workflow`):
  - Предоставляет инструменты `team_workflow_plan` / `team_workflow_resume` и CLI `bb team-workflow ...` для запуска immutable workflow `Architect → Executor → Reviewer` с кросс-семейным ревью и цепочками фолбэка.

---

## 4. Детальная архитектура по слоям

### 4.1. Схема SQLite в `bb-plugin-otgolosok-releases`

Новые миграции в `server.ts`:

```sql
CREATE TABLE IF NOT EXISTS retro_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('creative', 'normal')),
  slot_key TEXT,                      -- идемпотентный ключ недельного слота (напр. creative:2026-W48) или NULL для ручного запуска
  trigger TEXT NOT NULL CHECK(trigger IN ('scheduled', 'manual')),
  status TEXT NOT NULL CHECK(status IN ('collecting', 'analyzing', 'prototyping', 'ready', 'failed')),
  thread_id TEXT,                     -- BB-тред оркестратора ретро
  baseline_revision_id TEXT,
  summary_json TEXT,                  -- агрегированная статистика за окно + выводы режиссёра
  hypotheses_json TEXT NOT NULL DEFAULT '[]',
  selected_hypothesis_id TEXT,
  experiment_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS retro_runs_slot_key_uniq
  ON retro_runs(slot_key) WHERE slot_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  retro_run_id TEXT REFERENCES retro_runs(id),
  kind TEXT NOT NULL CHECK(kind IN ('creative', 'normal')),
  hypothesis_id TEXT NOT NULL,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  changes_text INTEGER NOT NULL DEFAULT 0, -- 1 если гипотеза меняет сценарий/TTS
  base_commit_sha TEXT NOT NULL,
  branch_name TEXT NOT NULL,
  worktree_path TEXT,
  thread_id TEXT,                     -- BB-тред запуска Team Workflow
  team_plan_id TEXT,
  team_workflow_run_id TEXT,
  status TEXT NOT NULL CHECK(status IN (
    'queued', 'building_code', 'rendering_ab', 'ready_for_review',
    'promoting', 'promoted', 'rejected', 'failed'
  )),
  story_ref_json TEXT,                -- выбранный новый сюжет (id, title, walk, date/queueId)
  manifest_json TEXT,                 -- ab-manifest.json: видео-пути, таймкоды отличий, кадры, diff, метрики TTS
  artifact_cache_dir TEXT,            -- кэш MP4/кадров после очистки worktree (TTL 30 дней)
  artifact_expires_at TEXT,
  queue_transfer_json TEXT,           -- статус переноса ролика в боевую очередь (experiment|baseline|none + путь + gate verdict)
  promoted_revision_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pipeline_revisions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('creative', 'normal')),
  commit_sha TEXT NOT NULL,
  parent_revision_id TEXT,
  experiment_id TEXT REFERENCES experiments(id),
  reverts_revision_id TEXT REFERENCES pipeline_revisions(id),
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active', 'superseded', 'reverted')),
  vps_deploy_status TEXT NOT NULL DEFAULT 'not_applicable'
    CHECK(vps_deploy_status IN ('not_applicable', 'pending', 'deployed')),
  promoted_at TEXT NOT NULL,
  reverted_at TEXT,
  alert_state TEXT NOT NULL DEFAULT 'none'
    CHECK(alert_state IN ('none', 'collecting', 'ok', 'degraded')),
  alert_notified_at TEXT,
  cohort_snapshot_json TEXT           -- кэш последнего расчёта когортных метрик
);
CREATE UNIQUE INDEX IF NOT EXISTS pipeline_revisions_kind_sha_uniq
  ON pipeline_revisions(kind, commit_sha);
```

### 4.2. Контракт `ab-manifest.json` (акцент на отличия)

```ts
{
  version: 1,
  experimentId: string,
  kind: 'creative' | 'normal',
  story: { id: string; title: string; walkTitle?: string; targetDate?: string },
  ttsReused: boolean,
  ttsModel: 'eleven_v4',
  baseline: {
    commitSha: string,
    videoPath: string,         // внутри разрешённого корня/кэша
    coverPath: string | null,
    durationSec: number,
    videoSha256: string,
  },
  experiment: {
    commitSha: string,
    videoPath: string,
    coverPath: string | null,
    durationSec: number,
    videoSha256: string,
  },
  highlights: Array<{
    id: string,
    category: 'hook' | 'pacing' | 'visual' | 'captions' | 'audio' | 'ending' | 'cover',
    startSec: number,
    endSec: number,
    title: string,             // например: «Новый визуальный хук на 0:00–0:03»
    before: string,            // как было в baseline
    after: string,             // как стало в experiment
    expectedMetricImpact: string,
    beforeFramePath: string | null,
    afterFramePath: string | null,
  }>,
  codeDiff: {
    filesChanged: number,
    insertions: number,
    deletions: number,
    files: Array<{ path: string; status: string; summary: string }>,
    patchPreview: string,      // ограниченный diff (до 64 KiB)
  },
  checks: {
    testsPassed: boolean,
    command: string,
    editorialGateReady: boolean,
  }
}
```

### 4.3. Безопасность медиа и git-операций

1. **`GET /media` (стриминг MP4 и кадров «Было / Стало»)**:
   - `auth: 'local'`, доступ строго по `(experimentId, assetKey)` из белого списка в `experiments.manifest_json` (никаких произвольных путей из query).
   - Host проверяет `lstat` / `realpath`, отсутствие symlink-побега, root-confinement (worktree эксперимента или каталог кэша артефактов плагина), лимит размера (MP4 до 150 MiB, JPEG/PNG до 4 MiB) и magic bytes (`ftyp` для MP4, JPEG/PNG заголовки).
   - Поддержка HTTP `Range: bytes=start-end` → `206 Partial Content`, `Accept-Ranges: bytes`, `Content-Range`, `ETag` (чтобы браузер и удалённый BB-клиент могли мгновенно перематывать оба синхронных плеера по клику на таймкод!).
   - TTL-очистка: фоновый тик раз в сутки удаляет кэшированные MP4 старше 30 дней, оставляя JSON-метаданные и ключевые кадры.
2. **Git-операции на хосте (`host.ts`)**:
   - Все команды через `execFile('git', [...])` без shell-интерполяции; строгая валидация `experimentId`, веток (`exp/<id>`) и SHA (`/^[0-9a-f]{7,40}$/`).
   - `promoteExperiment`: проверяет clean tracked state в целевом репо (или использует чистый merge-worktree + проверку, что `HEAD` не разошёлся с `origin/<branch>`), прогоняет `npm test` (`creative`) или `pnpm check` (`shorts`), делает `git merge --squash`, коммит по Conventional Commits (`feat(pipeline): ... [exp:<id>]`), `git push`, возвращает новый `commitSha`.
   - `revertRevision`: проверяет clean tracked state, делает `git revert --no-edit <commitSha>`, прогоняет тесты, делает `git push`, возвращает новый `revertCommitSha`.
   - Никакой передачи секретов; `.env` и YouTube-токены остаются на целевом хосте.
3. **Перенос ролика в боевую очередь (`transferToQueue`)**:
   - Не копирует сырой MP4 в обход правил.
   - Для `otgolosok-creative`: переносит артефакты в `data/daily/<targetDate>/`, записывает `pipelineGitSha`, запускает штатный final review (`creative-final-review.mjs` / `assess-daily.mjs`) и помечает выпуск `ready` (без загрузки на YouTube — публикация идёт штатно через owner gate).
   - Для `otgolosok-shorts`: переносит в `data/runs/<runId>/`, записывает `pipeline_git_sha` в `runs`, пересчитывает `videoSha256` и запускает штатный editorial review (`promo-review.json`), выставляя статус `ready` только при `verdict === 'ready'` и всех `passed` проверках.

### 4.4. Алгоритм оценки когорт и детектора просадки

Реализуется как чистая детерминированная функция в `src/revisions.ts` (полностью покрывается табличными unit-тестами):
- **Атрибуция выпуска к ревизии**:
  1. Если у выпуска есть `pipelineGitSha` → прямое сопоставление с `pipeline_revisions.commit_sha` (по префиксу ≥7 символов).
  2. Иначе (исторические выпуски) → сопоставление по `slotAt ?? updatedAt` с интервалом `[promotedAt, nextPromotedAt)`.
- **Фильтр зрелости**: выпуск попадает в расчёт вердикта, только если `now - publishedAt >= 72h` и `analytics.available === true`.
- **Минимальная контрольная выборка**: `creative` → ≥2 зрелых выпуска; `normal` (`shorts`) → ≥3 зрелых выпуска. Пока меньше — `alertState = 'collecting'`.
- **Извлекаемые метрики по выпуску**:
  - `avgPct = metrics.averageViewPercentage`
  - `hook3s`: интерполяция/ближайшая точка из `retention` при `elapsedRatio ≈ 3 / estimatedDurationSec` (или `elapsedRatio ≈ 0.05–0.08`, если длительность неизвестна)
  - `engagedRate = metrics.engagedViews / metrics.views` (при `views > 0`)
- **Композитная дельта к предыдущей ревизии** (медианы по когортам, доступные метрики ренормализуются по весам):
  - вес `0.45` — относительная дельта `averageViewPercentage`
  - вес `0.35` — относительная дельта `hook3s`
  - вес `0.20` — относительная дельта `engagedRate`
- **Порог деградации**: если `compositeDelta <= -0.15` (просадка >15%) → `alertState = 'degraded'`, красный алерт в UI и однократное push-уведомление (фиксируется в `alert_notified_at`).

---

## 5. Поэтапный план реализации

### Этап 1. Атрибуция `pipelineGitSha` и A/B-режим песочницы (`otgolosok-shorts` + `otgolosok-creative`)
- **`otgolosok-shorts`**:
  - В `src/core/state.ts` добавить миграцию №8: `ALTER TABLE runs ADD COLUMN pipeline_git_sha TEXT;`, пробросить `pipelineGitSha` в `RunRow`, `createRun`/`updateRun` (по умолчанию из `process.env.OTGOLOSOK_PIPELINE_GIT_SHA` или `git rev-parse --short=12 HEAD`, без падения если `.git` недоступен).
  - Добавить/проверить режим local-only A/B-сборки (флаг `--no-upload` / переиспользование озвучки по пути `--reuse-audio <dir>` при неизменном тексте, без мутации боевой SQLite очереди).
  - Добавить/обновить unit-тесты (`src/core/state.test.ts` и тесты переиспользования аудио).
- **`otgolosok-creative`**:
  - Записывать `pipelineGitSha` в `built.json`, `status.json`, `morning-report.json` (`scripts/finalize-daily-publication.mjs`), `release.json` (`scripts/handoff.mjs`).
  - Обновить `scripts/release-snapshot.py`: включить `r.pipeline_git_sha` в SELECT для `items` и `value.get("pipelineGitSha")` для `creative` (обратно совместимо, старые записи возвращают `None`).
  - Добавить вспомогательный скрипт `scripts/ab-sandbox-render.mjs` (или режим в `build-for-slot.mjs`): рендерит выбранный свежий сюжет в изолированную папку без YouTube upload, поддерживает переиспользование аудио v4 при совпадении текста и извлечение ключевых кадров «Было / Стало» через `ffmpeg` по таймкодам `highlights`.
  - Покрыть тестами `tests/` (`npm test`).

### Этап 2. Сервер, SQLite, Host RPC, Media Range Streaming, Расписание и CLI (`bb-plugin-otgolosok-releases`)
- Новые модули в `src/`:
  - `src/retro-contracts.ts` — Zod-схемы для `retro_runs`, `experiments`, `pipeline_revisions`, `ab-manifest.json`, `retroSchedule`, расширение `rpcContract` и `hostContract` (включая `pipelineGitSha` в `releaseSchema`).
  - `src/revisions.ts` — чистая логика атрибуции выпусков, расчёта медиан когорт, 72ч фильтра, детектора просадки >15%.
  - `src/retro-schedule.ts` — вычисление MSK-слотов (дефолт Пт `06:00` creative / Вс `06:00` shorts) и идемпотентного `slot_key`.
  - `src/media.ts` — безопасная валидация медиа-активов (`mp4`, `jpg`, `png`), парсинг заголовка `Range`, TTL-политика 30 дней.
  - `src/retro-orchestrator.ts` — формирование промпта агента-режиссёра, запуск BB-треда ретро и Team Workflow внутри worktree, приём/валидация `ab-manifest.json`, отправка BB push-уведомлений.
- Расширение `host.ts`:
  - проброс `pipelineGitSha` в `snapshot` (из `release-snapshot.py` и `data/daily/*/status.json|built.json`);
  - `gitHeadInfo`, `createWorktree`, `removeWorktree`, `getWorktreeDiff`, `promoteWorktree` (`test → squash merge → push`), `revertCommit` (`revert → test → push`);
  - `statMedia` и `readMediaRange` (потоковое/чанковое чтение байтового диапазона MP4 с хоста для `206 Partial Content`);
  - `cacheExperimentMedia` и `pruneExpiredMedia`;
  - `transferToQueue` (перенос одобренного экспериментального или базового ролика в очередь с прогоном штатных гейтов).
- Расширение `server.ts`:
  - миграции SQLite, `GET /media` с `Range: 206`, `bb.background.schedule('retro-tick', '*/15 * * * *', ...)` (динамическое MSK-расписание + ежедневная проверка деградации ревизий + очистка кэша >30д);
  - новые RPC-методы: `retroState`, `startRetro`, `startExperiment`, `promoteExperiment`, `rejectExperiment`, `revertRevision`, `markVpsDeployed`, `updateRetroSchedule`;
  - новые CLI-команды `bb otgolosok-releases retro ...`, `experiments ...`, `revisions ...`.
- Unit- и интеграционные тесты в `test/` (табличные тесты когорт, просадки, Range-стриминга, валидации путей, git-state guards, расписания).

### Этап 3. Интеграция режиссёра и Team Workflow
- Добавить специализированный промпт/инструкцию и утилиту записи результатов (`bb otgolosok-releases retro record ...` / `experiment record ...`), чтобы оркестратор ретро в BB-треде:
  1. читал свежий ретро-снапшот аналитики + retention + историю прошлых ревизий/отклонений;
  2. сохранял структурированные 2–4 гипотезы в SQLite плагина;
  3. создавал worktree через CLI/RPC плагина;
  4. вызывал `team_workflow_plan` + `bb_workflow_run` (из `bb-plugin-team-workflow`) для реализации топ-1 гипотезы в worktree;
  5. запускал двойной A/B-рендер (baseline + experiment) на свежем сюжете и генерацию `ab-manifest.json` с таймкодами и кадрами «Было / Стало»;
  6. переводил эксперимент в `ready_for_review` и триггерил push-уведомление.
- Обновить `skills/otgolosok-releases/SKILL.md` новыми командами и правилами.

### Этап 4. UI в `bb-plugin-otgolosok-releases` (`app.tsx`, `app.css`, `src/ui-model.ts`)
- Расширить верхнюю навигацию до 5 вкладок: `Очередь`, `Вышедшие`, `Ретро и A/B`, `Ревизии`, `Расписание`.
- **Вкладка «Ретро и A/B»**:
  - переключатель пайплайна (`Creative` / `Обычный`), кнопка «Запустить ретро сейчас», индикатор активного ночного/ручного прогона со ссылкой на BB-тред;
  - блок режиссёрского разбора (ключевые выводы по YouTube-аналитике + список 2–4 гипотез с бейджем «Меняет TTS» / «Без TTS» и кнопкой «Попробовать в worktree» для альтернативных идей);
  - **синхронный A/B-плеер**: два `<video>` (`Текущий` и `Эксперимент`), общая панель управления (`Play/Pause`, таймлайн, скорость `1x / 1.5x`, переключатель звука `Слушать A / Слушать B`);
  - **лента акцентов отличий**: клик по любому пункту (`0:00–0:03 · Новый хук`) перематывает оба плеера в `startSec` и подсвечивает сравнение «Было → Стало» + миниатюры кадров;
  - сворачиваемый блок `Git Diff` и статус автотестов;
  - панель решений:
    - «Применить ревизию» + чекбокс «Забрать экспериментальный ролик в очередь» (с модальным подтверждением);
    - «Отклонить» + опция «Забрать базовый ролик в очередь».
- **Вкладка «Ревизии»**:
  - переключатель пайплайна (`Creative` / `Обычный`);
  - таймлайн ревизий: commit SHA, название гипотезы, дата промоушена, статус (`Активна` / `Заменена` / `Откачена`), бейдж VPS-деплоя для `shorts` с кнопкой «Отметить задеплоенной»;
  - когортные KPI каждой ревизии: число зрелых выпусков (или `Набираем выборку X/Y`), медиана удержания, хук 3с, `engagedViews/views`, цветные дельты к предыдущей ревизии, раскрывающийся список выпусков этой ревизии;
  - при `alertState === 'degraded'` — красный баннер просадки и кнопка «Откатить ревизию (git revert)» с диалогом подтверждения.
- Настройки расписания ретро (день недели и время MSK для `creative` и `shorts`, тумблер авто-прототипа и push-уведомлений) на вкладке «Расписание» / в модалке настроек.

---

## 6. Верификация (Definition of Done)

1. **`otgolosok-shorts`**: `pnpm check` (format, lint, typecheck, unit tests) зелёный; проверена миграция существующей БД на новую колонку `pipeline_git_sha`.
2. **`otgolosok-creative`**: `npm test` зелёный; проверен вывод `python3 scripts/release-snapshot.py <shortsRoot>` с `pipelineGitSha`.
3. **`bb-plugin-otgolosok-releases`**: `npm run check` (typecheck + `node --test`), `bb plugin build .`, `bb plugin install . --yes`.
4. **End-to-end проверка**:
   - проверка `GET /media` с `Range: bytes=0-1023` (`206 Partial Content`, отказ на path traversal и symlink);
   - сухой прогон ретро-команд CLI (`retro`, `experiments`, `revisions`);
   - проверка когортного расчёта и срабатывания алерта просадки на фикстурах (72ч фильтр, минимальная выборка, ренормализация весов);
   - проверка UI всех 5 вкладок и синхронного A/B-плеера;
   - все коммиты во всех затронутых репозиториях оформлены по Conventional Commits и запушены.
