# План: перенос прогулки «От Кожевников к Цинделю» на места каталога

Status: plan

> Note for agents: this plan is a point-in-time snapshot — its "codebase facts" describe the code as of the date above and may be outdated. Do NOT treat it as current architecture docs; verify every fact against the actual code before relying on it.

## Контекст

6 октября 2026 года пользователь заметил, что на карте «Рядом» нет остановок 2–4 прогулки `https://otgolosok.online/walk?catalog=msk-kozhevniki-zindel-short`. Причина: это единственная «встроенная» прогулка (`public/data/routes/paveletskaya.json` → генерируется в `backend/builtin-routes.mjs`). Её четыре рассказа (одна POI и три `notes`) хранятся только внутри файла маршрута, а слой «Рядом» строится исключительно из таблицы `places` с утверждённым текстом (`MAP_POINT_SELECT`, `backend/content-store.mjs`). На production в ячейке 55:37 все 1711 точек — OSM-места; рядом с маршрутом есть только `osm:node:2330688388` «Кожевники» (историческая слобода, автоматический текст, есть аудио).

Остальные редакционные прогулки (Ордынка, бульвары) публикуются от служебного аккаунта `promo-walks` со ссылкой `?share=` и ссылаются на места каталога (`storyRef.kind = "osm"`), поэтому их остановки видны на карте.

## Согласованные решения (пользователь, 6 октября 2026)

1. Перенести прогулку на общую схему, как Ордынка: рассказы — места каталога, прогулка — публичная прогулка `promo-walks` со ссылкой `?share=`.
2. Заметки о названиях улиц показывать точками на карте — это нормально.
3. Остановка 1: заменить текст существующего места «Кожевники» (`osm:node:2330688388`) редакторским рассказом прогулки, а не создавать дубль.
4. Озвучить все четыре рассказа ElevenLabs, голос «Отголосок2». Объём платной озвучки согласован: ровно эти 4 текста, ничего больше.
5. Работа делится на два плана. Этот план: точки на карте, новая прогулка, старая ссылка `?catalog=` ведёт на новую, встроенная прогулка исчезает из списка и топа. Второй план (отдельно, позже): удалить старый тур главной страницы (`src/app/page.tsx` → `TourExperience` без `walk`, `ClassicWalkView`, `AroundScreen.route`) и подсистему `builtin-routes` с ветками `kind: "catalog"`. До него текст в `paveletskaya.json` остаётся неиспользуемой копией — это осознанный временный долг.

## Проверенные факты проекта

- `backend/builtin-routes.mjs` генерируется `scripts/build-walk-catalog.mjs` из `public/data/routes/*.json` (запускается в `pnpm build`; есть режим `--check`). Руками не править.
- Тот же JSON импортирует главная: `src/app/page.tsx` → `CatalogTour` → `TourExperience({ route })`. Поэтому файл нельзя удалить в этом плане.
- Потребители `builtinRoutes` на бэкенде: `/api/story-walks` (`backend/server.mjs`, фильтр `route.walk?.steps?.length`), `createTopWalks` (`backend/walk-top.mjs`), `backend/walk-admin.mjs` (три места), `favoriteSummary` (`backend/favorite-summary.mjs`, href `/walk?catalog=`), `walk-feedback.mjs` и `walk-launch-routes.mjs` через `store.getPublishedWalk`.
- Встроенная прогулка: 4 шага, `content_id` → `msk-kozhevniki-names`, `msk-derbenevskaya-name`, `msk-zindel-housing` (notes) и `msk-derbenevskaya-7-bucher-zindel` (POI). У шагов есть `location`, у шага 3 — `trigger_location`, есть `transition`/`next_hint`. Старт `2-й Кожевнический переулок, 12с10` (`way/77618315`), финиш `Дербеневская набережная, 7с22` (`way/48346310`), 634 м. Отзывов 0 (публичный API).
- Образец полного выпуска: `content/ordynka-merchants-2026-10-05/` и операционные скрипты в игнорируемом `artifacts/ordynka-merchants/` и `artifacts/ordynka/`:
  - `build-places.py` — место из свежего OSM (`placeId`, `osmType`, `osmId`, `name`, `address`, `location`, `geometry`, `tags`, `provenance`);
  - `plan.mjs` — `createWalkPlanner` (Valhalla `valhalla1.openstreetmap.de`, curl) + `validateWalkDocument`, `storyRef: {kind: "osm"}`, `triggerLocation`, `destination`;
  - `apply-v2.mjs` — `snapshot | dry-run | apply` в одной транзакции SQLite: проверка ожидаемых версий (`placeHash`, `textId`, `storyHash`, `allTextHash`), отсутствие активных content/audio-заданий, бэкап `0600` до записи, `store.importPlaces(..., {complete: false})` для новых мест, `store.approvePlaceText` для существующих, идемпотентность по `editorialExpansion.bundleId`;
  - `publish.mjs` — `createAccountStore(...).createWalk('promo-walks', {title, snapshot, idempotencyKey})` + `setWalkVisibility(..., 'public', {autoApprove: true})`, бэкап `auth.sqlite` через `VACUUM INTO`;
  - `queue-v2.mjs` — `store.enqueueExternalAudio` с `elevenLabsProfile(ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL)`, проверка голоса `9ivxhQ6xIsHd6R3Xc635`;
  - `remote.py`, `upload-v2.py` — доставка файлов в контейнер генератора через SSH из `.env.ops`.
- Формат записи `stories.json`: `{placeId, story: {title, address, paragraphs[{text, factIds}], sources[{id,url,title,publisher}], facts[{id, claim, sourceIds}], checkedAt, verification: "editorial", effectiveProfile: "story-v1", audioDisposition: "eligible", wordCount}, place?, expected?, reuse?}`.
- `docs/agents/plans/2026-10-05-elevenlabs-published-audio-protection.md`: повторный синтез уже опубликованного ElevenLabs-аудио заблокирован; новая редакция текста получает новый ключ, это допустимо.

## Фаза 0. Проверка недостающих фактов (без записи на production)

1. Прочитать в `node_modules/next/dist/docs/` раздел о `redirects` в `next.config` и условии `has` по query-параметру. Убедиться, что редирект срабатывает и при клиентском переходе (`Link`, `router.push`). Если нет — использовать проверку в `walk-screen.tsx` (см. фазу 3).
2. Прочитать `importPlaces` и валидатор мест в `backend/content-store.mjs`: какие типы геометрии принимаются (нужна линия улицы?) и берётся ли `location` из записи или считается по геометрии. Для улицы точка на карте должна стоять у остановки (`55.724825, 37.649923`), а не в центре всей улицы.
3. Через Overpass или OSM API найти и сохранить в `artifacts/kozhevniki/`:
   - здание фабрики Цинделя, к которому относится рассказ (`way/48346310` — финиш, Дербеневская наб., 7с22; проверить, что это корпус фабрики, а не соседний объект; при сомнении выбрать главный корпус мануфактуры и записать обоснование);
   - здание для «Жизни после смены»: Дербеневская ул., 14 к2 или 10 (рассказ называет оба; точка шага 3 — `55.72387, 37.64955`, у дома 14);
   - участок `Дербеневская улица` у пересечения с 4-м Кожевническим переулком.
4. Снять с production ожидаемые версии четырёх ID (`apply.mjs snapshot`, только чтение) и убедиться, что `osm:node:2330688388` без активных заданий.

## Фаза 1. Пакет контента

Скопировать структуру `content/ordynka-merchants-2026-10-05/`.

1. `content/kozhevniki-zindel-2026-10-06/stories.json`: четыре записи, тексты и источники перенести из `paveletskaya.json` без смыслового переписывания. `fact_ids` → `factIds`, `evidence[].source_id` → `sourceIds`, `title` = `story.opening`, `checkedAt` из `checked_at`. `wordCount` считать так же, как assert в `apply-v2.mjs`.
   - `osm:node:2330688388` (существующее) — с `expected` из фазы 0.4;
   - три новых — с `place` из фазы 0.3.
2. `stops.json` и `README.md` пакета на русском: остановки, адреса, триггеры, решения и ограничения (`editorial_note` из исходных записей).
3. Операционные скрипты — в `artifacts/kozhevniki/` (игнорируется), скопировать с `artifacts/ordynka-merchants/` и поменять только константы (bundle id `kozhevniki-zindel-2026-10-06`, число записей 4, каталог `/data/ops-backups/kozhevniki-zindel-2026-10-06`).

Проверка: изолированная копия SQLite (как в Ордынке) — `dry-run` откатывается, `apply` идемпотентен, отказ при подменённом `expected`; `store.getPublishedPlace` отдаёт ровно тексты пакета; `getMapCell(55, 37)` содержит все четыре ID.

Не делать: не придумывать новые факты, не менять геометрию существующего места «Кожевники».

## Фаза 2. Документ прогулки

1. `artifacts/kozhevniki/plan.mjs` по образцу `artifacts/ordynka-merchants/plan.mjs`: `start` — старт встроенной прогулки, `destination` — финиш, `stops` — четыре места с `triggerLocation` = `trigger_location ?? location` шагов, `transition`/`nextHint` — из шагов (`next_hint`), `minutes: 15`, `fieldChecked: false`, `tunnels`, если вернутся.
2. Записать `content/kozhevniki-zindel-2026-10-06/walk.json`, проверить `validateWalkDocument` и `resolveWalkView` на изолированной базе (все главы `text_ready`).

## Фаза 3. Код: снять встроенную прогулку с витрины и перенаправить ссылку

1. В `public/data/routes/paveletskaya.json` добавить поле, которое помечает прогулку перенесённой и хранит токен новой ссылки (например, `"moved_to_share": "<token>"`). Пересобрать `backend/builtin-routes.mjs` штатным скриптом. Тип `Route` в `src/features/tour/types.ts` дополнить.
2. Бэкенд: `/api/story-walks`, `createTopWalks`, `walk-admin` — не показывать перенесённые прогулки; `favoriteSummary` — href на `/walk?share=<token>`. API `/api/story-walks/<id>/view` оставить рабочим до второго плана (офлайн-копии и старые клиенты).
3. Редирект страницы `/walk?catalog=msk-kozhevniki-zindel-short` → `/walk?share=<token>` способом из фазы 0.1. Токен брать из того же поля, не дублировать строкой.
4. Тесты: таблица для списка, топа, избранного и редиректа (обычная и перенесённая прогулка, отсутствие поля). Существующие тесты, проверяющие наличие `msk-kozhevniki-zindel-short` в списке, обновить осмысленно.

Токен появится только после фазы 4.2, поэтому код коммитится после публикации, а выкладывается в фазе 4.4.

## Фаза 4. Production

Перед каждой записью: проверить нет ли параллельной выкладки (`.deploy.lock`, свежие бэкапы), нет ли активных аудиозаданий; в коммиты и документы не писать IP, SSH-адреса и журналы выкладки (репозиторий публичный).

1. Контент: загрузка файлов → `snapshot` → `dry-run` → `apply` с бэкапом в `/data/ops-backups/kozhevniki-zindel-2026-10-06/` → повторный `apply` (должен всё пропустить).
2. Прогулка: `publish.mjs` с `idempotencyKey: 'kozhevniki-zindel-20261006'`, бэкап `auth.sqlite`; записать `publication.json` (share URL) в пакет.
3. Озвучка: `queue.mjs` ровно для четырёх текущих `textId`; дождаться `done`, скачать MP3, проверить SHA-256, размер и длительность через ffprobe; квитанция `audio-verification.json`.
4. Выкладка кода из фазы 3 штатным скриптом из чистого worktree, в фоне; перед этим `pnpm check`.

## Фаза 5. Проверка и документация

1. Публичный API: `/api/content/map-cells/55/37` содержит четыре ID; у каждого `/api/content/places/<id>` — текст пакета и аудио; share-прогулка отдаёт 4 главы `ready`.
2. Браузер 390 × 844: на «Рядом» в районе Дербеневской видны все четыре точки, карточки открываются; `?catalog=msk-kozhevniki-zindel-short` открывает новую прогулку; прогулка проходится «Начать → Дальше» до конца; список прогулок и топ не показывают старую.
3. `pnpm check` полностью.
4. `docs/agents/kozhevniki-zindel-to-catalog.md` (что сделано, бэкапы без адресов сервера, ограничения) и строка в `docs/agents/README.md`. Создать заготовку второго плана `docs/agents/plans/<дата>-retire-builtin-catalog-tour.md` со статусом `plan` и найденными зависимостями главной страницы.
5. Закрыть этот план (`Status: implemented …`), атомарные коммиты по фазам.

## Риски

- Замена текста «Кожевников» убирает из карточки сюжеты о Бахрушиных и храме Троицы. Это решение пользователя; в README пакета отметить, что прежний автоматический текст сохранён в бэкапе и истории `place_texts`.
- Прежнее аудио «Кожевников» перестанет соответствовать тексту; новая озвучка в фазе 4.3 его заменит.
- Пока второй план не выполнен, тексты прогулки лежат в двух местах (`places` и `paveletskaya.json`). Правки делать только в `places`.
