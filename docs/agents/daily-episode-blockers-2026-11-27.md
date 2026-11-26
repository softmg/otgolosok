# Блокеры выпуска 2026-11-27

Источник: полный сохранённый лог треда @thread:thr_y5vpv4p6iw, 346 строк. Анализ выполнен без запуска выпуска, изменения его данных, аутентификации, аудитов или публикации. Commit stats и timestamps проверены локально; сообщения об успешных тестах и качестве кадров в логе не являются результатом новых проверок. Лог заканчивается повторным запуском: завершение выпуска и публикация не подтверждены.

| Блокер / строки лога | Класс и первопричина | Подтверждённая история | Пробел и защитная норма | Владелец |
| --- | --- | --- | --- | --- |
| preflight:verify-disk: 18, 22, 32 | Ложный отказ: только системный PATH и запись в чужую квитанцию | otgolosok 8859f755f8d9a90d36bb8c69132f1d29e9b6101f | scripts/toolchain.mjs должен учитываться; верификация read-only | [OPS-01](../instructions/operations.md#ops-01); [VERIFY-01](../instructions/verification.md#verify-01) |
| --plan-only: 34 | Отсутствовал контракт планирования без сборки | creative b0ac7d00d3b6c319ccc02f3200fd985f8d615268 | Планирование отделено от build | [STATE-01](../instructions/episode-state.md#state-01) |
| --local / SSH: 60 | Неявный удалённый режим после успешного локального OAuth | otgolosok 4dcb86f334945c121ca2681bb37215ce438fcb66 | Штатный локальный режим задаётся явно | [OPS-01](../instructions/operations.md#ops-01) |
| Арбатская candidate_unfit: 90 | Неверное отождествление архивного доказательства события с допустимым визуальным сопровождением; covered=0/4 | Отдельного коммита нет | Документированный поиск и честно маркированная иллюстрация; порог не снижается | [VIS-01](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-01) |
| Хитровка candidate_unfit: 106 | 11 фото и score=7, но covered=0/4; после проверки score=8, covered=3/4 | Отдельного коммита нет | Не отклонять только за отсутствие фото события при выполнении контракта | [VIS-01](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-01) |
| Переключение и SQLite: 140 | Кандидат возвращён, checkpoint остался от другого состояния | Коммита восстановления SQLite не найдено | Нужна согласованная смена plan/candidate/SQLite с инвалидацией зависимостей; машинная транзакция не реализована | [STATE-01](../instructions/episode-state.md#state-01) |
| assets:verify-disk: 136 | Verifier требовал creative-пакет для normal | otgolosok 72f0815a9cac332f4ee96d5c6004fa129b38f9ef | Таблица контрактов по типу и стадии | [STATE-02](../instructions/episode-state.md#state-02) |
| checkNormalDir: 150, 165 | Пропуск native speech, attribution, SHA-1, типа фото и двух манифестов | creative c3d29f9f9e55fb6d464fc3b068c47f8a47650f0f | Схема normal и портрет/место различаются | [STATE-02](../instructions/episode-state.md#state-02) |
| Текст и пакет corrections: 179 | Неполное закрытие четырёх замечаний за early-проход | otgolosok a7198a75c76cd0f816ceeac417562458170600fc | Все corrections за проход, факты имени/авторства проверяются редактором | [ORCH-02](../instructions/orchestration.md#orch-02); [EDIT-01](../../../otgolosok-shorts/assets/promo-review/editorial.md#edit-01) |
| Полная книга Викитеки: 190 | PREPRODUCTION_LOCAL_PROMPT: >512000 символов; не было fallback source pages | creative 84f5a0c4fd1f2fb938272c16f35abfdef2ed8d7c | Дословные релевантные окна, SHA полного источника, полный файл на диске | [PROV-02](../instructions/providers-and-payloads.md#prov-02) |
| Приоритет visual: 224 | Визуальные corrections направлялись не профильной роли | otgolosok b413e0ec95dd8be975682f57ac1324b44db38137 | Триаж по домену отказа | [ORCH-02](../instructions/orchestration.md#orch-02) |
| Кэш пройденных стадий: 224 | Повторение уже пройденного, но безусловное сохранение тоже опасно | otgolosok b413e0ec95dd8be975682f57ac1324b44db38137 | Сохранять только при совпадении зависимостей | [STATE-04](../instructions/episode-state.md#state-04) |
| PREPRODUCTION_CONTRACT: 235 | Инфраструктурный transient с corrections=[] исчерпал ранние попытки | otgolosok 693b782276d7c1ebedca7715d142f4631ade4aee | Один дополнительный повтор при доказанной инфраструктурной причине | [ORCH-02](../instructions/orchestration.md#orch-02) |
| CTA SAFE.right: 248 | Выброс spring выводил плашку до 906 при SAFE.right=880 | shorts 136ae93f6efacb19ee0d5e4ec55157aa42dc281e; creative 01f526706d169faae6d6609673e2be34c529577b | Проверять экстремумы анимации, не только последний кадр | [VIS-03](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-03) |
| Верхняя UI-маска и шапка: 277 | Доказательный overlay не закрывал верх; шапка y=104 выше SAFE.top | creative 8c0b9e353847175029c05dca4da6595af243f040 | Проверять все UI-зоны и безопасную геометрию | [VIS-03](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-03) |
| Дорожная сеть: 278 | Фон конкурировал с золотой трассой | creative 8c0b9e353847175029c05dca4da6595af243f040 | Маршрут визуально доминирует на 270/360 px | [VIS-03](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-03) |
| HTML visualSearch.evidence: 306 | Отдельный overflow 694349>512000: fallback не обрабатывал сырой HTML evidence | creative 9eb866aae42f09e1387ab7d7e5cd84479a95f91a | Отдельная детерминированная очистка evidence без потери SHA | [PROV-02](../instructions/providers-and-payloads.md#prov-02) |
| storyPhotos/framing/shots: 333 | Фрейминг подготовленных фото не совпадал с производной раскадровкой | otgolosok 37b7ecdbde3ed6009a7506673d291c6ea22b17a1 | Согласование полей и пересборка; отдельного машинного контроля синхронности нет | [STATE-03](../instructions/episode-state.md#state-03) |
| Ручная карта v9: 342 | Много итераций читаемости без заранее заданного конечного критерия | Отдельного исправляющего коммита нет | 29 номеров и линии проверены по сообщению участника; ограниченные циклы профильной роли | [VIS-03](../../../otgolosok-shorts/assets/promo-review/visual.md#vis-03); [ORCH-03](../instructions/orchestration.md#orch-03) |
| Git push / keychain: 264 | Git запросил логин; keychain — предположение автора, не доказанная причина | Коммита исправления нет | Сообщить владельцу локальные SHA; не обходить credential store. Здесь push запрещён | [ENG-02](../instructions/engineering.md#eng-02) |

Конкретные текстовые corrections: подтвердить полное имя Виктора Андреевича Симова, уточнить авторство оценки Гиляровского, убрать переход «А это реальная площадь…» и добавить подтверждённую деталь ручного переписывания пьес/ролей требуют сверки первичных источников редактором; это не новый факт-чек выпуска. Изоляция кандидата, кэша и визуальных кадров пока усилена правилами, а не новой реализацией транзакций.

Смежные f76fb9d и bf780d7 относятся к renderer/checks creative и выпуску 26 ноября, не доказывают исправления карты v9 27 ноября. Полные списки ниже фиксируют author и committer timestamps; границы Берлина проверены отдельно от Москвы.

### otgolosok · Europe/Moscow

```text
37b7ecdbde3ed6009a7506673d291c6ea22b17a1 2026-11-26T11:58:36+01:00 2026-11-26T11:58:36+01:00 fix(workflows): требовать синхронность storyPhotos, storyPhotoFraming и shots.json на early
693b782276d7c1ebedca7715d142f4631ade4aee 2026-11-26T09:45:04+01:00 2026-11-26T09:45:04+01:00 fix(workflows): допускать один повтор при транзиентном PREPRODUCTION_CONTRACT и уточнить scriptsClean
b413e0ec95dd8be975682f57ac1324b44db38137 2026-11-26T09:00:46+01:00 2026-11-26T09:00:46+01:00 fix(workflows): приоритизировать роль visual при остаточных ошибках composed-frame/raw-photo
a7198a75c76cd0f816ceeac417562458170600fc 2026-11-26T08:16:20+01:00 2026-11-26T08:16:20+01:00 fix(workflows): явно закрывать error.corrections из preproduction-early.json при resume
72f0815a9cac332f4ee96d5c6004fa129b38f9ef 2026-11-26T07:44:02+01:00 2026-11-26T07:44:02+01:00 fix(workflows): не требовать creative-пакет при проверке ассетов для выпусков normal
4dcb86f334945c121ca2681bb37215ce438fcb66 2026-11-26T05:41:05+01:00 2026-11-26T05:41:05+01:00 fix(workflows): запускать --plan-only в локальном режиме --local после OAuth-проверки слота
8859f755f8d9a90d36bb8c69132f1d29e9b6101f 2026-11-26T05:26:35+01:00 2026-11-26T05:26:35+01:00 fix(workflows): учесть локальный toolchain ffmpeg/ffprobe при верификации Preflight
```

### otgolosok · Europe/Berlin

```text
37b7ecdbde3ed6009a7506673d291c6ea22b17a1 2026-11-26T11:58:36+01:00 2026-11-26T11:58:36+01:00 fix(workflows): требовать синхронность storyPhotos, storyPhotoFraming и shots.json на early
693b782276d7c1ebedca7715d142f4631ade4aee 2026-11-26T09:45:04+01:00 2026-11-26T09:45:04+01:00 fix(workflows): допускать один повтор при транзиентном PREPRODUCTION_CONTRACT и уточнить scriptsClean
b413e0ec95dd8be975682f57ac1324b44db38137 2026-11-26T09:00:46+01:00 2026-11-26T09:00:46+01:00 fix(workflows): приоритизировать роль visual при остаточных ошибках composed-frame/raw-photo
a7198a75c76cd0f816ceeac417562458170600fc 2026-11-26T08:16:20+01:00 2026-11-26T08:16:20+01:00 fix(workflows): явно закрывать error.corrections из preproduction-early.json при resume
72f0815a9cac332f4ee96d5c6004fa129b38f9ef 2026-11-26T07:44:02+01:00 2026-11-26T07:44:02+01:00 fix(workflows): не требовать creative-пакет при проверке ассетов для выпусков normal
4dcb86f334945c121ca2681bb37215ce438fcb66 2026-11-26T05:41:05+01:00 2026-11-26T05:41:05+01:00 fix(workflows): запускать --plan-only в локальном режиме --local после OAuth-проверки слота
8859f755f8d9a90d36bb8c69132f1d29e9b6101f 2026-11-26T05:26:35+01:00 2026-11-26T05:26:35+01:00 fix(workflows): учесть локальный toolchain ffmpeg/ffprobe при верификации Preflight
```

### otgolosok-creative · Europe/Moscow

```text
9eb866aae42f09e1387ab7d7e5cd84479a95f91a 2026-11-26T11:13:33+01:00 2026-11-26T11:13:33+01:00 fix(preproduction): очищать HTML и ограничивать visualSearch.evidence при PREPRODUCTION_LOCAL_PROMPT
8c0b9e353847175029c05dca4da6595af243f040 2026-11-26T10:54:30+01:00 2026-11-26T10:54:30+01:00 fix(visual): добавить верхнюю маску Shorts UI, опустить шапку маршрута ниже SAFE.top и усилить контраст трассы
01f526706d169faae6d6609673e2be34c529577b 2026-11-26T10:07:21+01:00 2026-11-26T10:07:21+01:00 fix(visual): обновить localCtaSource под безопасную геометрию и масштаб доменной плашки
84f5a0c4fd1f2fb938272c16f35abfdef2ed8d7c 2026-11-26T08:37:35+01:00 2026-11-26T08:37:35+01:00 fix(preproduction): добавить детерминированный fallback выдержек источников при PREPRODUCTION_LOCAL_PROMPT
c3d29f9f9e55fb6d464fc3b068c47f8a47650f0f 2026-11-26T08:00:35+01:00 2026-11-26T08:00:35+01:00 fix(pregate): проверять поля native normal, вложенную attribution, SHA-1 и манифесты в checkNormalDir
bf780d718a562edb723adc3e24043c77da2b7652 2026-11-26T07:13:04+01:00 2026-11-26T07:13:04+01:00 fix(episode): обновить карту маршрута выпуска 2026-11-26 в стиле «Прогулка»
f76fb9d77774fe91695f5af7ab7a2a3ce11795ec 2026-11-26T07:13:04+01:00 2026-11-26T07:13:04+01:00 feat(map): добавить рендерер и проверки тёмной OSM-карты маршрута для creative
b0ac7d00d3b6c319ccc02f3200fd985f8d615268 2026-11-26T05:37:19+01:00 2026-11-26T05:37:19+01:00 feat(tomorrow): добавить режим --plan-only без запуска сборки
```

### otgolosok-creative · Europe/Berlin

```text
9eb866aae42f09e1387ab7d7e5cd84479a95f91a 2026-11-26T11:13:33+01:00 2026-11-26T11:13:33+01:00 fix(preproduction): очищать HTML и ограничивать visualSearch.evidence при PREPRODUCTION_LOCAL_PROMPT
8c0b9e353847175029c05dca4da6595af243f040 2026-11-26T10:54:30+01:00 2026-11-26T10:54:30+01:00 fix(visual): добавить верхнюю маску Shorts UI, опустить шапку маршрута ниже SAFE.top и усилить контраст трассы
01f526706d169faae6d6609673e2be34c529577b 2026-11-26T10:07:21+01:00 2026-11-26T10:07:21+01:00 fix(visual): обновить localCtaSource под безопасную геометрию и масштаб доменной плашки
84f5a0c4fd1f2fb938272c16f35abfdef2ed8d7c 2026-11-26T08:37:35+01:00 2026-11-26T08:37:35+01:00 fix(preproduction): добавить детерминированный fallback выдержек источников при PREPRODUCTION_LOCAL_PROMPT
c3d29f9f9e55fb6d464fc3b068c47f8a47650f0f 2026-11-26T08:00:35+01:00 2026-11-26T08:00:35+01:00 fix(pregate): проверять поля native normal, вложенную attribution, SHA-1 и манифесты в checkNormalDir
bf780d718a562edb723adc3e24043c77da2b7652 2026-11-26T07:13:04+01:00 2026-11-26T07:13:04+01:00 fix(episode): обновить карту маршрута выпуска 2026-11-26 в стиле «Прогулка»
f76fb9d77774fe91695f5af7ab7a2a3ce11795ec 2026-11-26T07:13:04+01:00 2026-11-26T07:13:04+01:00 feat(map): добавить рендерер и проверки тёмной OSM-карты маршрута для creative
b0ac7d00d3b6c319ccc02f3200fd985f8d615268 2026-11-26T05:37:19+01:00 2026-11-26T05:37:19+01:00 feat(tomorrow): добавить режим --plan-only без запуска сборки
```

### otgolosok-shorts · Europe/Moscow

```text
136ae93f6efacb19ee0d5e4ec55157aa42dc281e 2026-11-26T10:06:41+01:00 2026-11-26T10:06:41+01:00 fix(cta): ограничить масштаб доменной плашки внутри безопасной зоны Shorts
```

### otgolosok-shorts · Europe/Berlin

```text
136ae93f6efacb19ee0d5e4ec55157aa42dc281e 2026-11-26T10:06:41+01:00 2026-11-26T10:06:41+01:00 fix(cta): ограничить масштаб доменной плашки внутри безопасной зоны Shorts
```


## Доводящий проход инструкций wfr_ac07, 2026-11-26

Выпуск и его данные в этом проходе не запускались и не изменялись. VERIFY-01 уточнён для штатного composed-frame ownerWaiver без ослабления text/packaging/raw-photo и Final Gate; ORCH-01 задаёт scriptsClean с учётом авторства и даты выпуска. Workflow использует ссылки на эти нормы поверх bd5f348. Подробные результаты и собственный набор файлов — в [архитектурном отчёте](instruction-architecture-2026-11-26.md#доводящий-executor-проход-wfr_ac07-2026-11-26).

Миграция остаётся needs_work: 426 источников и 2972 кандидата не прошли полный смысловой разбор. Полные проверки creative (900 тестов) и Shorts (1538 тестов) прошли; основной backend снова отказал на первом ожидании локального ElevenLabs mock-воркера (backend/elevenlabs-published-audio-e2e.test.mjs:114, 10 секунд), в том числе в отдельном запуске. Python и build теперь достигнуты и прошли. Это блокер качества проекта, не повод менять данные выпуска или допускать публикацию.

## Текущий результат Executor Repair pass 1 после ревью

Миграция остаётся needs_work: 423 источника и 2956 кандидатов ещё pending. Три живых источника перенесены в каноны со ссылками вместо копий; исходные непроверенные кандидаты входов/адаптеров сохранены. Подробности и собственные списки файлов — в последнем разделе [архитектурного отчёта](instruction-architecture-2026-11-26.md).

Backend-блокер диагностирован как отсутствие ffmpeg в PATH тестового процесса: диагностическая копия вне checkout показала spawn ffmpeg ENOENT. Продуктовые файлы и тайм-аут не менялись. Исходный ElevenLabs e2e прошёл с локальным toolchain; полная suite с creative/data/tools/bin в PATH прошла 1294/1294, без пропусков. Отдельная продуктовая задача по этому отказу больше не требуется.

Остальные полные проектные проверки прошли; checker честно остаётся красным по незавершённому смысловому покрытию. Данные реального выпуска, очередь и receipts этим ремонтом не проверялись и не менялись; готовность выпуска не заявляется.

## Уточнение Repair pass 2

Состояние выпуска не менялось. Для миграции инструкций остаётся 417 источников / 2916 кандидатов pending; approved недостижим до полной сверки. Перенесены ещё шесть legacy assets, подробности и собственный список файлов — в [архитектурном отчёте](instruction-architecture-2026-11-26.md#executor-repair-pass-2-wfr_ac07).

Полная backend suite 1294/1294 проходит с `/Users/user/projects/ai/otgolosok-creative/data/tools/bin` в начале PATH; это обязательная настройка данного запуска для ffmpeg/ffprobe. Исходная системная среда без этого PATH не исправлялась. Все остальные полные проектные проверки прошли; checker остаётся красным по незавершённой смысловой миграции.
