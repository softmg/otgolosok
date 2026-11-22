---
name: daily-episode-orchestrator
description: "Оркестрировать ежедневную локальную сборку выпуска Отголоска через durable BB Workflow с автоматическим подбором живых фолбэк-моделей, независимой верификацией каждого этапа и эскалацией тупиков. Применять при запуске сборки ролика на сегодня/завтра или в утренних автоматизациях."
---

# Ежедневный оркестратор сборки выпуска Отголоска

Этот скил запускает детерминированную многоагентную сборку ежедневного выпуска Отголоска через сохранённый workflow `.bb/workflows/daily-episode.js`, подбирая актуальные цепочки фолбэк-моделей из живого каталога BB и состояния `airouter-pool`.

## Границы и безопасность

- **Автоматическая публикация на YouTube запрещена** (только локальная сборка до `durable/status.json -> approved`).
- **Не подделывать квитанции** (`visual-material.json`, `preproduction-*.json`, `promo-review.json`, `audio-qc.json`), не снижать пороги `< 7/10`, не обходить гейты.
- **Grok (`acp-grok`) не использовать** в цепочках сборки (высокий риск фальшивых отчётов и циклов на HTTP 429).
- **Не делать частый ручной поллинг** таймерами `schedule` — BB сам уведомляет о завершении workflow.

## Порядок запуска

### 1. Определить целевую дату по Москве

- На завтра (утренние автоматизации по умолчанию — чтобы был запас в день для корректировок — и явный запрос «на завтра»): `TZ=Europe/Moscow date -v+1d +%F` (macOS)
- На сегодня (только по явному запросу «на сегодня»): `TZ=Europe/Moscow date +%F`

### 2. Собрать живые цепочки фолбэк-моделей

Запусти детерминированный резолвер (он проверяет `bb provider list`, `bb provider models` по каждому провайдеру и `bb airouter-pool status --json`, выкидывает отсутствующие модели/провайдеры и автоматически сдвигает Codex в конец цепочки, если пул исчерпан):

```bash
node .agents/skills/daily-episode-orchestrator/scripts/resolve-model-chains.mjs \
  --environment "$BB_ENVIRONMENT_ID" \
  --json
```

Если в выводе `warnings` указано, что пул Codex деградировал (`codexPoolHealthy: false`), `codex`-модели уже автоматически опущены ниже `claude-code` и `acp-antigravity-acp`. При необходимости принудительно экономить Codex передай `--prefer-non-codex`.

Проверь, что у всех четырёх ролей (`light`, `worker`, `visual`, `architect`) есть минимум по одному живому кандидату.

### 3. Валидировать и запустить workflow

Перед запуском проверь валидность workflow по живому каталогу:

```bash
bb workflows validate --name daily-episode
```

Если валидатор отклонил устаревшую модель в `invokeLiteralAgent` (модель убрали из каталога провайдера), удали эту ветку `case` из `.bb/workflows/daily-episode.js` и соответствующий элемент из `DEFAULT_ROLE_CHAINS` в `resolve-model-chains.mjs`, перепроверь валидацию и запускай.

Запусти workflow через инструмент `bb_workflow_run`:
- `name`: `"daily-episode"`
- `args`: JSON-объект (НЕ строка!):
  ```json
  {
    "date": "<YYYY-MM-DD>",
    "creativeRoot": "/Users/user/projects/ai/otgolosok-creative",
    "shortsRoot": "/Users/user/projects/ai/otgolosok-shorts",
    "maxEarlyAttempts": 3,
    "allowSecondSameDayAfterHours": 8,
    "modelChains": "<объект modelChains из шага 2>"
  }
  ```

После успешного вызова `bb_workflow_run` выведи полученный `previewDirective` **ровно один раз отдельной строкой** (без code fence) и заверши ход — система разбудит тебя по завершении workflow.

### 4. Разбор итога и эскалация блокеров

- **`status: "approved"`**:
  - Если во время сборки правились скрипты/тесты в `/Users/user/projects/ai/otgolosok-creative`, проверь `git status -sb`, прогони `/Users/user/.agents/bin/agent-pool test -- npm test`, сделай атомарный коммит и push.
  - Отчитайся пользователю на русском: путь и SHA-256 `promo-video.mp4`, обложка, оценки `preproduction-early` / `preproduction-measured` / `promo-review` / `audio-qc`, статус `durable`, и `modelAudit` (какие модели и фолбэки реально сработали).
- **`status: "already_done"`**:
  - Сообщи, почему сборка пропущена (уже собран/запланирован/опубликован выпуск в пределах 8 часов).
- **`status: "blocked"`**:
  - Выгрузи ограниченную страницу истории workflow в `$BB_THREAD_STORAGE/workflows/<run-id>.jsonl` (`bb workflows history <run-id> --cursor 0 --limit 100`), найди точную причину остановки.
  - Устрани узкий блокер сам (например, баг конвейера, поиск альтернативного источника через Airouter Perplexity или уточнение визуала — строго по правилам, без подделки квитанций).
  - Перезапусти workflow с **`resumeRunId: "<run-id>"`** и теми же `args` (пройденные этапы возьмутся из кэша).
  - Если блокер требует решения владельца (например, протух OAuth-токен YouTube или нет свободных фото ни по одному кандидату), остановись, сохрани состояние и чётко сообщи пользователю, что нужно сделать.
