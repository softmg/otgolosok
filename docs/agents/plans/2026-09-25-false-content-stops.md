# План: ложные остановки генерации текстов OSM-мест

Status: draft 2026-09-25. Реализация не начата.

> Заметка для агентов: план — снимок на дату выше. Факты о коде ниже проверены 25.09.2026,
> но перед правкой перепроверьте их по актуальному коду.

## Контекст

Production на 25.09.2026: 6 107 мест, 1 110 текстов. Все 1 743 места, проходящие
`assessPlaceEligibility`, уже обработаны; 641 из них остановлены. Пилот `weak_identity`
(20 мест уровня `auto`) дал 8 `ready`. Разбор — `docs/agents/weak-identity-triage.md`,
раздел «Итог первого пилота».

| Состояние | Код | Всего | из них пилот |
|---|---|---|---|
| review_required | `ADDRESS_UNCLEAR` | 360 | 6 |
| review_required | `REVIEW_REQUIRED` | 264 | 1 |
| review_required | `IDENTITY_UNCONFIRMED` | 3 | 3 |
| insufficient_evidence | `INSUFFICIENT_EVIDENCE` | 16 | 2 |
| failed | `SOURCE_ACCESS_FAILED`, `TIMEOUT`, `INVALID_*` | 10 | 0 |

Цель — убрать системные причины ложных остановок, не ослабляя защиту от текста о чужом
объекте, и измерить эффект повторным прогоном по уже сохранённым источникам.

## Фаза 0. Установленные факты о коде (25.09.2026)

Пайплайн OSM-текстов — `runContentJob` в `backend/content-pipeline.mjs`:

1. Поиск источников → `checkpoint.research`, загрузка страниц → `checkpoint.sources`.
2. Извлечение фактов: `requestStructured(provider, factsPrompt(anchor, sources, context))`,
   затем `validateFacts(raw, sources, {requireEditorialScope:true})`, для `weak_identity` —
   `restrictWeakIdentityEvidence` (`backend/identity-triage.mjs:119`). Результат →
   `checkpoint.evidence`. **При исключении ответ модели нигде не сохраняется.**
3. `writeStory` (`backend/story-writing.mjs`): черновик → проверка `reviewPrompt` →
   **при `REVIEW_REQUIRED` уже есть одно переписывание с замечаниями** и повторная проверка.
   `onCandidate`/`onReview` перезаписывают `draftCandidateRaw`/`review`, история раундов
   теряется.
4. Ошибки `REVIEW_REQUIRED`, `ADDRESS_UNCLEAR`, `IDENTITY_UNCONFIRMED` → `review_required`
   (`content-pipeline.mjs:68`), тексты сообщений — `contentFailureMessage` там же.

`validateFacts` (`backend/domain.mjs:56`) первой строкой требует
`result.addressConfirmed === true`, иначе `ADDRESS_UNCLEAR`. Функция общая:

- `backend/pipeline.mjs:117` — адресный пайплайн (пользователь ввёл адрес; адрес и есть
  идентичность). **Здесь строгая проверка адреса должна остаться.**
- `backend/admin.mjs:28` — ручное редактирование, передаёт `addressConfirmed:true`.
- `backend/content-pipeline.mjs:59` — OSM-пайплайн, меняем только его.

`factsPrompt` (`backend/prompts.mjs:12`) возвращает `addressConfirmed`, `identityNote`,
`placeName`, `resolvedAddress`, `facts[]`. Для OSM передаётся `placeContext`; адрес
(`anchor = job.place.address`) у слабых мест `null`. `reviewPrompt(address, …)` получает
`job.place.address ?? job.place.name` и требует сверить «requested place».

Повтор: `store.retryBatchItem(batchId, placeId, {restartFrom})`
(`backend/content-store.mjs:314`), `restartFrom` = `auto` (checkpoint сохраняется) или
`research` (checkpoint сбрасывается). HTTP: `POST /api/story-admin/content/batches/:id/items/:placeId/retry`
(`backend/server.mjs:314`). При `auto`: у `ADDRESS_UNCLEAR`/`IDENTITY_UNCONFIRMED` нет
`evidence` → повторяется только извлечение фактов и письмо; у `REVIEW_REQUIRED` есть
`evidence` → повторяется только `writeStory`. Поиск не повторяется.
`EDITORIAL_EVIDENCE_VERSION = 2` (`domain.mjs:4`); его повышение сбрасывает `evidence`
у всех незавершённых заданий при следующем запуске — **не повышать без необходимости**.

Эвристика `quoteNamesPlace` (`identity-triage.mjs:103`): все слова с заглавной после первого
обязательны, плюс ≥60 % значимых слов. Проверено локально: «портрет Василия Ланового»
для «Василий Семёнович Лановой» → `false`; «Дом бабочек, муравьев и рептилий» и
«Собор Чуда Архистратига Михаила в Хонех» → `true`.

Классы замечаний 264 `REVIEW_REQUIRED` (грубая регулярная классификация, после уже
выполненного переписывания): даты/числа 73, слух/термины 61, адрес 46, неподтверждённые
детали 39, прочее 33, смешение объектов 12. Класс «адрес» — проверка требует соответствия
запрошенному адресу при отсутствии факта `kind=address`.

Фильтр ошибок в админке строится по кодам из данных (`contentErrorOptions`,
`src/features/admin/model.ts`), новый код появится в нём без правок UI.

Команды проверки: `npm run lint`, `npm run typecheck`, `npm test`
(`vitest run && node --test backend/*.test.mjs`).

### Запреты для всех фаз

- Не менять `assessPlaceEligibility` и правила уровней триажа.
- Не менять поведение `validateFacts` для `backend/pipeline.mjs` и `backend/admin.mjs`.
- Не добавлять второй цикл переписывания в `writeStory` вслепую: сначала данные фазы 1.
- Не повышать `EDITORIAL_EVIDENCE_VERSION`, если форма `evidence` не меняется.
- Не запускать повторы на production без явного подтверждения пользователя.

## Фаза 1. Сохранять причину отказа

**Что сделать.**

1. В `runContentJob` при исключении на шаге фактов (`validateFacts`,
   `restrictWeakIdentityEvidence`) сохранить в checkpoint `factsRejection`:
   `{code, identityNote, placeName, resolvedAddress, addressConfirmed, facts}` из ответа модели,
   с обрезкой (`identityNote` ≤ 1000 символов, не больше 8 фактов, цитаты ≤ 500) — те же пределы,
   что в `validateFacts`. Сохранять через существующий `save`, как `draftCandidateRaw`.
2. При следующем прогоне шага фактов (`!checkpoint.evidence`) `factsRejection` удаляется
   перед вызовом модели, чтобы не путать старый отказ с новым.
3. В `writeStory` накапливать раунды проверки: `onReview` получает номер раунда; в
   `content-pipeline.mjs` сохранять `reviewRounds: [{round, approved, issues, unsupportedClaims}]`
   (не больше 2 элементов), оставив `review` = последний раунд для совместимости с админкой.
4. `invalidateEditorialCheckpoint` удаляет и `factsRejection`, и `reviewRounds`.

**Образцы.** Сохранение промежуточного результата — `onCandidate:candidate=>save({draftCandidateRaw:candidate})`
в `content-pipeline.mjs:61`. Тестовые провайдеры — `backend/content-pipeline.test.mjs`.

**Проверка.**

- Тест: модель вернула `addressConfirmed:false` → задание `review_required`, в checkpoint
  есть `factsRejection.identityNote`.
- Тест: `weak_identity` с цитатой без названия → `IDENTITY_UNCONFIRMED`, в `factsRejection.facts`
  видны цитаты модели.
- Тест: повтор с `restartFrom:"auto"` и успешным ответом → `factsRejection` отсутствует.
- Тест: два раунда проверки, оба отклонены → `reviewRounds.length === 2`, `review` = второй.
- Граница: очень длинный `identityNote` и 20 фактов обрезаются.

## Фаза 2. Идентичность вместо адреса в OSM-пайплайне

**Что сделать.**

1. Добавить в `factsPrompt` при наличии `placeContext` поле ответа
   `"identityConfirmed":true|false` — «страницы устанавливают именно этот объект (по названию,
   типу, местоположению)», и уточнить, что `addressConfirmed` означает только «страницы
   подтверждают собственный почтовый адрес объекта» и может быть `false` у парка, памятника,
   территории. Без `placeContext` (адресный пайплайн) промпт не меняется.
2. В `validateFacts` добавить опцию `identityMode: "address" | "place"` (по умолчанию `"address"`,
   текущее поведение). В режиме `"place"`:
   - `identityConfirmed !== true` → новый код `PLACE_UNCLEAR`;
   - обязателен хотя бы один факт `kind:"identity"` с `subjectRelation:"object"`, иначе
     `PLACE_UNCLEAR`;
   - при `addressConfirmed !== true` факты `kind:"address"` отбрасываются, а в evidence
     пишется `addressConfirmed:false`, чтобы автор и проверка не утверждали адрес.
3. `content-pipeline.mjs:58–59` вызывает `validateFacts(..., {requireEditorialScope:true, identityMode:"place"})`.
   `PLACE_UNCLEAR` → `review_required`; сообщение в `contentFailureMessage`:
   «Источники не позволяют уверенно определить объект. Проверьте, о том ли месте найдены материалы.»
4. `reviewPrompt` для OSM: если в evidence нет факта `kind=address`, передавать как «requested place»
   название и тип объекта из OSM, а не адрес, и добавить правило «не отклонять текст за
   несовпадение с адресом, если текст адрес не называет». Это закрывает класс «адрес» в
   `REVIEW_REQUIRED`. Адресный пайплайн не меняется.

**Образцы.** Опции `validateFacts` — существующий `requireEditorialScope`. Тесты правил
evidence — `backend/editorial-evidence.test.mjs`, тесты пайплайна — `backend/content-pipeline.test.mjs`.

**Проверка (таблично, `editorial-evidence.test.mjs`).**

| identityMode | identityConfirmed | addressConfirmed | identity-факт об объекте | Ожидание |
|---|---|---|---|---|
| address | — | false | есть | `ADDRESS_UNCLEAR` (как сейчас) |
| place | true | false | есть | evidence без address-фактов |
| place | true | true | есть | evidence с address-фактами |
| place | false | true | есть | `PLACE_UNCLEAR` |
| place | true | true | нет | `PLACE_UNCLEAR` |

- Тест адресного пайплайна (`pipeline.test.mjs`) без изменений проходит.
- Тест: парк без адреса, `identityConfirmed:true`, `addressConfirmed:false` → `ready`,
  в тексте нет утверждения адреса (провайдер-заглушка проверяет, что в `reviewPrompt` ушло название).
- `grep -n "addressConfirmed !== true" backend/domain.mjs` — строка осталась только в ветке `"address"`.

## Фаза 3. Имена людей в `quoteNamesPlace`

**Что сделать.** Если вариант названия — ФИО из трёх слов с отчеством (второе слово
оканчивается на `-ович`, `-евич`, `-ич`, `-овна`, `-евна`, `-ична`, `-инична`), отчество
перестаёт быть обязательным: достаточно имени и фамилии (с учётом падежной основы `stem`).
Остальные правила не меняются.

**Проверка (таблица в `backend/identity-triage.test.mjs`).**

| Название | Цитата | Ожидание |
|---|---|---|
| Василий Семёнович Лановой | портрет Василия Ланового в роли генерала | true |
| Василий Семёнович Лановой | граффити с Василием Лановым | true |
| Василий Семёнович Лановой | Андрей Лановой, сын актёра | false |
| Василий Семёнович Лановой | портрет Ланового | false (нет имени) |
| Н. Ф. Григоренко | доска Н. Ф. Григоренко | как сейчас |
| Дом бабочек муравьёв и рептилий | Дом бабочек, муравьев и рептилий | true (не сломано) |

Запрет: не ослаблять порог 60 % и не делать необязательными фамилии.

## Фаза 4. Замечания проверки (решение по данным)

Переписывание по замечаниям уже есть, поэтому новый цикл здесь не проектируется заранее.

1. После фаз 1–3 и выкладки (фаза 5) выгрузить `reviewRounds` повторно прогнанных
   `REVIEW_REQUIRED` и разложить второй раунд по классам.
2. Если доминирует конфликт значений в источниках (пример — усадьба Маркина: 1903 и 1904
   в разных источниках, оба факта в evidence), предложить пользователю правило в `factsPrompt`:
   расходящиеся даты и числа из разных источников — один факт с обоими значениями и
   обеими цитатами либо пропуск факта. Реализовать только после согласия.
3. Остальное остаётся редактору: замечания проверки в выборке в основном обоснованны.

## Фаза 5. Выкладка и повторный прогон на production

Требует явного подтверждения пользователя перед каждым шагом с платными вызовами.

1. Выкладка генератора по `docs/production-deployment.md` (`deploy-otgolosok-generator`).
2. Повтор через `retryBatchItem` с `restartFrom:"auto"` (поиск не повторяется):
   - 12 остановленных мест пилота `weak_identity`;
   - 30 случайных обычных `ADDRESS_UNCLEAR` (половина с адресом в OSM, половина без);
   - 20 случайных `REVIEW_REQUIRED` из класса «адрес».
   Массового инструмента нет: для 62 мест использовать HTTP-эндпоинт повтора из админки
   или разовый скрипт в контейнере, вызывающий `store.retryBatchItem`. Если понадобится
   постоянный массовый повтор — отдельное предложение пользователю.
   Партия должна быть в состоянии `running`, иначе задания не будут взяты.
3. Ожидаемая стоимость: 2–4 вызова модели на место (факты, текст, проверка, возможно
   переписывание), без веб-поиска.
4. Итог записать в `docs/agents/weak-identity-triage.md` (пилот) и в новый раздел
   `docs/agents/text-generation-verification.md` (обычные места): сколько `ready`, какие коды
   остались, примеры `identityNote` для оставшихся отказов.

**Критерий успеха.** Пилот: не меньше 5 из 12 → `ready`. Обычные `ADDRESS_UNCLEAR`: доля
`ready` заметно выше нуля, и ни одного опубликованного текста о чужом объекте при ручной
проверке 10 новых текстов.

## Фаза 6. Итоговая проверка

- `npm run lint && npm run typecheck && npm test` без ошибок.
- `grep -rn "identityMode" backend` — используется только в `content-pipeline.mjs` и тестах.
- Ручная проверка 10 новых текстов из фазы 5: объект тот, адрес не утверждается без
  `kind=address`.
- Обновить `Status:` этого плана и описание в `docs/agents/README.md`.
