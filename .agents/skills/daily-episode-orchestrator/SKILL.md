---
name: daily-episode-orchestrator
description: "Оркестрировать ежедневную локальную сборку выпуска Отголоска через durable BB Workflow с автоматическим подбором живых фолбэк-моделей, независимой верификацией каждого этапа и эскалацией тупиков. Применять при запуске сборки ролика на сегодня/завтра или в утренних автоматизациях."
---

# Ежедневный оркестратор сборки выпуска Отголоска (Team Orchestration v2)

Этот скил запускает детерминированную многоагентную сборку ежедневного выпуска Отголоска через сохранённый workflow `.bb/workflows/daily-episode.js`, подбирая актуальные цепочки фолбэк-моделей из живого каталога BB и состояния `airouter-pool`.

## Архитектура Team Orchestration

Workflow разделён на 7 фаз с чёткими границами владения и кросс-семейной верификацией:

1. **Preflight & Infra Gate (`light`)**: YouTube OAuth + слот + быстрая проверка `scripts/preflight-infra-check.mjs` (headless Chrome, `ffmpeg`/`ffprobe`, smoke viewer `otgolosok.online/walk`). Окружение проверяется на 1-й минуте, а не после рендера.
2. **Episode Architect (`architect`, read-only)**: выбирает/проверяет кандидата, заранее проверяет наличие >=3 разных свободных фото именно места (fail-fast `candidate_unfit`) и пишет единый `data/daily/<date>/episode-brief.json`. Фоновый `LaunchAgent`-поллинг запрещён.
3. **Parallel Asset Production (`parallel()`)**: три узких агента с непересекающимися файлами — Researcher (`light`), Media Hunter (`visual` — Gemini 4 Neon), Scriptwriter (`worker` — Codex 6.1 Sol → Antigravity Claude Sonnet 5.5).
4. **Pre-Gate & Cross-Family Review**: перед каждым LLM-аудитом обязательно запускается бесплатный детерминированный `scripts/episode-pregate.mjs` (<2 с), затем `preproduction-review.mjs --phase early` (не больше `maxEarlyAttempts: 2`), после чего **кросс-семейный Reviewer** проверяет квитанции на диске и чистоту `scripts/`.
5. **Locked Render & Audit**: контент заморожен (`script.json`, `shots.json`, `rights.json` менять запрещено). Выполняются озвучка ElevenLabs v4, `measured-frame`, рендер MP4, `creative-review`/`promo-review`, `audio-qc` и `npm run video:durable`.
6. **Final Gate (`light`, cross-family)**: сверка SHA-256, квитанций, голоса `eleven_v4` («Отголосок2»), `durable/status.json === "approved"` и чистоты `scripts/`.
7. **Scheduled YouTube Publish**: только отложенная публикация (`private` + `publishAt`) и независимый readback.

## Роли и цепочки моделей

- **`architect` / `reviewer`**: `codex/gpt-6-astra` (`high`) → `acp-antigravity-acp/gemini-4-neon` (`high`) → `acp-antigravity-acp/claude-opus-5-5`.
- **`worker`**: `codex/gpt-6.1-sol` (`high`) → `acp-antigravity-acp/claude-sonnet-5-5` → `acp-antigravity-acp/gemini-4-neon` (`high`) → `codex/gpt-6-astra` (`high`).
- **`visual`**: `acp-antigravity-acp/gemini-4-neon` (`high`) → `codex/gpt-6.1-terra` (`high`) → `acp-antigravity-acp/claude-sonnet-5-5`.
- **`light`**: `acp-antigravity-acp/gemini-3.8-flash` → `codex/gpt-6-luna` (`medium`) → `acp-opencode/opencode/deepseek-v4.1-flash-free`.
- **`claude-code`** и **`acp-grok`** исключены политикой оркестратора; при сбое квоты/capacity/транспорта `runRole` приоритетно переключается на **другую семью моделей**.

## Границы и безопасность

- **Только отложенная публикация на YouTube (`private` + `publishAt`)** — строго после `Final Gate` (`durable/status.json -> approved`). Немедленная публикация (`--privacy public`) запрещена.
- **Разделение контента и кода движка**: контентным воркерам `daily-episode` запрещено редактировать `otgolosok-creative/scripts/*.mjs`. При баге конвейера воркер возвращает `blockClass: "code_bug"` + `codeBug`, а координатор запускает отдельный **`team-workflow` (`team-aer`)** для починки кода с тестами и кросс-семейным ревью.
- **Запрет на ручные марафоны в треде координатора**: координатору запрещено вручную запускать десятки итераций `preproduction-review` в своём контексте. Реакция на блокер — строго по `blockClass` (см. шаг 4).
- **Не подделывать квитанции** (`visual-material.json`, `preproduction-*.json`, `promo-review.json`, `creative-review.json`, `audio-qc.json`), не снижать пороги `< 7/10`, не обходить гейты.
- **Порядок провайдеров**: сначала локальная подписка → Airouter Pool → прямой Airouter (лимит тела <= 9 000 000 байт).
- **Не делать ручной поллинг** таймерами `schedule` — BB сам уведомляет о завершении workflow.

## Порядок запуска

### 1. Определить целевую дату по Москве

- На завтра (утренние автоматизации по умолчанию и явный запрос «на завтра»): `TZ=Europe/Moscow date -v+1d +%F` (macOS)
- На сегодня (только по явному запросу «на сегодня»): `TZ=Europe/Moscow date +%F`

### 2. Собрать живые цепочки фолбэк-моделей

```bash
node .agents/skills/daily-episode-orchestrator/scripts/resolve-model-chains.mjs \
  --environment "$BB_ENVIRONMENT_ID" \
  --json
```

Проверь, что у всех пяти ролей (`light`, `worker`, `visual`, `architect`, `reviewer`) есть минимум по одному живому кандидату (при `--prefer-non-codex` или деградации пула Codex модели `codex` автоматически сдвигаются за Antigravity/OpenCode).

### 3. Валидировать и запустить workflow

```bash
bb workflows validate --name daily-episode
```

Запусти workflow через инструмент `bb_workflow_run`:
- `name`: `"daily-episode"`
- `args`: JSON-объект (НЕ строка!):
  ```json
  {
    "date": "<YYYY-MM-DD>",
    "creativeRoot": "/Users/user/projects/ai/otgolosok-creative",
    "shortsRoot": "/Users/user/projects/ai/otgolosok-shorts",
    "maxEarlyAttempts": 2,
    "allowSecondSameDayAfterHours": 8,
    "publishScheduled": true,
    "modelChains": "<объект modelChains из шага 2>"
  }
  ```

После успешного вызова `bb_workflow_run` выведи полученный `previewDirective` **ровно один раз отдельной строкой** (без code fence) и заверши ход.

### 4. Триаж результата и эскалация по `blockClass`

- **`status: "published"` / `"approved"`**:
  - Отчитайся пользователю на русском: путь и SHA-256 видео, обложка, оценки, статус `durable`, при `published` — `youtubeVideoId`, Shorts URL, время `publishAt`, путь к `youtube-publish.json` и `modelAudit`.
- **`status: "already_done"`**:
  - Сообщи причину пропуска (выпуск уже собран/запланирован в пределах 8 часов).
- **`status: "blocked"`** — выгрузи историю (`bb workflows history <run-id> --cursor 0 --limit 100 > "$BB_THREAD_STORAGE/wf.jsonl"`) и действуй строго по `blockClass`:
  - **`code_bug`**: НЕ правь код руками в треде координатора! Запусти `team_workflow_plan` (`team-aer`) с точным описанием `codeBug` (файл, симптом, воспроизведение, регрессионный тест). После `approved` (коммит + push) возобнови `daily-episode` через `resumeRunId`.
  - **`infra`** (`BROWSER_ENVIRONMENT_UNAVAILABLE`, OAuth, viewer down): проверь/восстанови окружение или эскалируй владельцу — не трать время на контент при сломанной инфраструктуре.
  - **`candidate_unfit`** (нет >=3 разных свободных фото места): переключи выпуск на следующего кандидата из очереди и перезапусти, не вымучивая непригодный сюжет.
  - **`editorial_blocker` / `audio_defect` / `publish_blocker`**: сделай точечную диагностику (не более 2 команд) и либо перезапусти через `resumeRunId`, либо эскалируй владельцу с чётким списком действий.
