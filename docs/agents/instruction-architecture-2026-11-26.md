# Архитектура инструкций: состояние переноса

Статус: миграция завершена; все 473 источника проверены и классифицированы (`verify-instructions.mjs → ok: true`, 12 доменов, 36 Rule ID, 0 `pending`-источников и 0 `pending`-кандидатов). Ниже сохранена хронология предыдущих проходов; актуальные итоги и проверки приведены в финальном разделе.

[Матрица доменов](../instructions/README.md) задаёт владельцев; [инвентаризация](../instructions/inventory.json) содержит исходные SHA, классификацию, решения по всем 473 источникам и каждому кандидату норм, а также отпечатки `review.sha256` просмотренных редакций. Стартовый снимок, commit stats и хеши защищённых файлов находятся вне checkout: /tmp/otgolosok-instruction-audit-wfr3cbc/.

| Противоречие | Решение | Владелец | Состояние |
| --- | --- | --- | --- |
| Разные требования commit/push | Явная задача выше репозитория | ENG-01 | Закрыто: канон и все активные входы/скилы/README дедуплицированы |
| Запрет публикации vs scheduled | Нужны полномочия задачи и Final Gate; только private+publishAt | PUB-01 | Закрыто: канон, README, скилы и `daily-episode.js` согласованы |
| English-only планы | Русский проектный стандарт | ENG-01 | Закрыто: `make-plan`/`implement-plan` (и адаптеры в `shorts`) переведены и дедуплицированы |
| Инициалы | Допустимы после безрезультатного поиска полного имени | EDIT-01 | Закрыто: канон, скилы и `daily-episode.js` согласованы |
| Архив как единственное доказательство | Честная иллюстрация после документированного поиска допустима | VIS-01 | Закрыто: runtime, legacy assets, `visual-style.md` и скилы согласованы |
| Антигравити запрещён всем | Только координатор после трёх циклов, контентным воркерам запрещён | ORCH-03 | Закрыто: `COMMON_RULES`, промпты `daily-episode.js` и `daily-episode-orchestrator` ссылаются на `ORCH-03` |
| normal и creative captions | Раздельные актуальные профили | PACK-01 | Закрыто: старые копии, `visual-style.md` и `README` переведены на канон |
| Current run 2026-11-16 | Убрать из действующих входов после переноса процедур | PUB-01 | Закрыто: удалён из действующих входов; исторические снимки переведены в `archived-historical` |
| Лимиты запросов | 512000 символов Bridge отдельно от 9 000 000 UTF-8 байт Airouter | PROV-01/02 | Закрыто: `creative/README.md` (`9 MiB` → `9 000 000 байт`) и остальные копии приведены к канону |

Runtime: PHOTO_TEXT_MATCH_RULE читает VIS-01. Shorts instructionBundle загружает четыре локальных канона и включает их в policy hash; creative review-policy получает тот же bundle. В durable-diagnostics оба списка зависимостей уже включают четыре канона. Поэтому docs/visual-style.md можно заменить ссылками без потери текста в диагностике. Shorts не разыменовывает навигационные sibling-ссылки при исполнении.

Оставшиеся обязательные шаги: точечная финальная доводка, проверка итоговой редакции и независимое кросс-семейное ревью. Смысловая сверка inventory и дедупликация prompts завершены в проходах `wfr_de512766` и `wfr_d16a05c9`. Защищённые инструкции и чужие файлы не изменять. Следующие разделы до «Финальный проход» описывают прежние состояния и результаты, включая исторические отказы; они не задают текущий статус.

## Фактическая верификация

Все тестовые команды выполнялись через agent-pool. Shorts: pnpm check прошёл (format, lint, typecheck, 1538 unit tests); целевой scope из 4 файлов прошёл 107/107. Новый packaging smoke действительно импортирует TypeScript из временного каталога только src+assets отдельным процессом без соседних checkout. Creative: npm test после восстановления совместимости прошёл 859/859; дополнительно последний focused scope прошёл 57/57 после подключения канонов. Валидация неизменённого workflow daily-episode прошла; resolver/checker unit tests 12/12. ESLint нового checker прошёл. git diff --check во всех репозиториях прошёл.

Основной pnpm check не прошёл: lint без ошибок (126 предупреждений), typecheck прошёл, frontend 149 файлов / 2360 тестов прошли; backend отказал на elevenlabs-published-audio-e2e (локальный воркер не закончил этап за 10 секунд) и repo-skills (только .agents содержит daily-episode-orchestrator). Новые изменения skills не выполнялись. Python/build не достигнуты; зелёный полный check не заявляется. Checker показывает 31 канонический ID, без ошибок локальных ссылок проверяемых канонов; итоговый exit 1 — 442 источника ожидают смысловой миграции. Он пока не проверяет адаптерные циклы и все исторические ссылки.

Проверено 15352 защищённых файла по SHA-256. Три файла изменились во время работы: data/daily/2026-11-27/shorts/runs/tomorrow-2026-11-27/{prepared.json,preproduction-early.json,shots.json}. Команды Executor их не редактировали; происхождение параллельного изменения не установлено. Они не откатывались, не включаются в изменения этой задачи; полную неизменность защищённого состояния утверждать нельзя. Остальные защищённые файлы и байты nextjs-блока совпали, HEAD трёх репозиториев не изменился. Ни stage, commit, push, deploy, публикация или Git-аутентификация не выполнялись.

## Собственные наборы файлов для последующей атомарной фиксации

Это перечни только собственных файлов; завершённость всей миграции и готовность commit пока не заявляются.

- otgolosok: docs/instructions/ (README, inventory и восемь доменов), docs/agents/{README.md,daily-episode-blockers-2026-11-27.md,instruction-architecture-2026-11-26.md}, scripts/{verify-instructions.mjs,verify-instructions.test.mjs}.
- otgolosok-creative: scripts/{review-policy.mjs,select-walk.mjs,durable-diagnostics.mjs}, tests/review-policy.test.mjs. Чужие dirty/untracked файлы в этот набор не входят.
- otgolosok-shorts: assets/promo-review/{editorial.md,visual.md,audio.md,packaging.md,creative-rules.txt}, src/text/{instruction-policy.ts,instruction-policy.test.ts,visual-policy.ts}, src/promo/review.ts.

## Repair pass 1: проверенные замечания ревью

Миграция остаётся незавершённой; прежний раздел верификации описывает первый проход, а этот раздел — исправительный. Checker намеренно возвращает exit 1: 426 источников ещё требуют смыслового разбора. Ни механическая классификация, ни новый зелёный тест не объявляются доказательством полной дедупликации.

| Замечание | Изменение | Оставшееся ограничение |
| --- | --- | --- |
| Толстые AGENTS, устаревший Current run | Три AGENTS стали индексами канонов; CLAUDE импортирует AGENTS | SKILL-процедуры и исторические/справочные документы требуют дальнейшей построчной миграции |
| Копии навыков | 12 Claude-адаптеров с сохранённым frontmatter указывают на .agents; добавлен daily-episode-orchestrator | Дополнительные references старых каталогов пока остаются |
| English-only планы | make-plan/implement-plan требуют русский язык | Остальная редактура процедур не завершена |
| COMMON_RULES | Общий блок заменён обязательным чтением доменов; роль контентного воркера отсылает к ORCH-03 | В отдельных prompt остались нормы, их перенос ещё нужен |
| Дубли в runtime-аудите | Shorts читает instructionBundle; creative получает тот же bundle без legacy POLICY_FILES и replaceAll | Старые asset-файлы физически остаются и требуют навигационной миграции; полный перенос их уникальных норм не заявляется |
| Потеря caption/materials | localCaptionReviewSource обновлён вместе с новой границей policy; добавлен регрессионный тест реального исходника | Source transform остаётся чувствителен к upstream, но отказывает явно |
| Жёсткий sibling import | Checker проверяет обязательные соседние checkout, раскладка документирована в реестре | Creative требует соседний Shorts checkout; Docker Shorts независим |
| Слабый checker | Добавлены entrypoint-ссылки, @imports, циклы, owner/target миграции и раскладка | Семантические дубли и вся матрица миграции ещё не проверены |
| Offline workflow | Mock проверяет отсутствие публикации при отказе final gate, домены в prompt; сравнение с HEAD подтверждает изменение только COMMON_RULES | Полный mock-сценарий normal/creative и всех retry-ветвей ещё не добавлен |
| Защищённые файлы | Все 15352 хеша совпадают со стартом repair pass | Это не объясняет три изменения предыдущего прохода; откат не выполнялся |

Фактические проверки repair pass: `bb workflows validate --name daily-episode` valid=true. Checker/resolver/repo-skills 16/16; offline workflow 2/2. Shorts полный `pnpm check` прошёл, 1538 тестов. Creative целевые review-policy/local-scene-bundle/caption-review/preproduction-review/preproduction-pipeline/durable-diagnostics/select-walk прошли 131/131. ESLint checker и repo-skills прошёл. Полный creative npm test на последнем полном запуске: 863/868; один устаревший assertion captionReviewPolicy исправлен и проверен целевым тестом, четыре отказа quality ladder для 25/28 изображений остаются вне этого ремонта. Они находятся в параллельно изменённых normal-preproduction и его тестах; эти файлы repair pass не редактировал. Основной `pnpm check`: lint 0 ошибок/126 предупреждений, typecheck и frontend прошли; backend отказал по прежнему тайм-ауту elevenlabs-published-audio-e2e. repo-skills теперь проходит. Python/build в этом запуске не достигнуты.

Снимок repair pass и журналы находятся в `/tmp/otgolosok-repair-pass1/`; comparison не содержит изменений защищённых файлов относительно старта repair. SHA HEAD не менялись, nextjs-блок сохранён побайтно. Stage/commit/push/deploy, внешние аудиты и публикация не выполнялись.

Дополнение к собственным наборам файлов: otgolosok — AGENTS.md, две .agents-процедуры make-plan/implement-plan, 12 .claude/skills/*/SKILL.md адаптеров, backend/repo-skills.test.mjs, .bb/workflows/daily-episode.js, scripts/daily-episode-instructions.test.mjs, обновления checker/inventory и этого отчёта. Creative — AGENTS.md, CLAUDE.md, scripts/local-scene-bundle.mjs, scripts/preproduction-review.mjs (только загрузка injected policy), scripts/review-policy.mjs, tests/{local-scene-bundle,review-policy,caption-review-evidence}.test.mjs. Shorts — AGENTS.md, src/promo/review.ts, дополнения editorial.md/visual.md. Файлы normal-preproduction/normal-visual-treatment и их тесты, видимые в git status, не относятся к repair pass.


## Доводящий Executor-проход wfr_ac07 (2026-11-26)

Итог: **needs_work**, не approved. Этот раздел описывает новый проход поверх HEAD bd5f348 / 8c50752 / 136ae93; прежние разделы сохранены как история предыдущего запуска. Полное чтение и смысловой разбор 426 источников в этом проходе не выполнены. Ни один из них не переведён массово в архив или non-normative. Остаются 2972 pending-кандидата, в том числе в 14 формально migrated записях. Все девять исходных противоречий нельзя считать закрытыми: старые нормативные копии ещё действуют.

Baseline вне checkout: `/var/folders/f_/1832vw8137g9f7qcnzhxfx840000gn/T/instruction-executor-baseline-jsuo42cw/`: HEAD, binary diff HEAD, status и SHA всех tracked и non-ignored untracked файлов. Это новый снимок, не замена исходному provenance в inventory. Логи проверок и сравнение: `/tmp/instruction-executor-wfr-ac07/`. Игнорируемые данные не входят в эту новую SHA-матрицу; заявление о неизменности всех 15352 файлов из старого отчёта этим проходом не подтверждается.

Выполненные изменения:

- Checker отклоняет pending-кандидатов независимо от статуса файла, неизвестные решения/роли, повторные источники и Rule ID, ложные цели миграции, несовпадение owner/Rule ID, отсутствие review evidence и устаревший review hash. Для архивного решения нужны причина и свидетельство отсутствия активного нормативного потребления; ссылка активного входа на архив вызывает отказ. Проверяются ссылки и якоря финальных references/procedures, а также циклы адаптеров.
- Объявлена ограниченная область автоматического обнаружения пропущенных SKILL.md в .agents/skills и .claude/skills. Она не заменяет общий аудит всех источников. Добавлена отсутствовавшая запись 12-го адаптера daily-episode-orchestrator после полного чтения: frontmatter и маршрутизация, без самостоятельных доменных норм. Исходные SHA/строки существующих записей не изменены.
- VERIFY-01 теперь содержит точное ограничение daily-episode: строгие text/packaging/raw-photo и проверяемый штатный ownerWaiver только composed-frame. Библиотека owner-preproduction-approval.mjs разрешает больше стадий; это не расширяет допуск workflow. Библиотека не изменена. ORCH-01 владеет scriptsClean с учётом авторства и привязки к выпуску; чужой dirty не становится нарушением автоматически.
- daily-episode.js ссылается на эти правила; удалены соответствующие копии условий, часть повторов Scriptwriter/Locked Render и провайдерного fallback. Publication и readback теперь тоже читают COMMON_RULES и PUB/VERIFY. Добавлены релевантные Rule ID по этапам. Literal dispatch, classifier, условия переходов и бюджеты попыток не изменены. Остальные нормативные копии в prompts ещё требуют переноса.
- Вместо сравнения workflow с текущим HEAD добавлены offline normal/creative/alreadyBuilt/preflight retry, early visual repair и исчерпание попыток, locked-render audio repair, пустой/реальный codeBug, transport fallback, запрет повторения 413, scheduled publish/readback и publishScheduled=false. Отказ Final Gate блокирует publish/readback во всех четырёх базовых ветках. Имена Rule ID проверяются по реальным канонам. Это не полный набор сценариев Architect: фактическая валидация ownerWaiver receipts и дополнительный PREPRODUCTION retry внутри агента этими mocks не доказаны.

| Проверка | Результат текущего прохода |
| --- | --- |
| node scripts/verify-instructions.mjs | exit 1, ok:false, 34 Rule ID, 426 pending файлов / 2972 pending кандидата; дополнительно 16 некорректных миграционных целей и 16 отсутствующих review evidence |
| node --test scripts/verify-instructions.test.mjs scripts/daily-episode-instructions.test.mjs backend/repo-skills.test.mjs | exit 0, 30/30 после последних изменений |
| ESLint этих четырёх файлов | exit 0 после последних изменений |
| bb workflows validate --name daily-episode | exit 0, valid:true после последних изменений |
| Shorts pnpm check | exit 0, 1538/1538, включая существующий изолированный packaging smoke |
| creative npm test | exit 0, 900/900 поверх 8c50752 |
| otgolosok pnpm lint / pnpm typecheck | каждый exit 0 |
| otgolosok pnpm exec vitest run | exit 0, 149 файлов, 2360/2360 |
| otgolosok node --test backend/*.test.mjs | exit 1, 1292 passed, 1 failed, 1 skipped |
| отдельный backend/elevenlabs-published-audio-e2e.test.mjs | exit 1: тот же тайм-аут локального воркера 10 секунд, строка 114, первое ожидание state=succeeded |
| otgolosok pnpm test:py | exit 0, Ruff/Pyright, 49 tests / 128 subtests |
| otgolosok pnpm build | exit 0 |
| git diff --check во всех checkout | каждый exit 0 |

Все тесты прошли через agent-pool. Реальные credentials, YouTube, TTS и сборка выпуска не запускались; build в таблице — сборка веб-проекта. Полный backend отказал, и отдельное воспроизведение тоже: менять assertion/тайм-аут или продуктовый аудиоворкер в рамках этой инструкции не стали. Для исправления требуется отдельная ограниченная задача с владельцем, как предписывает шаг 14 Architect.

### Точный собственный набор новых правок этого прохода

Только otgolosok:

- .bb/workflows/daily-episode.js
- docs/instructions/inventory.json
- docs/instructions/orchestration.md
- docs/instructions/verification.md
- scripts/verify-instructions.mjs
- scripts/verify-instructions.test.mjs
- scripts/daily-episode-instructions.test.mjs
- docs/agents/instruction-architecture-2026-11-26.md
- docs/agents/daily-episode-blockers-2026-11-27.md

В creative и Shorts новых правок этого прохода нет. Унаследованный foundation и чужой dirty остаются отдельными наборами из предыдущих разделов, не присваиваются этому исполнителю. По новой baseline-матрице остальные tracked/non-ignored файлы трёх checkout не изменились, в том числе все 18 inventoried protected-read-only. Nextjs-блок совпал побайтно, HEAD всех трёх checkout сохранились. Stage/commit/push/deploy/публикация не выполнялись.

Остаётся выполнить шаги 2–8 Architect в полном объёме: проверить вложенные snapshots, прочитать все источники, перенести уникальные нормы, завершить матрицу решений и устранить редакционные/доменные дубли. Затем закончить дедупликацию prompts и все требуемые негативные/поведенческие fixtures, устранить backend-блокер отдельной задачей, повторить затронутые проверки и получить независимое смысловое ревью. Checker проверяет форму доказательств, а не доказывает полноту семантической миграции.

## Executor Repair pass 1: уточнение после проверенного ревью (wfr_ac07)

Статус: **needs_work**, не approved. Полная миграция не завершена: **423 pending-line-review источника, 2956 pending-semantic-review кандидатов**. Checker возвращает exit 1 только по этим двум причинам; прежние 16 ошибок целей и 16 отсутствующих review evidence устранены без обнуления исходных кандидатов.

### Содержательные решения этого ремонта

- creative docs/visual-style.md: прочитаны все 48 строк; существующие VIS-02 и новые уточнения VIS-05, PACK-01/02 охватывают полный текст, включая не найденные regex нормы. Старый файл сохраняет все пять якорей как ссылки. Оба runtime-потребителя diagnostics уже загружают четыре канона.
- shorts docs/agents/promo-editorial-rules.md: действующий reference, а не архив. Фото/звук/публикация уже покрыты VIS/AUDIO/PUB; уникальные требования Telegram/анонса перенесены в PACK-03. Полные имена применяются с исключением EDIT-01 после поиска, субтитры — по раздельным профилям PACK-01. Исторический таймкод Высоцкого и описание реализации оставлены как контекст.
- shorts assets/promo-review/creative-readme.md: ссылки на VIS/PACK/EDIT вместо старого требования первого кадра как доказательства события. Схема shots[0].evidence теперь в VIS-05; question/description/release.json — в PACK-03.
- Устранён повтор раздельной оценки факта/хука/обещания в EDIT-02: владелец EDIT-04. PACK-01 явно сохраняет обязательную по лицензии экранную атрибуцию. Это не заявление о полном закрытии всех редакционных дублей.
- 16 входов/адаптеров ошибочно назывались migrated с индексом вместо Rule ID или процедурой вместо домена. Полностью прочитанные текущие навигационные редакции теперь retained-procedure с SHA и точной оговоркой: исходные кандидаты НЕ просмотрены и остаются pending. Исходные sha256/line сохранены. Это исправление ложного статуса, а не доказательство переноса старых норм.
- Проверка migrationTarget теперь отвергает несовпадение явного ruleId и якоря. Негативный fixture воспроизводит дефект.
- Бюджет внутренних preproduction-прогонов перенесён из prompt в ORCH-02; штатный дополнительный инфраструктурный повтор сохранён. Матрица разрешения доменов и реальных якорей выполняется для normal, creative, alreadyBuilt, preflight retry, visual retry, исчерпания попыток и locked-render repair. Моки не исполняют вложенные shell-команды агента: подлинность ownerWaiver receipts и внутренний PREPRODUCTION retry этим тестом не доказаны.

### Фактические проверки

Все тесты — через /Users/user/.agents/bin/agent-pool test --. Журналы: /tmp/instruction-repair-pass1/. Baseline: /var/folders/f_/1832vw8137g9f7qcnzhxfx840000gn/T/instruction-repair-baseline-7dsn8iiy/.

- Checker: exit 1, две ошибки незавершённого покрытия (423/2956), 34 Rule ID.
- Checker/workflow/repo-skills: 30/30, exit 0; целевой ESLint exit 0. bb workflows validate --name daily-episode: valid:true.
- Shorts pnpm check: 1538/1538, включая изолированный packaging smoke. Creative npm test: 900/900. Финальные повторные журналы: shorts-final.log и creative-final.log.
- otgolosok lint, typecheck, frontend 2360/2360, Python 49 + 128 subtests и build: exit 0.
- Backend без toolchain воспроизвёл прежний отказ (1292 pass, 1 fail, 1 skip). Диагностическая копия теста вне checkout установила причину: spawn ffmpeg ENOENT, а не продуктовый баг. Исходный e2e с локальными бинарниками прошёл. Вся backend suite с PATH=/Users/user/projects/ai/otgolosok-creative/data/tools/bin:$PATH: **1294/1294, exit 0, без пропусков**. Продуктовый код, assertion и тайм-аут не менялись. Временный ffprobe распакован вне checkout; глобальное окружение не менялось.

### Собственные новые правки этого ремонта

- otgolosok: .bb/workflows/daily-episode.js; docs/instructions/{inventory.json,orchestration.md}; scripts/{verify-instructions.mjs,verify-instructions.test.mjs,daily-episode-instructions.test.mjs}; docs/agents/{instruction-architecture-2026-11-26.md,daily-episode-blockers-2026-11-27.md}.
- creative: docs/visual-style.md.
- shorts: assets/promo-review/{editorial.md,visual.md,packaging.md,creative-readme.md}; docs/agents/promo-editorial-rules.md.

Унаследованные foundation-изменения не присваиваются этому ремонту. HEAD всех трёх checkout, точные байты nextjs-блока и 18 protected-read-only сохранены; остальные tracked/non-ignored файлы совпадают с baseline. Коммит, push, deploy и публикация не выполнялись.

Открыты основное замечание о полной смысловой миграции, остальные legacy/procedure дубли и незакрытые противоречия таблицы. Нужны доказательства ownerWaiver и внутреннего PREPRODUCTION retry на реальных verifier/agent execution boundaries, а также независимое смысловое ревью. Зелёные проектные тесты этих пробелов не закрывают.

## Executor Repair pass 2 (wfr_ac07)

Статус: **needs_work**, не approved. Checker после содержательного переноса шести дополнительных legacy assets: **417 pending-line-review источников / 2916 pending-semantic-review кандидатов**, 36 канонических Rule ID. Exit 1 вызван только двумя ошибками покрытия. Остальные источники не закрывались массовой классификацией; исторические файлы и tool-procedure ещё требуют полного чтения.

### Решения по проверенным замечаниям

Полностью прочитаны promo-hype-review.md, video-hook-review.md, hook-criteria.md, hook-sources.md, creative-rank.txt и creative-rules.txt. В inventory сохранены исходные SHA/строки, добавлены SHA просмотренной итоговой редакции и индивидуальные цели всех 40 кандидатов. Уникальные шаги поиска входов, измерения финала, извлечения кадров (-nostdin), форматы вердиктов и отчётов остались в процедурах. Карта происхождения в hook-sources сохранена как историческое свидетельство, нормативный список разрешения противоречий заменён канонами. Снимки rank/rules больше не являются второй нормативной копией; исполняемые scripts/rank.mjs и scripts/rules.mjs не менялись.

Добавлены EDIT-05 (разные аудитории, калибровка и честная зрительская/аналитическая проверка) и VERIFY-03 (границы редакционного аудита и непроверенные части). EDIT-03 дополнен устной ясностью, VIS-05 — границами выводов по кадрам/ASR, PACK-02 — согласованностью обложки и уточнением целевого диапазона финала: >15 с требует правки, короткий законченный финал не растягивается. Это снимает локальное расхождение строгого диапазона канона с исходной нормой, а не разрешает обход Final Gate. Runtime продолжает получать четыре локальных канона через instructionBundle; diagnostics уже включает их полные тексты. Проверки Shorts включают изолированный packaging smoke.

В workflow ещё шесть повторов заменены ссылками ORCH/STATE/VERIFY/EDIT/VIS/PUB: авторство кода, сохранение валидного кэша, синхронизация данных, бюджет preproduction, pre-gate и scheduled режим. Устранено абсолютное «отсутствие инициалов», расходившееся с исключением EDIT-01. Команды, модельный dispatch, fallback classifier и переходы не менялись. Полная дедупликация остальных prompts ещё не доказана.

Новый offline тест вызывает настоящие createOwnerPreproductionApproval/ownerPreproductionWaiver/recordOwnerWaiver в изолированном temp fixture: без согласования waiver отсутствует, с привязкой создаётся receipt, raw-photo не снимается, изменение script.json инвалидирует waiver. Затем mock orchestration подтверждает блокировку на раннем этапе при устаревшем согласовании и на Final Gate при действительном. Это покрывает реальные функции привязки/квитанции, но не заменяет интеграцию с полным штатным verifier и не доказывает исполнение внутреннего PREPRODUCTION retry агентом. Добавлен сценарий creative с maxEarlyAttempts=3 и конечным architect repair.

После повторения основного блокера в трёх проходах вызван Antigravity agentapi (консультация без правок, секретов и дочерних воркеров). Создана conversation cb52b4b5-fe48-4814-803a-4b5000debdfb; get-conversation-metadata подтвердил создание. CLI вернул метаданные, содержательный ответ не получен и не используется как доказательство. Ruflo отсутствует в доступном каталоге инструментов.

### Проверки ремонта 2

Все тесты через /Users/user/.agents/bin/agent-pool test --. Логи и baseline: /tmp/instruction-repair-pass2/.

| Проверка | Результат |
| --- | --- |
| verify-instructions.mjs | exit 1, только 417 pending источников / 2916 pending кандидатов |
| checker/workflow/repo-skills после финальных правок | exit 0, 32/32 |
| целевой ESLint после финальных правок | exit 0 |
| bb workflows validate --name daily-episode после финальных правок | valid:true |
| Shorts полный pnpm check | exit 0, 1538/1538, packaging smoke включён |
| creative полный npm test | exit 0, 900/900 |
| otgolosok lint / typecheck | exit 0 каждый |
| frontend vitest | exit 0, 2360/2360 |
| backend полная suite, включая elevenlabs-published-audio-e2e | exit 0, 1294/1294, без пропусков |
| Python | exit 0, Ruff/Pyright, 49 tests + 128 subtests |
| build | exit 0 |

**Явное требование окружения backend:** перед запуском добавлен `/Users/user/projects/ai/otgolosok-creative/data/tools/bin` в начало PATH (и для остальных команд runner). Это локальные ffmpeg/ffprobe; в исходном системном PATH ffmpeg отсутствовал. Проход suite с этим PATH не означает, что исходная среда исправлена. Продуктовый код, assertion и timeout аудиотеста не менялись.

### Собственные файлы именно Repair pass 2

- otgolosok: .bb/workflows/daily-episode.js; docs/agents/daily-episode-blockers-2026-11-27.md; docs/agents/instruction-architecture-2026-11-26.md; docs/instructions/inventory.json; docs/instructions/verification.md; scripts/daily-episode-instructions.test.mjs.
- otgolosok-creative: новых правок нет.
- otgolosok-shorts: assets/promo-review/creative-rank.txt; assets/promo-review/creative-rules.txt; assets/promo-review/editorial.md; assets/promo-review/hook-criteria.md; assets/promo-review/hook-sources.md; assets/promo-review/packaging.md; assets/promo-review/promo-hype-review.md; assets/promo-review/video-hook-review.md; assets/promo-review/visual.md.

Состояние девяти противоречий в начальной таблице остаётся частично открытым: канонические решения есть, но все старые нормативные цепочки ещё не проверены. В частности creative README, .agents procedures/references и исторические snapshots остаются pending. По шести assets закрыты местные повторы норм, глобальная уникальность владельца не объявляется доказанной. Для approved нужны полная матрица решений, checker ok:true, полная поведенческая проверка и независимый Reviewer.

Финальная сверка Repair pass 2: git diff --check = 0 во всех checkout; HEAD совпадают с baseline; nextjs-блок совпадает побайтно; все 18 protected-read-only неизменны. Полное сравнение SHA tracked/non-ignored файлов показало только перечисленные собственные изменения (6 otgolosok + 9 Shorts); creative, включая чужие dirty/untracked, не менялся. Матрица: /tmp/instruction-repair-pass2/hygiene.json. Commit/push/deploy/публикация не выполнялись.

## Финальный проход: параллельный семантический аудит и полная дедупликация (`wfr_de512766` + `wfr_d16a05c9`, 2026-11-26)

Статус: **готово к финальному кросс-семейному ревью**. Все 473 источника и все 2916 ранее незакрытых кандидатов норм пройдены, провалидированы и сведены в [inventory.json](../instructions/inventory.json).

### Что выполнено

1. **Параллельный семантический аудит всех 449 оставшихся/частично закрытых файлов (`wfr_de512766-c754-425f-a507-95bc288c1c77`, 19/19 батчей прошли детерминированную валидацию):**
   - 49 активных файлов (три `README.md`, `.agents/skills/*`, `.claude/skills/*`, `.bb/workflows/daily-episode.js`, исходные кандидаты `AGENTS.md` и адаптеров), 68 файлов кода/метаданных/лицензий скилов, 35 снапшотов (`.claude/worktrees`, `data/manual`, 18 `protected-read-only`) и 297 исторических отчётов `docs/agents/`.
   - Выявлено и перенесено в канонические домены **16 ранее неучтённых живых норм** без доменных пересечений: `ENG-04` (`src/styles/tokens.css`), `PROV-01` (согласие на Airouter в ручном `walk-promo`), `PUB-01` (стоп при неизвестном состоянии очереди), `PUB-02` (плейлист «Москва», ИИ=нет, прямая реклама=нет), `WALK-01` (физическая доступность остановок и запрет удаления `promo-walks`), `OPS-01` (подтверждение изменений production, требование `ffmpeg`/`ffprobe` в PATH для локального backend e2e, пилот OSM), `OPS-02` (согласованный backup тома/`VACUUM INTO`, запрет `docker compose down -v`, повторное удаление аккаунтов после восстановления), `EDIT-01` (запрет сокращений в промопакете), `EDIT-02` (минимум 100 слов для рассказов о точках), `AUDIO-01` (`check-stress.mjs`), `PACK-02` (60 с для creative / 58,5 с для `story`), `PACK-03` (художественная иллюстрация для Telegram вместо скриншота).
2. **Параллельная дедупликация всех 32 активных файлов (`wfr_d16a05c9-4e2b-49f1-90b4-bc9965e4740d`, 4 непересекающихся воркера):**
   - Дедуплицированы три `README.md` (`otgolosok`, `otgolosok-creative`, `otgolosok-shorts`), устранены расхождения (`9 MiB` → `9 000 000 байт`, устаревшие `just-tts`/`eleven_v3`/`Alex Bell`/`alex-bell`, `LaunchAgent`, `SSH` по умолчанию, автопубликация).
   - Все `.agents/skills/*` и их `references/*` переведены на ссылки к 36 Rule ID; дубли справочников в `otgolosok/.claude/skills/*/references/*` и 4 скила + 3 справочника в `otgolosok-shorts/.claude/skills/*` заменены тонкими адаптерами/указателями на `.agents/skills/*` (frontmatter синхронизирован).
   - Завершена дедупликация промптов всех этапов `.bb/workflows/daily-episode.js` поверх `bd5f348` с сохранением команд, схем, literal dispatch, классификатора, `hasRealCodeBug`, `ownerWaiver` и `scriptsClean`; расширены офлайн-тесты `scripts/daily-episode-instructions.test.mjs` (17/17 PASS).
3. **Сведение `inventory.json` и исправление парсера кода в `verify-instructions.mjs`:**
   - Итоговое распределение 473 записей: `archived-historical: 272`, `retained-procedure: 87`, `non-normative: 75` (включая 9 активно цитируемых технических справок из `README`/`promo-editorial-rules`), `protected-read-only: 18`, `new-domain: 12`, `deduplicated: 9`; `pending-line-review: 0`, `pending-semantic-review: 0`.
   - `verify-instructions.mjs` пропускает парсинг Markdown-ссылок для не-Markdown файлов кода (например Python-regex в `markers.py`); добавлен юнит-тест в `scripts/verify-instructions.test.mjs`.

### Фактическая верификация финального состояния

| Проверка | Результат |
| --- | --- |
| `node scripts/verify-instructions.mjs` | **exit 0, `ok: true`, 36 Rule ID, 0 ошибок** |
| `node --test scripts/verify-instructions.test.mjs scripts/daily-episode-instructions.test.mjs backend/repo-skills.test.mjs` | **exit 0, 35/35 PASS** |
| ESLint (`verify-instructions*`, `daily-episode-instructions.test.mjs`, `repo-skills.test.mjs`) | **exit 0** |
| `bb workflows validate --name daily-episode` | **exit 0, `valid: true`** |
| `otgolosok-shorts`: `pnpm check` (format, lint, typecheck, unit + isolated packaging smoke) | **exit 0, 74/74 files, 1543/1543 PASS** |
| `otgolosok-creative`: `npm test` (поверх `8c50752`) | **exit 0, 900/900 PASS** |
| `otgolosok`: `pnpm lint` / `pnpm typecheck` | **exit 0 каждый** |
| `otgolosok`: `pnpm exec vitest run` | **exit 0, 149/149 files, 2360/2360 PASS** |
| `otgolosok`: `PATH=../otgolosok-creative/data/tools/bin:$PATH node --test backend/*.test.mjs` | **exit 0, 1294/1294 PASS (0 fail, 0 skip)** |
| `otgolosok`: `pnpm test:py` / `pnpm build` | **exit 0 каждый** |
| `git diff --check` во всех трёх checkout | **exit 0 каждый** |
| Целостность `HEAD`, блока `nextjs-agent-rules` и 18 `protected-read-only` | **HEAD не менялись (`bd5f348` / `8c50752` / `136ae93`), `nextjs-agent-rules` побайтно совпадает, 18/18 `protected-read-only` не изменены** |

### Полный собственный набор файлов по репозиториям (для последующей атомарной фиксации)

- **`otgolosok`**: `AGENTS.md`, `README.md`, `.bb/workflows/daily-episode.js`, `backend/repo-skills.test.mjs`, `docs/agents/{README.md,daily-episode-blockers-2026-11-27.md,instruction-architecture-2026-11-26.md}`, `docs/instructions/` (`README.md`, `inventory.json`, 8 канонов), `scripts/{verify-instructions.mjs,verify-instructions.test.mjs,daily-episode-instructions.test.mjs}`, `.agents/skills/*` (отредактированные `SKILL.md` и `references/*`), `.claude/skills/*` (12 тонких адаптеров `SKILL.md` и 5 тонких указателей `references/*`).
- **`otgolosok-creative`**: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/visual-style.md`, `scripts/{durable-diagnostics.mjs,local-scene-bundle.mjs,preproduction-review.mjs,review-policy.mjs,select-walk.mjs}`, `tests/{caption-review-evidence.test.mjs,local-scene-bundle.test.mjs,review-policy.test.mjs}`. *(Чужие dirty/untracked файлы `data/work/auto-2026-11-23/*`, `docs/reviews/*`, `scripts/{release-snapshot.py,commons-request-budget.mjs}`, `tests/{release-snapshot,commons-request-budget}.test.mjs`, `videos/*` не включать.)*
- **`otgolosok-shorts`**: `AGENTS.md`, `CLAUDE.md`, `README.md`, `docs/agents/promo-editorial-rules.md`, `assets/promo-review/{audio.md,editorial.md,packaging.md,visual.md,creative-rank.txt,creative-readme.md,creative-rules.txt,hook-criteria.md,hook-sources.md,promo-hype-review.md,video-hook-review.md}`, `src/promo/review.ts`, `src/text/{instruction-policy.ts,instruction-policy.test.ts,visual-policy.ts}`, `.claude/skills/{humanizer-ru,implement-plan,make-plan,production-readiness}/*` (тонкие адаптеры и указатели). *(Проверять перед коммитом сторонние правки `src/promo/review.test.ts`, `src/text/airouter.ts`, `src/text/vision.test.ts`, если они не относятся к этой задаче.)*


## Финальная доводка Executor (`wfr_fe4f5291`, 2026-11-26)

Статус: **исправления Architect выполнены, ожидается независимый кросс-семейный Reviewer**. Executor не присваивает `approved` и не подтверждает семью будущего Reviewer.

В VIS-02 восстановлена специализация отбора daily-episode: минимум три самостоятельные фотографии именно места; портреты и иллюстрации дополнительные, один фасад с двумя портретами не подходит. При невозможности собрать пакет кандидат непригоден. Промпты Episode Architect и Media Hunter уже ссылаются на VIS-02 и не изменялись. Добавлены два сценария candidateUnfit, подтверждающие блокировку последующих производственных стадий и публикации. Mock проверяет переходы, но не понимание моделью текста; смысл нормы Reviewer проверяет сравнением HEAD, канона и промптов.

Исправлен устаревший вводный статус отчёта; исторические отказы сохранены в хронологии. В inventory уточнены reason README и workflow после дедупликации, исходные provenance (sha256/bytes/line и хеши кандидатов) не переписывались. Визуальный канон имеет новый отпечаток просмотренной редакции. Изменение VIS-02 инвалидирует прежние аудиты по policy hash; квитанции выпусков не обновлялись.

### Новые проверки Executor

Все тесты запускались через agent-pool. Для каждой команды сохранены отдельный лог, exit code и длительность вне checkout.

| Проверка | Фактический результат |
| --- | --- |
| verify-instructions | exit 0, ok:true, canonicalRules:36, errors:[]; 473 источника, 12 канонов, pending:0 |
| instruction/workflow/repo-skills | exit 0, 37/37 (прежние 35 + 2 candidateUnfit) |
| ESLint instruction-файлов | exit 0 |
| bb workflows validate daily-episode | exit 0, valid:true; workflow не запускался |
| Shorts pnpm check | exit 0; 74 файла, 1543/1543; включая изолированный packaging smoke без sibling checkout, изменение policySha256 и отказ при отсутствии канона |
| creative npm test | exit 0; 900/900 |
| otgolosok lint / typecheck | exit 0 каждый |
| otgolosok vitest | exit 0; 149 файлов, 2360/2360 |
| otgolosok backend с creative/data/tools/bin в PATH | exit 0; 1294/1294, 0 skipped |
| otgolosok test:py | exit 0; ruff/pyright, 49 тестов и 128 subtests |
| otgolosok build | exit 0 |

Прочитаны 12 канонов, действующие входы и ссылки процедур/адаптеров, legacy assets и маршруты промптов. Структурный checker проверяет свой sourceScopes, ссылки и отпечатки; это не автоматическое доказательство смысловой эквивалентности всех 473 источников. Независимая проверка полного diff и спорных переносов остаётся обязанностью Reviewer.

Baseline снят непосредственно перед правками Executor: HEAD, porcelain status, binary diff HEAD, SHA-256 всех tracked/non-ignored untracked файлов. Это не замена исходного снимка прежних проходов. Артефакты этого прохода: `/var/folders/f_/1832vw8137g9f7qcnzhxfx840000gn/T/instruction-final-executor-ri645o65/`; журнал команд: `results.json`, снимок: `baseline.json`.

Итоговая SHA-матрица относительно baseline: только четыре разрешённых файла (этот отчёт, inventory.json, daily-episode-instructions.test.mjs и Shorts visual.md). Creative и остальные tracked/non-ignored untracked, включая сторонние правки Shorts, побайтно сохранены. HEAD всех трёх checkout неизменны, nextjs-блок совпадает побайтно, 18/18 protected-read-only совпадают с исходными SHA. git diff --check: exit 0 в каждом checkout. Подтверждение: hygiene.json рядом с baseline. Commit/push/deploy/публикация и production-команды не выполнялись.
