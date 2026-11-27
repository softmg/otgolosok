---
name: daily-episode-orchestrator
description: "Оркестрировать ежедневную локальную сборку выпуска Отголоска через durable BB Workflow с автоматическим подбором живых фолбэк-моделей, независимой верификацией каждого этапа и эскалацией тупиков. Применять при запуске сборки ролика на сегодня/завтра или в утренних автоматизациях."
---

# Ежедневный оркестратор сборки выпуска Отголоска (Team Orchestration v2)

Этот скил запускает детерминированную многоагентную сборку ежедневного выпуска Отголоска через сохранённый workflow `.bb/workflows/daily-episode.js`, подбирая актуальные цепочки фолбэк-моделей из живого каталога BB и состояния `airouter-pool`.

## Архитектура Team Orchestration

Workflow разделён на 7 фаз с чёткими границами владения и кросс-семейной верификацией:

1. **Preflight & Infra Gate (`light`)**: YouTube OAuth + слот + быстрая проверка `scripts/preflight-infra-check.mjs` (headless Chrome, `ffmpeg`/`ffprobe`, smoke viewer `otgolosok.online/walk`). Окружение проверяется на 1-й минуте, а не после рендера.
2. **Episode Architect (`architect`, read-only)**: выбирает/проверяет кандидата, делает быструю разведку фото через `scripts/photo-search.mjs` по [VIS-02](../../../../otgolosok-shorts/assets/promo-review/visual.md#vis-02) (fail-fast `candidate_unfit`) и пишет единый `data/daily/<date>/episode-brief.json`. Границы роли — [ORCH-01](../../../docs/instructions/orchestration.md#orch-01).
3. **Fail-Fast Media Gate & Parallel Assets**: сначала `Media Hunter` (`visual` — Gemini 4 Neon) собирает свободные фото через `scripts/photo-search.mjs` (Commons + подкатегории + статьи Wikipedia + Openverse) и проходит `ensureVisualMaterial`; только при зелёном Media Gate в `parallel()` запускаются Researcher (`light`) и Scriptwriter (`worker` — Codex 6.1 Sol → Antigravity Claude Sonnet 5.5) уже с опорой на реальные фото.
4. **Pre-Gate & Cross-Family Review**: `scripts/episode-pregate.mjs` (<2 с), затем `preproduction-review.mjs --phase early`; допуск — [VERIFY-01](../../../docs/instructions/verification.md#verify-01), попытки — [ORCH-02](../../../docs/instructions/orchestration.md#orch-02), Reviewer и `scriptsClean` — [ORCH-01](../../../docs/instructions/orchestration.md#orch-01).
5. **Locked Render & Audit**: freeze по [STATE-04](../../../docs/instructions/episode-state.md#state-04). Выполняются озвучка по [AUDIO-01](../../../../otgolosok-shorts/assets/promo-review/audio.md#audio-01), `measured-frame`, рендер MP4, `creative-review`/`promo-review`, `audio-qc` и `npm run video:durable`.
6. **Final Gate (`light`, cross-family)**: проверка по [VERIFY-02](../../../docs/instructions/verification.md#verify-02), [AUDIO-01](../../../../otgolosok-shorts/assets/promo-review/audio.md#audio-01) и [ORCH-01](../../../docs/instructions/orchestration.md#orch-01).
7. **Scheduled YouTube Publish**: публикация по [PUB-01](../../../docs/instructions/publication.md#pub-01) и [PUB-02](../../../docs/instructions/publication.md#pub-02).

## Роли и цепочки моделей

- **`architect` / `reviewer`**: `codex/gpt-6-astra` (`high`) → `acp-antigravity-acp/gemini-4-neon` (`high`) → `acp-antigravity-acp/claude-opus-5-5`.
- **`worker`**: `codex/gpt-6.1-sol` (`high`) → `acp-antigravity-acp/claude-sonnet-5-5` → `acp-antigravity-acp/gemini-4-neon` (`high`) → `codex/gpt-6-astra` (`high`).
- **`visual`**: `acp-antigravity-acp/gemini-4-neon` (`high`) → `codex/gpt-6.1-terra` (`high`) → `acp-antigravity-acp/claude-sonnet-5-5`.
- **`light`**: `acp-antigravity-acp/gemini-3.8-flash` → `codex/gpt-6-luna` (`medium`) → `acp-opencode/opencode/deepseek-v4.1-flash-free`.
- **`claude-code`** и **`acp-grok`** исключены политикой оркестратора; при сбое квоты/capacity/транспорта `runRole` приоритетно переключается на **другую семью моделей**.

## Границы и безопасность

- Публикационные полномочия и readback: [PUB-01](../../../docs/instructions/publication.md#pub-01), [PUB-02](../../../docs/instructions/publication.md#pub-02).
- В результате бага сохраняй `blockClass: "code_bug"` и объект `codeBug`; квитанции включают `visual-material.json`, `preproduction-*.json`, `promo-review.json`, `creative-review.json`, `audio-qc.json`.
- Владение файлами, независимость и отсутствие поллинга: [ORCH-01](../../../docs/instructions/orchestration.md#orch-01).
- Попытки, возобновление и эскалация: [ORCH-02](../../../docs/instructions/orchestration.md#orch-02), [ORCH-03](../../../docs/instructions/orchestration.md#orch-03).
- Квитанции и допуск: [VERIFY-01](../../../docs/instructions/verification.md#verify-01), [VERIFY-02](../../../docs/instructions/verification.md#verify-02).
- Провайдеры: [PROV-01](../../../docs/instructions/providers-and-payloads.md#prov-01).
- BB сам уведомляет о завершении workflow; схема триажа приведена ниже.

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
  - Сообщи причину пропуска, сверив слот по [PUB-01](../../../docs/instructions/publication.md#pub-01).
- **`status: "blocked"`** — выгрузи историю (`bb workflows history <run-id> --cursor 0 --limit 100 > "$BB_THREAD_STORAGE/wf.jsonl"`) и действуй строго по `blockClass`:
  - **`code_bug`**: По [ORCH-01](../../../docs/instructions/orchestration.md#orch-01) запусти `team_workflow_plan` (`team-aer`) с точным описанием `codeBug` (файл, симптом, воспроизведение, регрессионный тест). После `approved` и разрешённого Git-цикла по [ENG-01](../../../docs/instructions/engineering.md#eng-01) возобнови `daily-episode` через `resumeRunId`.
  - **`infra`** (`BROWSER_ENVIRONMENT_UNAVAILABLE`, OAuth, viewer down): проверь/восстанови окружение или эскалируй владельцу — не трать время на контент при сломанной инфраструктуре.
  - **`candidate_unfit`** (не выполнен фото-контракт VIS-02 / `ensureVisualMaterial`): переключи выпуск на следующего кандидата из очереди (архивировав прежнего в `superseded/` по [STATE-01](../../../docs/instructions/episode-state.md#state-01)) и перезапусти workflow **через `resumeRunId` прежнего прогона с новым `args.candidateKey` (например, ID нового места)** — тогда `Preflight & Infra Gate` мгновенно возьмётся из кэша без повторных проверок OAuth/Chrome, а сборка начнётся сразу с `Episode Architect`.
  - **`editorial_blocker` / `audio_defect` / `publish_blocker`**: сделай точечную диагностику (не более 2 команд) и либо перезапусти через `resumeRunId`, либо эскалируй владельцу с чётким списком действий.
