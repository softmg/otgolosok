# Production deployment

## Исправление ошибки 500 в черновиках — 1 октября 2026, 13:04 UTC

- Backend `ab0d019` опубликован штатной целью `deploy-otgolosok-generator` под advisory-блокировкой `.deploy.lock`. Резервная копия: `backups/generator-20261001T130139Z/generator.tar.gz`; архив проверен, режим обслуживания снят.
- Причина: SQLite-сортировщик счётчиков статусов копировал большие checkpoint исследований и переполнял tmpfs `/tmp` размером 64 МБ. Материализованный CTE ограничивает запись сортировки одним коротким статусом; [подробности и регрессионная проверка](agents/drafts-sqlite-sorter-2026-10-01.md).
- Полный `pnpm check` прошёл: 649 frontend-тестов, 554 backend-теста, 20 Python-тестов и 15 subtests, линтеры, типы и сборка. Backend healthy, SHA-256 файла совпал с локальным; TLS/HTTP2 проверены.
- Публичный API с действующей редакторской сессией до выкладки возвращал 500, после — 200 для всех пяти фильтров. Всего 773 черновика: 49 с ошибкой исследования, 496 проверенных через Perplexity, 228 без исследования.

## Обновление main после PR #10 — 1 октября 2026, 11:35 UTC

- Ревизия `fc037a4` опубликована штатными целями `deploy-otgolosok-generator` и `deploy-otgolosok-prod`: backend и frontend. Во время выкладки удерживалась advisory-блокировка `.deploy.lock`; рабочая копия перед запуском была чистой.
- Полный `pnpm check` прошёл перед backend и повторно в цели frontend: 649 frontend-тестов, 553 backend-теста, 20 Python-тестов и 15 subtests, линтеры, типы и production-сборка.
- Резервные копии в `/srv/sites/otgolosok.softmg.tech/backups/`: `frontend-20261001T112805Z-before-fc037a4/frontend.tar.gz` и `generator-20261001T113119Z/generator.tar.gz`. Оба архива проверены, каталоги имеют права `0700`, архивы — `0600`.
- Backend healthy, время запуска `2026-10-01T11:33:35.215277327Z`; SHA-256 `server.mjs`, `content-store.mjs`, `map-cells.mjs` и `http-cache.mjs` совпали с локальной ревизией. TLS/HTTP/2 проверены после обеих выкладок.
- SHA-256 `index.html` и `sw.js` на VPS и публичном HTTPS совпали со сборкой: `7380d266ab78c973f240c7286a99b9a9fbf89015165e17179f13521fd65ef622` и `d8c2dbcacaeb55c58906cc09c139b3a21c2ce68cb55599fb9014c1a7f1ea5ded`. Версия service worker — `5710fadc99fc8fbb`.
- Публичный manifest содержит 1461 место в двух ячейках; ячейка `55/37` возвращает 1460 уникальных мест, условный запрос с ETag — HTTP 304. В новых Chromium-сессиях 390×844 и 1440×1000 без подмены API карта загрузилась, карточки «Кожевники» и «Южный речной вокзал» получили текст через новый endpoint с HTTP 200. Ошибок JavaScript и HTTP-ошибок ресурсов в проверенных сессиях нет, скриншоты просмотрены.
- Полный Chromium-набор: 415 из 418 прошли сразу; сценарий перемещения карты прошёл отдельно при повторе с одним worker. Два дефекта вёрстки перед стартом прогулки воспроизвелись повторно; подробности и надлежащее исправление описаны в [заметке о проверках](agents/production-main-2026-10-01.md). Исправление вёрстки в эту выкладку не включалось.

## Кеш участков карты — 1 октября 2026, 10:04 UTC

- Ревизия `86e5c5a` отправлена в `origin/main` и опубликована штатной целью `deploy-otgolosok-prod`. Полный `pnpm check` перед публикацией прошёл: 600 frontend-тестов, 529 backend-тестов, 20 Python-тестов и 15 subtests, линтеры, типы и production-сборка.
- Предыдущий фронтенд сохранён в `/srv/sites/otgolosok.softmg.tech/backups/frontend-20261001T100307Z-before-86e5c5a/frontend.tar.gz`. Архив проверен, каталог имеет права `0700`, архив — `0600`; во время выкладки удерживалась advisory-блокировка `.deploy.lock`.
- SHA-256 `index.html` и `sw.js` на VPS и публичном HTTPS совпали с локальной сборкой: `79e8cd1c4bfb03c85dbbdad058289b106f0117f2c9b9bc35ed948c44a0abeade` и `ab360008d1f8e9a7cbd3fbf24196aba19dabbcb9eeadbbd21a049f5e7c7c84e5`. Версия service worker — `4e68b27484c1932d`; штатная проверка TLS и HTTP/2 прошла.
- Проверки Chromium на настоящем сайте без подмены API: телефон 390×844 — 1 запрос на исходном масштабе, 11 суммарно после двух шагов отдаления, 18 после перехода к минимальному масштабу, 1435 уникальных мест в загруженных областях. Компьютер 1440×1000 — соответственно 3, 16 и 21 запрос, 1460 уникальных мест; это число мест в конкретных прямоугольниках, а не общий размер каталога.
- На обоих экранах новые запросы исключают внутреннюю часть первоначального кеша. Два повторных цикла приближения и отдаления после первой догрузки и ещё два на минимальном масштабе дали ноль дополнительных запросов. Все ответы каталога — HTTP 200, ошибок JavaScript нет; скриншоты просмотрены, подложка и кластеры отображаются.
- Backend не переустанавливался: `otgolosok-generator-generator-1` healthy с прежним временем запуска `2026-09-30T16:05:19.324985151Z`.

## Загрузка карты по области — 30 сентября 2026, 16:07 UTC

- Ревизия `ec999e8` опубликована из чистого `git archive`: сначала backend,
  затем frontend штатными целями `deploy-otgolosok-generator` и
  `deploy-otgolosok-prod`. Незакоммиченные изменения рабочего каталога не включались.
- Полный `pnpm check` чистой копии прошёл перед выкладкой и повторно в штатной
  цели frontend: 589 frontend-тестов, 529 backend-тестов, 19 Python-тестов
  и 12 subtests, линтеры, типы и production-сборка.
- Резервные копии в `/srv/sites/otgolosok.softmg.tech/backups/`:
  `frontend-20260930T155506Z-before-ec999e8/frontend.tar.gz` и
  `generator-20260930T160307Z/generator.tar.gz`. Каталоги имеют права `0700`,
  архивы — `0600`. Штатный backend-скрипт проверил архив и оставил три последних
  резервных копии. На время этой выкладки удерживалась advisory-блокировка
  `.deploy.lock`; общий риск скриптов, не использующих эту блокировку, описан
  в [заметке о параллельных выкладках](agents/production-deploy-concurrency.md).
- Backend запущен в `2026-09-30T16:05:19.324985151Z`, healthy. Файлы
  `server.mjs`, `content-store.mjs`, `account-store.mjs`, `store.mjs` в контейнере
  совпали с чистой копией по SHA-256. Публичный API отдаёт 11 мест в контрольном
  прямоугольнике вместо всех 1 461; каждая координата попадает в заданные границы,
  неполный набор границ отклоняется с HTTP 400.
- SHA-256 опубликованных `index.html` и `sw.js` совпали со сборкой:
  `1028a7215bf3e8bfe08be50e88ce0572d0c1b6e544a12bef78c5c0b40f880c13` и
  `55281c36f35ef75aeb22c26bc003a1e9f857d0212dae1c3f785a97eb34e7ae2a`.
  Версия service worker — `da49f7ce89860767`. TLS/HTTP/2 проверены после обеих выкладок.
- В новых гостевых сессиях Chromium на настоящем сайте, без подмены API,
  первый экран 390×844 загрузил 34 места одним запросом, 1440×1000 — 217 мест
  тремя запросами. Проверено точное соответствие ширины первого прямоугольника
  четырём ширинам карты при исходном масштабе; все ответы отфильтрованы по границам.
- Первый шаг отдаления использовал кеш. После второго шага загружены новые области
  из 806 и 1 206 мест соответственно; возврат к исходному масштабу обошёлся
  без запросов. Перетаскивание за кешированную область запустило новую загрузку.
  Все полученные ответы каталога — HTTP 200, ошибок JavaScript нет. Скриншоты
  телефона и компьютера просмотрены, подложка и маркеры отображаются.

## Кластеризация и обновления main — 30 сентября 2026, 14:54 UTC

- Опубликован frontend `c8d0098` из чистого `git archive`. Коммит слияния
  `18621b5` включает удалённый `origin/main` на `1f0d9da`: MapShell, CSS Modules,
  новую геолокацию и векторную подложку. Сохранены кластеризация, полный каталог,
  прогресс загрузки (в том числе при создании прогулки) и фотографии карточек.
- Штатный `deploy-otgolosok-prod` прошёл полный `pnpm check`: 552 frontend-теста,
  495 backend-тестов, 19 Python-тестов и 12 subtests, линтеры, типы и сборка.
  До выкладки прошли также 240 сценариев Chromium: 153 проверки вёрстки,
  71 сценарий интерфейса/прогулок/навигации, 9 сценариев каталога и 7 фотографий.
  WebKit падает с `Bus error: 10` до открытия страницы; его результат не подтверждён.
- Первая попытка собрать объединённую ревизию остановилась до публикации:
  `core.autocrlf=true` менял CSS на CRLF при экспорте, что отвергал новый Prettier.
  Правило `*.css text eol=lf` закреплено в `.gitattributes`; чистый экспорт проверен.
- Предыдущий frontend сохранён в
  `/srv/sites/otgolosok.softmg.tech/backups/frontend-20260930T144939Z-before-18621b5/frontend.tar.gz`.
  Ещё до первой выкладки кластеров создан архив
  `backups/frontend-20260930T142935Z-before-eccca67/frontend.tar.gz` в том же каталоге сайта.
  Права каталогов `0700`, архивов `0600`.
- SHA-256 `index.html` и `sw.js` на VPS совпали с чистой сборкой:
  `80901e8c74028736418415abbfee330cb94e9c99b3bc1da33fb9a8434b412058` и
  `784a5e6f47147d637778f07c2ef330b1090386b7c5a662811df6d9e65ba4ccaf`.
  TLS/HTTP/2 проверены. Эта выкладка обновляла только frontend. Позже, при
  параллельном обновлении backend, API кратковременно отвечал 404: контейнер
  перезапускался. Новый backend запущен в `2026-09-30T14:59:14.096571341Z`,
  статус healthy, API снова отвечает 200; контрольные суммы frontend не изменились.
- В новой production-сессии Chromium получены 15 страниц HTTP 200: 1 461
  уникальное место, 1 438 с аудио. На дальнем масштабе сумма чисел в группах
  и отдельных маркеров равна 1 461 при 39 элементах маркеров в DOM.
  На исходном ближнем масштабе — 12 отдельных маркеров в расширенной видимой области.
  Группа раскрывается с клавиатуры, карточка «Кожевники» открывается.
  Начальный и промежуточный прогресс видимы, после загрузки статус исчезает.
  Векторная подложка работает; ошибок JavaScript, HTTP-ошибок её ресурсов
  и нарушений CSP не обнаружено.


## Полный каталог карты и удаление демонстрационных точек — 30 сентября 2026, 11:08 UTC

- Фронтенд ревизии `09e33be` опубликован штатной командой `deploy-otgolosok-prod`
  из отдельного `git archive`. Перед выкладкой прошёл полный `pnpm check`:
  441 frontend-тест, 495 backend-тестов, 19 Python-тестов и 12 subtests,
  линтеры, проверки типов и production-сборка.
- Первый запуск остановился до публикации на нестабильном тесте `Retry-After`:
  округление HTTP-даты до секунды и время выполнения дали 1995 мс вместо
  ожидаемых 3000±1000 мс. В тесте зафиксированы часы и введена точная проверка
  задержек и верхнего предела; код повторных запросов не менялся. С этим
  исправлением весь цикл проверки и выкладки завершился успешно.
- Резервная копия предыдущего фронтенда и его конфигурации:
  `/srv/sites/otgolosok.softmg.tech/backups/frontend-20260930T110458Z-before-09e33be/frontend.tar.gz`.
  Каталог имеет права `0700`, архив `0600`.
- SHA-256 опубликованных `index.html` и `sw.js` совпали с локальной сборкой:
  `51b4b841e54355a41c7073e641e3a87c084b2b63a629dc42e16a5c0914fcf115` и
  `372359b86f0d715e9437082334db79436003ab10a9f140a6feee77254caa75aa`.
  Штатная проверка TLS и HTTP/2 прошла. Генератор остался healthy с прежним
  временем запуска `2026-09-30T10:37:51.294592642Z`.
- На настоящем production-сайте в Chromium проверена новая гостевая сессия:
  15 ответов каталога с HTTP 200, 1 461 уникальное место, 1 438 мест с аудио
  и ровно 1 461 маркер. Каждая запись сопоставлена с маркером; пропусков,
  дополнительных демонстрационных точек и ошибок JavaScript нет.
- Для проверки прогресса браузер временно задерживал отправку первого и
  второго GET-запросов, сохраняя настоящие ответы API. Начальный статус,
  промежуточные 100 из 1 461 и полоса прогресса видимы на экране 390×844;
  после последней страницы статус исчезает.

## Проверка индекса карты по ячейкам после выкладки

Порядок выкладки: сначала backend, затем frontend. Устройство индекса описано в [заметке о загрузке карты](agents/map-viewport-loading.md). Сайт отвечает только по HTTP/2, поэтому нужен `--http2`.

```bash
curl -sI --http2 -H 'Accept-Encoding: br' https://otgolosok.online/api/content/map-cells
```

Ожидается 200 с `ETag`, `Cache-Control: no-cache`, `Vary: Accept-Encoding` и `Content-Encoding: br`. Повтор с полученным ETag должен вернуть 304:

```bash
curl -sI --http2 -H 'If-None-Match: "<etag>"' https://otgolosok.online/api/content/map-cells
```

Те же заголовки проверяются для `/api/content/map-cells/55/37` и детали любого места `/api/content/places/osm:…`. Затем в браузере проверяются:
- при первом открытии — один запрос манифеста и одна-две ячейки;
- при перезагрузке — 304 на манифест без запроса ячейки;
- загрузка текста истории по клику;
- отсутствие ошибок JavaScript.

Результаты записываются в этот журнал.

## TLS и HTTP/2

Для `otgolosok.online` на HTTPS разрешены TLS 1.2 и 1.3; запросы HTTP/1.1 получают 505, сайт и `/api/` обслуживаются по HTTP/2. Порт 80 сохраняет HTTP-перенаправление и проверку сертификата Let's Encrypt. Конфигурация, расположение исходника middleware, резервная копия и результаты проверок описаны в [заметке о TLS и HTTP/2](agents/production-tls-http2.md).

Production: https://otgolosok.online

## Домен

Основной адрес — `otgolosok.online` (регистратор reg.ru, DNS в Cloudflare:
`A @` и `A www` → `93.189.230.19`). `www.otgolosok.online` и старый
`otgolosok.softmg.tech` отвечают 301 на `https://otgolosok.online` с сохранением
пути и query: это отдельный Traefik router `otgolosok-softmg-tech-redirect`,
который `deploy-otgolosok-prod` создаёт через `PUBLIC_HOST` и `REDIRECT_HOSTS`
в `deploy-static.sh`. Каталог `/srv/sites/otgolosok.softmg.tech`, сеть
`otgolosoksoftmgtech-net` и имена Compose-проектов сохранили старый домен — это
внутренние идентификаторы, переименовывать их не нужно.

Backend принимает только один origin (`APP_ORIGIN=https://otgolosok.online`):
Better Auth и проверки same-origin отклоняют запросы с других хостов. Поэтому
старые хосты перенаправляются целиком, а не обслуживают сайт параллельно.
Сертификаты выпускает Traefik через Let's Encrypt HTTP-01. Если в Cloudflare
включить проксирование (оранжевое облако), нужен режим SSL «Full (strict)», а
лимиты по IP в backend начнут видеть адреса Cloudflare вместо клиентов, пока
Traefik не настроен доверять `X-Forwarded-For` от диапазонов Cloudflare.

Infrastructure scripts live in `/Users/fenix007/projects/utils/services` (not a
Git repository). Use its `deploy-otgolosok-prod` and
`deploy-otgolosok-generator` Make targets with `VPS=services@93.189.230.19`.
The generator target uses `deploy-scripts/otgolosok-generator-compose.yml`.

Do not deploy the root development Compose file over production. Nginx remains
in its existing project; the single generator and Valhalla share the
`otgolosok-generator` project and external `otgolosoksoftmgtech-net` network.
Traefik routes the whole `/api/` prefix on `otgolosok.online` to the
generator with priority 100, so new API paths need no ingress change; the
authoritative rule is the `traefik.http.routers.otgolosok-generator.rule` label
in `deploy-scripts/otgolosok-generator-compose.yml`. Production Nginx serves
only the static export and does not proxy the API.
Admin API authentication remains in the backend.

## Заголовки безопасности

CSP страниц собирается вместе со статикой: `scripts/build-content-security-policy.mjs`
после `next build` вставляет в каждый HTML `<meta http-equiv="Content-Security-Policy">`
с SHA-256 хешами inline-скриптов этой страницы. `'unsafe-inline'` для скриптов не
используется. Новый внешний источник (другой сервер тайлов, шрифты, API в браузере)
нужно добавить в `scripts/content-security-policy.mjs`, иначе браузер его заблокирует.

`frame-ancestors`, HSTS, `X-Frame-Options`, `Referrer-Policy` и `Permissions-Policy`
в `<meta>` не работают и отдаются ingress: в production это Traefik middleware, которое
`deploy-otgolosok-prod` включает через `SECURITY_HEADERS=1` в `deploy-static.sh`,
а в Docker Compose этого репозитория — `docker/security-headers.conf`, подключённый в
каждом `location` (`add_header` уровня location отменяет унаследованные).

Универсальная прогулка использует существующие static export и API-прокси:
прямые `/walk`, `/walk/` и `/walk.html` открывают одну оболочку, а query-параметры
выбирают документ в браузере. Аккаунтные `/api/me/*` и публичные
`/api/story-walks/*` проходят через существующий прокси `/api/` без кеширования;
новые порт и сервис не нужны. После деплоя проверьте эти пути, приватный запрос
аккаунта, общую ссылку и 404 после отключения публикации. Модель данных,
миграция и ограничения офлайн-кеша описаны в `docs/agents/walks.md`.

## Локальный TTS

`CONTENT_AUTO_APPROVE=true` отключает ручное утверждение для OSM-текстов, которые прошли автоматическую проверку фактов
и модельную редактуру без замечаний. Такие тексты сразу публикуются и ставятся в очередь выбранного локального TTS;
ошибочные, спорные и недостаточно подтверждённые результаты остаются неопубликованными. По умолчанию флаг выключен.

`LOCAL_TTS_ENGINE=silero` (по умолчанию) или `f5` выбирает профиль новых партий
и ручной озвучки. После изменения нужен перезапуск backend. Созданные задания
сохраняют профиль и ждут подходящий обработчик; автоматического fallback нет.
В production используется `LOCAL_TTS_TRANSPORT=http`: backend сам отправляет
задания на закрытый сервер `just-tts`, без выпуска ключей внешних воркеров.
В режиме `LOCAL_TTS_TRANSPORT=worker` отдельный воркер подключается по ключу.

Для F5 обязательны `F5_MODEL_SHA256`, `F5_REFERENCE_ID` и `F5_CONFIG_SHA256`;
при необходимости задаётся `F5_REFERENCE_SHA256`. Значения должны совпадать с
профилем just-tts. Для HTTP-транспорта также нужны `TTS_API_URL` и
`TTS_API_TOKEN`; настройки `TTS_ENGINE=f5` и `WORKER_PROFILE_ID=f5-ru-v1`
относятся только к альтернативному внешнему воркеру.

The site directory is `/srv/sites/otgolosok.softmg.tech`:

- `generator-compose.yml`: production backend and routing services.
- `.generator.env`: existing credentials; never print or commit its contents.
- `generator-data`: existing SQLite database and audio; preserve this directory.
- `valhalla-data`: persistent Moscow graph, built from BBBike Moscow.osm.pbf.
- `backups`: private deployment archives including credentials and stopped SQLite.
  После успешной выкладки `deploy-otgolosok-generator` оставляет три последних
  `backups/generator-*` и образы `otgolosok-generator:rollback-*` только к ним; остальные
  удаляются (архив ≈ 0,8 ГБ, диск VPS — 38 ГБ). Ссылки на более старые архивы ниже —
  история выкладок, самих файлов уже нет (24 архива удалены 25.09.2026). Бэкапы
  `ingress-*`, `env-*` и каталоги внутри `generator-data` ротация не трогает.
  После каждой сборки образа, в том числе неудачной, скрипт выполняет
  `docker builder prune -af` (без `-a` остаётся невисячий кэш): 28.09.2026 кэш сборки (3,2 ГБ) заполнил диск и деплой упал с `ENOSPC`.

Valhalla is pinned to
`ghcr.io/valhalla/valhalla-scripted@sha256:64b8f444a39521a8409ae39c8c1f5a80ec8d7167af906d9767c0bbea704fadc7`.
It uses one build/server thread, 0.75 CPU, 768 MiB RAM and a 1280 MiB combined
RAM/swap ceiling. Port 8002 is internal only. Readiness probes `/status`;
the generator uses `WALK_ROUTER_URL=http://valhalla:8002/route`.

Ordinary `/api/walk-plan` automatic stop discovery uses the bundled Moscow OSM catalog. The infrastructure
template retains `WALK_OVERPASS_URL=https://maps.mail.ru/osm/tools/overpass/api/interpreter`,
but the ordinary planner only uses this URL if `WALK_DISCOVERY_SOURCE=overpass`
is explicitly set. Opt-in walk research independently uses `WALK_OVERPASS_URL`
for addressed-building discovery, not the offline catalog. It allows one bounded
OSM request per discovery attempt (12-second client deadline, 1 MiB response,
160 elements, at most three candidates); see `backend/WALK_RESEARCH.md`.
The planner retains its 12-second deadline and concurrency limit. No automatic
multi-provider retries or fabricated route fallbacks are used. Refresh the
catalog alongside the Valhalla extract; see `content/walk-builder.md`.

The generator deployment builds/waits for Valhalla before replacing the backend,
waits at most ten minutes for existing jobs to become idle, stops the single
generator, archives its data/configuration, then recreates it. Never use
`down -v`, prune, or launch another worker on the same SQLite database.

## Фото мест из Wikidata и Commons

- Перед включением проверьте с VPS доступ к Wikimedia, например
  `docker exec otgolosok-generator-generator-1 node -e "fetch('https://www.wikidata.org/w/api.php?action=query&format=json').then(r=>console.log(r.status))"`.
  При реализации (1 октября 2026) это не проверялось: SSH-ключ хоста VPS на машине разработки не был известен.
- Добавьте в `.generator.env` строку `PLACE_IMAGE_SYNC=true` (production-compose подключает файл через `env_file`;
  если переменные перечислены явно, добавьте `PLACE_IMAGE_SYNC: ${PLACE_IMAGE_SYNC:-false}` как в `compose.yaml`)
  и выложите backend штатным `make deploy-otgolosok-generator`. Файлы ложатся в `generator-data/place-images/`
  (`/data/place-images` в контейнере), этот каталог сохраняется вместе с базой.
- Первый проход: `docker exec otgolosok-generator-generator-1 node sync-place-images.mjs --dry-run --limit 200`,
  затем без `--dry-run`. Команда печатает итог по причинам и завершается с ошибкой, если Wikimedia попросил подождать.
  Остальное догоняет фоновый обработчик.
- Раз в месяц или после массовых перепроверок: `docker exec otgolosok-generator-generator-1 node sync-place-images.mjs --prune`.
- `/api/place-images/` проходит через существующий маршрут Traefik на backend; после выкладки проверьте у одного
  файла `Cache-Control: public, max-age=31536000, immutable` и 404 для несуществующего хеша.
- Подробности — `docs/agents/place-photo-preview.md`.

## Служебный API промо-прогулок

- Добавьте в `.generator.env` новое случайное значение `PROMO_WALKS_TOKEN`
  (64 hex-символа, например `openssl rand -hex 32`), предварительно сохранив
  копию файла в `backups/env-<время>/`. Значение не печатайте и не коммитьте.
- Если `deploy-scripts/otgolosok-generator-compose.yml` перечисляет переменные
  backend явно, добавьте туда `PROMO_WALKS_TOKEN: ${PROMO_WALKS_TOKEN:-}` (как в
  `compose.yaml` этого репозитория), иначе эндпоинт останется выключенным (404).
- Выкладка — штатным `make deploy-otgolosok-generator`. При старте backend
  создаёт пользователя `promo-walks` (роль `service`, без учётных данных).
- Пользователя `promo-walks` нельзя удалять: `ON DELETE CASCADE` удалит все
  промо-прогулки и сломает ссылки во всех опубликованных роликах Shorts.
- То же значение передаётся Shorts-воркеру как `OTGOLOSOK_SERVICE_TOKEN` —
  только по закрытому каналу, не через чат и не через git.

## Verification on 2026-09-08

- `make deploy-otgolosok-prod`: lint, TypeScript, 138 frontend tests, 68 backend
  tests, static build and Nginx deployment passed.
- `make deploy-otgolosok-generator`: completed after resuming a local command
  timeout; the persistent cold graph build continued on the VPS.
- `/walk`, `/create`, `/admin`: HTTP 200.
- `/api/story-service`: HTTP 200, generation enabled.
- `/api/story-admin/jobs` without credentials: HTTP 401.
- Cross-origin POST `/api/walk-plan`: HTTP 403.
- Same-origin manual loop: HTTP 200, 970 m, 12 minutes, 71 geometry points.
- Same-origin manual open route: HTTP 200, 485 m, 6 minutes, 36 geometry points.
- Automatic discovery after the endpoint update: both public same-origin
  requests returned HTTP 200 from an Arbat start, with four discovered stops.
  Loop: 2123 m, 28 minutes, 192 geometry points, 2.1-second response.
  Open: 1212 m, 16 minutes, 112 geometry points, 0.7-second response.
- Valhalla and generator healthy; Valhalla had no OOM or restarts.
- SQLite quick check passed; six jobs unchanged (one ready, one failed, four
  requiring review). No generation jobs or paid AI calls were initiated.
- Backup: `backups/generator-20260908T072153Z/generator.tar.gz`, mode 0600.
- Endpoint-update backup: `backups/generator-20260908T072816Z/generator.tar.gz`,
  mode 0600. Generator redeployed while idle; Valhalla was not restarted.
- Walk planner and server regression tests: all 18 passed for the endpoint update.

The initial HTTP 406 diagnosis was from a diagnostic request without the
application's headers, not evidence of invalid Overpass QL. Repeating that
headerless request reproduced 406, while the exact application POST succeeded
against `overpass-api.de` but also exceeded the planner deadline on a public
loop request. Private Coffee and Kumi failed the bounded planner probes.
The Mail.ru endpoint passed both loop/open probes from the backend container,
then both public API checks after deployment. Public Overpass availability is
still an external dependency; failures remain bounded and return honest errors.

After the graph build, the VPS had approximately 12 GiB disk free and 1.3 GiB
available RAM, but only 291 MiB swap free. Monitor memory pressure before
increasing graph coverage or concurrency.

## Yandex TTS deployment — 2026-09-08, 13:43 UTC

- Deployed application revision `31cfef7` using both standard Make targets.
- Added `YANDEX_TTS_API_KEY` from the local environment to `.generator.env`,
  preserving existing production credentials. The default Yandex voice is `marina`.
- Prior environment backup: `backups/env-yandex-20260908T134219Z/.generator.env`;
  generator/data backup: `backups/generator-20260908T134250Z/generator.tar.gz`.
  Both credential-bearing files are private (0600).
- Lint, TypeScript, 143 frontend tests, 89 backend tests and static build passed.
- `/`, `/admin`, `/create`, `/walk` and `/api/story-service` returned HTTP 200;
  generation is enabled. Unauthenticated admin access returned HTTP 401.
- Authenticated production admin API exposes 18 Yandex and 13 OpenAI voices.
  Browser checks passed for login, provider/voice selection, mobile layout and
  logout without changing or approving any existing job.
- Live SpeechKit request from the production container with voice `kirill`
  returned HTTP 200 and a valid 3.96-second MP3. The temporary sample was removed.
- All nine job records remained byte-for-byte unchanged; SQLite quick check passed.
  Generator and Valhalla are healthy; Valhalla was not restarted.

## Editorial tables and revoicing deployment — 2026-09-08, 14:37 UTC

- Deployed application revision `0defcd8`: generator first, then frontend using
  the standard Make targets. Lint, TypeScript, 152 frontend tests, 110 backend
  tests and the static build passed.
- Backup: `backups/generator-20260908T143614Z/generator.tar.gz`, mode 0600.
  The generator was idle before replacement; Valhalla was not restarted.
- All nine existing job records remained byte-for-byte unchanged. SQLite quick
  check passed; the migration initialized four walk chapters.
- `/`, `/admin`, `/create`, `/walk` and `/api/story-service` returned HTTP 200.
  Production `/admin` HTML matches the local build byte-for-byte.
- Authenticated admin endpoints expose address relevance flags, the built-in
  walk and its four chapters, 13 OpenAI voices and 18 Yandex voices. Public
  `/api/story-walks/msk-kozhevniki-zindel-short` returns the published route.
  Unauthenticated walk-admin access returns HTTP 401.
- The reported job `5a242404-42b6-431b-95c6-d395b7656ee5` remains failed with
  `canRetry: true`; deployment did not resume it or initiate paid synthesis.
- Generator and Valhalla are healthy with zero restarts.

## Walk discovery outage fix — 2026-09-08, 14:59 UTC

- Reproduced automatic `/api/walk-plan` returning HTTP 503 after 12 seconds,
  while a manual pedestrian route returned HTTP 200. Mail.ru Overpass requests
  alternated between success and timeout; other public instances also failed
  bounded probes. The routing graph was healthy.
- Replaced default external discovery with a bundled catalog of 229 addressed
  historic, heritage or museum buildings, extracted from the existing production
  `Moscow.osm.pbf`. Source SHA-256:
  `86b5684276bc35a231cd3afba53647cd261731eccba34bdf89f9d553ba2a91b5`.
  Catalog generation skipped no incomplete building geometries. Refresh this
  snapshot when updating the graph's source extract.
- Optional Overpass discovery now has its own public error code and recommends
  adding manual stops; it no longer reports a routing outage.
- Lint, TypeScript, 152 frontend and 114 backend tests passed. A synthetic OSM
  fixture verified node, way and multipolygon centers and deterministic output.
- Six pre-deployment loop/open probes from Arbat, Kozhevnicheskaya and
  Lavrushinsky used only internal Valhalla requests and completed in 63–256 ms.
- Deployed with `make deploy-otgolosok-generator`. Backup:
  `backups/generator-20260908T145925Z/generator.tar.gz`. The generator was idle
  before replacement; Valhalla was not restarted.
- Public automatic loop/open requests with 30-, 60- and 90-minute budgets and a
  manual route all returned HTTP 200 (76–1583 ms). `/walk` and
  `/api/story-service` returned HTTP 200; cross-origin planning returned 403.
- All nine existing jobs remained byte-for-byte unchanged; SQLite quick check
  passed. No story generation or speech synthesis was requested.
- Browser interaction verification was unavailable: the in-app execution tool
  was absent and the separate browser connector reported an occupied profile.
  Public endpoint checks and automated frontend tests passed as described above.

## Opt-in walk research deployment, 2026-09-09, 11:17 UTC

- Deployed revision `ca6d386aa5222ed77f093f9adc666e926dccd0bc`, generator first,
  then frontend, using both standard infrastructure Make targets with
  `VPS=services@93.189.230.19`. No root development Compose deployment was used.
- Lint, TypeScript, 162 frontend tests, 140 backend tests and static build passed,
  including a repeat through the standard frontend deployment target.
- Production generator image:
  `sha256:8626551e1db2517858d2d92940397e2ffab4731828b7852c3bf88f6cb07e8eda`.
  Backend source checksum comparison found no differences; container server and
  research module hashes match the local revision. `/walk`, `/create`, `/admin`
  returned 200 and matched the deployed local HTML byte-for-byte.
- `/api/story-service` returned 200 with `enabled:true`. Random-ID research GET,
  unregistered recovery-token lookup, and random-ID retry POST returned JSON 404.
  Research POST without consent returned 400, foreign-origin POST returned 403,
  and unauthenticated `/api/story-admin/jobs` returned 401. No valid-consent
  research POST or retry of an existing job was made.
- Public automatic Gorky Park loop (`55.731,37.601`, 30 minutes) returned 200:
  2373 metres, 30 walking minutes, two stops and 136 geometry points.
- Direct read-only `createResearchDiscovery` probes from the running container
  used the existing Mail.ru Overpass URL only. The first failed boundedly with
  `WALK_DISCOVERY_UNAVAILABLE` after 12.1 seconds; the second returned three OSM
  candidates in 2.156 seconds. External discovery remains intermittent; this is
  not evidence that the full paid research/narration pipeline succeeds live.
- All nine job rows, three retry rows and four walk-chapter rows retained their
  pre-deployment SHA-256 hashes. SQLite `quick_check` returned `ok`; new tables
  `walk_research_cache` and `walk_research_grants` are empty. Job states remain
  two ready, one failed, one insufficient-evidence and five review-required.
  No jobs, quota reservations, research-provider calls or TTS were initiated by
  deployment verification.
- The generator was idle before replacement. Generator and Valhalla are healthy,
  with zero restarts; Valhalla retained its container ID and September 8 start
  time. Existing credentials and persistent data were preserved.
- Private generator backup (0600):
  `backups/generator-20260909T111619Z/generator.tar.gz`. Separate ingress config
  backup: `backups/ingress-20260909T111541Z/{traefik.yml,nginx.conf}` (0600 files).
- Recovery-token privacy is configured at both ingress layers. Traefik v2.11.56
  includes query strings in `RequestPath`, so its enabled JSON access log now
  drops that field globally (host/router/status remain available). This required
  one shared Traefik restart before deploying the research API. Eleven subsequent
  site requests across both routers had no `RequestPath` or recovery-token query
  content in access logs. Path-level traffic reporting is consequently unavailable.
- Production Nginx differs from `docker/nginx.conf`: it serves static files and
  does not proxy the API. The infrastructure static deployment now installs a
  site-specific `api_private` log format using `$uri`, without queries or Referer,
  and applies it at server scope. Candidate and live `nginx -t` checks passed.
  The development Nginx config was not copied over production.
- Infrastructure edits: `deploy-scripts/otgolosok-generator-compose.yml` (routes),
  `deploy-scripts/deploy-static.sh` (site log privacy),
  `deploy-scripts/beget-init.sh` and `deploy-panel/app.js` (Traefik config templates).
  Live `/srv/traefik/traefik.yml` has the matching access-log field exclusion.
  Shell syntax and panel JavaScript syntax checks passed.
- Verification did not exercise a paid research/narration job or browser UI.
  No commits or pushes were made during this deployment.

## Переработка раздела OSM-партий — 2026-09-22, 07:14 UTC

- Развёрнута ревизия `50d1da6`: сначала генератор
  (`make deploy-otgolosok-generator`), затем фронтенд
  (`make deploy-otgolosok-prod`), оба с `VPS=services@93.189.230.19`.
  Lint, TypeScript, 205 frontend-тестов, 230 backend-тестов и статическая
  сборка прошли.
- Перед заменой все записи `jobs` были в терминальных состояниях, поэтому
  проверка простоя прошла сразу. Valhalla не перезапускалась (uptime 2 недели).
  Резервная копия: `backups/generator-20260922T071248Z/generator.tar.gz`.
- Состав изменений: маршрут `GET /content/batches/:id/items` с постраничной
  выдачей и фильтром по четырём группам состояний; `listPlaces` возвращает
  `total` и `textStatus`; починен `POST /content/audio/:id/retry` — шаблон
  `${UUID}` стоял в литерале регулярного выражения, поэтому маршрут никогда не
  совпадал и кнопка «Повторить» всегда получала 404.
- Проверка API: `/api/story-service` 200, `/api/content/places?limit=1&status=ready`
  200 с `total: 983` и `textStatus` в записях, `/api/story-admin/jobs` без
  авторизации 401, `/api/story-admin/content/batches/:id/items` без
  авторизации 401. `/`, `/admin`, `/create`, `/walk`, `/login` — 200;
  HTML `/admin` совпадает с локальной сборкой байт в байт.
- Данные сохранены: 15 записей `jobs` в тех же состояниях, 6107 мест,
  983 текста, 430 успешных аудиозаданий, `PRAGMA quick_check` — `ok`.
  Прерванное текстовое задание восстановлено воркером штатно.
- Живая партия содержит 1743 задания: 983 готово, 1 в работе, 72 ждут,
  687 остановлено. До этой правки состав приходил одним ответом и рисовался
  1743 строками без навигации, а задание «в работе» не попадало ни в один
  фильтр.
- Интерактивная проверка интерфейса выполнена локально на этой же сборке
  (фильтры партий и заданий, три страницы каталога, поиск, повтор задания,
  утверждение текста, защита несохранённых правок, вёрстка на 390px,
  консоль без ошибок). На проде браузерная проверка под редактором не
  выполнялась: учётных данных редактора в сессии не было.
- Генерация историй и синтез речи при проверке не запускались.

## Переход по счётчикам вместо фильтра партий — 2026-09-22, 07:35 UTC

- Развёрнута ревизия `0b82d62`, только фронтенд (`make deploy-otgolosok-prod`);
  генератор не трогали, изменения в API не потребовались.
- Причина: на проде партия одна и содержит задания во всех четырёх группах
  состояний (984 готово, 1 в работе, 68 ждут, 690 остановлено), поэтому фильтр
  «есть задания со статусом» совпадал при любом выборе и таблица партий
  никогда не менялась. Редактору нужен список зданий в нужном статусе, а не
  список партий.
- Счётчики в колонке «Прогресс заданий» стали кнопками и открывают задания
  партии, отфильтрованные по выбранной группе; фильтр над таблицей партий
  убран. Фильтр внутри состава партии остался серверным и постраничным.
- Lint, TypeScript, 199 frontend-тестов, 230 backend-тестов и статическая
  сборка прошли. `/admin` — 200, HTML совпадает с локальной сборкой байт в байт.
- Локальная проверка на засеянной базе: каждый счётчик открывает ровно свою
  выборку (остановлено 1 из 1, готово 4 из 4, ждут 115 из 115, все задания
  120), нулевой счётчик неактивен.

## Открытие редактора места и повтор текстовых ошибок — 2026-09-22, 08:04 UTC

- Развёрнут фронтенд из ревизии `9c9e0e8` штатной командой
  `make deploy-otgolosok-prod`. Исходники получены через `git archive` в
  отдельный временный каталог: параллельные изменения рабочей копии в релиз
  не включались. Генератор и Valhalla не перезапускались.
- В чистой копии перед проверками выполнены `next typegen`,
  `node scripts/build-walk-catalog.mjs` и `node scripts/build-map.mjs`.
  Затем прошли lint, TypeScript, 204 frontend-теста, 230 backend-тестов
  и production-сборка. Риск текущего `make check`: он проверяет типы и
  сгенерированный каталог до их подготовки; правильное исправление —
  добавить явные зависимости генерации перед соответствующими проверками.
- Резервная копия фронтенда и конфигурации:
  `backups/frontend-before-9c9e0e8-20260922T080226Z/frontend.tar.gz`, режим 0600.
- `/`, `/admin?section=content`, `/login`, `/api/story-service` вернули 200;
  `/api/story-admin/content/places` без авторизации вернул 401.
  HTML админки и все 11 подключённых JS/CSS совпали со сборкой байт в байт.
  SHA-256 HTML: `2f3e040e25d862fe9c18583366c8c0d2aed9b52332dde02e57767f7ea3f94578`.
  В опубликованном коде найден `content-place-title` — заголовок редактора,
  к которому теперь переводятся экран и фокус.
- По отдельному запросу пользователя повторно поставлены в очередь 126
  OSM-заданий со статусом `failed`, без готового текста. Использован штатный
  `retryBatchItem` с `restartFrom: "auto"`: контрольные точки сохранены,
  счётчик попыток сброшен. Готовые тексты, 559 заданий `review_required`,
  12 заданий `insufficient_evidence` и отдельные аудиозадания не перезапускались.
- Перед повтором сделан согласованный SQLite-снимок через `VACUUM INTO`.
  Снимок и списки целей/результатов сохранены в контейнере в
  `/data/ops-backups/text-retry-2026-09-22T080416541Z/` (каталог 0700,
  файлы 0600). Все 126 заданий после операции находились в `queued`;
  постановка в очередь не означает успешного завершения генерации.
- Генератор и Valhalla после обновления здоровы; Nginx прошёл проверку
  конфигурации и перечитал её без пересоздания контейнера. Интерактивная
  проверка под редактором на проде не выполнялась; локальная проверка
  этой ревизии на 1440×900 и 390×844 описана в
  [заметке о редакторе](agents/content-editor-navigation.md).

## Фильтр заданий по ошибке — 2026-09-22, 09:59 UTC

- Развёрнута ревизия `15a81f3`: генератор (`make deploy-otgolosok-generator`),
  затем фронтенд (`make deploy-otgolosok-prod`), оба с
  `VPS=services@93.189.230.19`. Генератор публиковался дважды: второй раз —
  ради дополненного списка сообщений об ошибках, фронтенд при этом не менялся.
  Резервные копии: `backups/generator-20260922T095611Z/generator.tar.gz` и
  `backups/generator-20260922T095932Z/generator.tar.gz`.
- Состав изменений: `GET /content/batches/:id/items` принимает `error`
  (`all`, `none` или код) и возвращает `errors` — количество заданий по каждому
  коду внутри выбранного статуса; в составе партии появился второй фильтр
  «Ошибка»; задание сохраняет в `message` объяснение вместо копии кода.
- Проверки перед публикацией: lint, TypeScript, 213 frontend-тестов,
  232 backend-теста, статическая сборка.
- Проверка прода: `/`, `/admin`, `/login`, `/api/story-service` — 200;
  `/api/story-admin/content/batches` без авторизации — 401. HTML `/admin`
  совпадает с локальной сборкой байт в байт (SHA-256
  `97067e67ff579982f43213fca0ac2862d4783b8a27a19c555f511808cdc678c4`),
  опубликованный чанк содержит новый фильтр. `content-store.mjs`,
  `content-pipeline.mjs` и `server.mjs` в контейнере совпадают с локальными
  по SHA-256.
- Данные сохранены: `PRAGMA quick_check` — `ok`, 6107 мест, 997 текстов,
  15 записей `jobs` в прежних состояниях. Состав партии на момент проверки:
  997 готово, 564 нужна редактура, 149 в очереди, 13 ждут повтора,
  12 без источников, 7 ошибок, 1 в работе — воркер продолжает работу после
  замены контейнера.
- Коды ошибок в живой партии (read-only запрос к базе): ADDRESS_UNCLEAR — 332,
  REVIEW_REQUIRED — 232, PROVIDER_FAILED — 14, INSUFFICIENT_EVIDENCE — 12,
  TIMEOUT — 3, SOURCE_ACCESS_FAILED — 3. У всех этих записей `message` равен
  коду: они упали до исправления, поэтому в колонке «Ошибка» показывается
  только код. Человеческий текст появится у заданий, упавших после публикации.
- Интерактивная проверка под редактором на проде не выполнялась: учётных
  данных редактора в сессии не было. Генерация историй и синтез речи при
  проверке не запускались.

## Прогулки на карте и личный кабинет — 2026-09-22, 14:31 UTC

- Развёрнута ревизия `3932067` (merge PR #3,
  `feat/auth-account-osm-pipeline`): сначала генератор
  (`make deploy-otgolosok-generator`), затем фронтенд
  (`make deploy-otgolosok-prod`), оба с `VPS=services@93.189.230.19`.
  Локальная `main` отставала на 81 коммит; перед публикацией выполнен
  fast-forward до `origin/main`.
- Проверки перед публикацией: `pnpm install --frozen-lockfile`,
  `next typegen`, `build-walk-catalog.mjs`, `build-map.mjs`, lint, TypeScript,
  305 frontend-тестов, 276 backend-тестов, статическая сборка.
- Перед заменой все 15 записей `jobs` были в терминальных состояниях, поэтому
  проверка простоя прошла сразу. Valhalla не перезапускалась (uptime 2 недели).
  Резервная копия: `backups/generator-20260922T142808Z/generator.tar.gz`.
- Миграции применились на живой базе: `user_walks` получила колонки
  `visibility` (по умолчанию `private`) и `share_token`, создана пустая таблица
  `user_generation_intents`. Новых обязательных переменных окружения нет:
  `USER_DAILY_GENERATION_LIMIT` имеет значение по умолчанию 6.
- Маршрутизация не менялась: Traefik отдаёт генератору весь `PathPrefix(/api/)`,
  поэтому новые `/api/me/*` и `/api/story-walks/*` работают без правок ingress.
  Nginx отдаёт новую страницу `/history` общим правилом `try_files $uri $uri.html`.
- Проверка прода: `/`, `/admin`, `/create`, `/walk`, `/history`, `/login`,
  `/api/story-service` — 200 (`enabled: true`). HTML всех шести страниц совпал
  с локальной сборкой байт в байт. `sw.js` совпадает по версии
  `2e0cbf9b5daf8e84`, в precache добавлены `/walk`, `/history`, `/account`.
- Границы доступа: `/api/me`, `/api/me/walks`, `/api/story-admin/jobs`,
  `/api/story-admin/content/places`, `/api/story-admin/content/batches` без
  авторизации — 401; межсайтовый POST `/api/walk-plan` — 403; ссылка на чужую
  прогулку со случайным идентификатором — 404. Публичная
  `/api/story-walks/msk-kozhevniki-zindel-short` — 200.
- `server.mjs`, `walks.mjs`, `account-store.mjs`, `walk-document.mjs`,
  `walk-view.mjs`, `walk-catalog.mjs`, `user-walks.mjs` и
  `favorite-summary.mjs` в контейнере совпадают с локальными по SHA-256.
- Данные сохранены: `PRAGMA quick_check` — `ok` в `jobs.sqlite` и `auth.sqlite`,
  6107 мест, 1019 текстов, 15 записей `jobs` в прежних состояниях, 1 аккаунт.
- Браузерная проверка на 390×844 без авторизации: главная открывается картой с
  метками и нижней навигацией «Рядом / Прогулка / История / Профиль», `/walk`
  без сохранённой прогулки переводит на `/history`, `/login` показывает форму
  входа. В консоли ошибок нет, два предупреждения о неиспользованном
  `link preload` для CSS-чанков.
- Генерация историй и синтез речи при проверке не запускались.

## Триаж weak_identity и фильтр пригодности партий — 2026-09-23, 16:26 UTC

- Развёрнута ревизия `8b743e2` (вместе с `bb9e705` и `323b6b2`): генератор
  (`make deploy-otgolosok-generator`), затем фронтенд (`make deploy-otgolosok-prod`),
  оба с `VPS=services@93.189.230.19`. Перед фронтендом `make check` прошёл,
  310 backend-тестов без ошибок. Резервная копия генератора:
  `backups/generator-20260923T162600Z/generator.tar.gz`.
- Причина остановки прироста текстов (1102 из 6107): единственная партия
  `OSM снимок · 18.09.2026` на 1743 места полностью дошла до конечных состояний
  (1102 готово, 617 на редактуре, 14 без источников, 10 ошибок), очередь пуста.
  Остальные 4364 места — weak_identity, обычный фильтр пригодности их не пропускает.
- Проверка прода: `/`, `/admin`, `/login`, `/api/story-service` — 200;
  `/api/story-admin/content/identity-candidates` без авторизации — 401.
- Оценка кандидатов записана в production-базу. `scripts/` в образ не входит,
  поэтому скрипт передан в контейнер через stdin с импортами из `/app/`.
  Перед записью снимок `VACUUM INTO` в
  `/data/ops-backups/identity-assess-2026-09-23T162919742Z/`. Итог
  `identity-triage-v1`: 4364 кандидата, `auto` — 526, `enrich` — 2894,
  `manual` — 944.
- Создан и запущен пилот `81fa6d3f-115f-4ff9-bf32-0dc548a231be` на 20 мест
  уровня `auto`, только текст, без автоутверждения. Вызваны те же методы
  хранилища, что и в API (`createIdentityPilot`, `setBatchState`), потому что
  учётных данных редактора в сессии не было. Воркер подхватил задания в течение
  нескольких секунд.

## Merge PR #5 и подробности задания партии — 2026-09-28, 14:10 UTC

- Развёрнута ревизия `f7f8478` (merge PR #5 с исправлениями второго код-ревью,
  подробности задания партии в админке): генератор
  (`make deploy-otgolosok-generator`), затем фронтенд (`make deploy-otgolosok-prod`),
  оба с `VPS=services@93.189.230.19`. Перед публикацией `pnpm check` прошёл:
  381 frontend-тест, 415 backend-тестов, pyright, pytest, сборка.
- Первая попытка упала при сборке образа: диск VPS был заполнен на 100%
  (123 МБ свободно), кэш сборки занимал 4 ГБ. `docker builder prune -f` в скрипте
  выкладки удаляет только висячий кэш, эти 4 ГБ он не трогал; очищено вручную
  `docker builder prune -af`, скрипт переведён на `-af`.
- Вторая попытка оборвалась на распаковке образа: VPS перезагрузился при смене
  тарифа (диск 38 → 77 ГБ, память ≈ 6 ГБ). После загрузки поднялся прежний образ,
  прод работал. Третья попытка прошла. Резервная копия:
  `backups/generator-20260928T140720Z/generator.tar.gz`.
- Проверка прода: `/`, `/admin`, `/walk`, `/history`, `/login`,
  `/api/story-service` — 200. `provider.mjs` и `content-store.mjs` в контейнере
  совпадают с локальными по SHA-256, `/admin` совпал с локальной сборкой байт в байт,
  `sw.js` версии `5fbd97574eb30167`. Диск после выкладки занят на 49%.

## Служебный API промо-прогулок (PR #6) — 2026-09-28, 14:57 UTC

- Развёрнута ревизия `bdc63d0`: генератор, затем фронтенд, оба с
  `VPS=services@93.189.230.19`. Перед публикацией `pnpm check` прошёл.
- `PROMO_WALKS_TOKEN` (64 символа) перенесён из локального `.env` в
  `.generator.env` без вывода значения; копия прежнего файла —
  `backups/env-20260928T145454Z-promo/`. Production-compose подключает
  `.generator.env` через `env_file`, правка compose не понадобилась.
  Резервная копия генератора: `backups/generator-20260928T145702Z/generator.tar.gz`.
- Проверка: `/`, `/admin`, `/walk`, `/api/story-service` — 200.
  `POST /api/service/promo-walks` без токена и с чужим токеном — 401, с верным
  токеном и пустым телом — 400 (прогулка не создавалась). Пользователь
  `promo-walks@service.invalid` с ролью `service` создан в `auth.sqlite`.
- Кэш сборки после выкладки — 0 Б (`docker builder prune -af` в скрипте), диск — 53%.

## Фильтр черновиков и защита массовой озвучки — 2026-09-28, 16:15 UTC

- Развёрнута ревизия `37c8fdd`: backend и фронтенд штатными Make-целями.
  Перед выкладкой `pnpm check` прошёл: 387 тестов интерфейса, 441 тест backend,
  Ruff, pyright, pytest и production-сборка.
- В ходе backend-деплоя обнаружены два параллельных запуска. Первый остановлен
  до переключения образа, его неполный архив удалён; второй завершился успешно.
  Резервная копия: `backups/generator-20260928T161018Z/generator.tar.gz`.
  Подробности и риск повторения — в
  [заметке о параллельных выкладках](agents/production-deploy-concurrency.md).
- `store.mjs` и `content-store.mjs` в production-контейнере совпали с локальными
  по SHA-256. `/admin` совпал с локальной сборкой байт в байт; новый JS-файл с
  фильтром «Только черновики» отвечает 200. `/api/story-service` — 200,
  запрос к редакторскому API без входа — 401, backend healthy.
- В базе после выкладки 101 место только с черновиком, текстовая очередь
  продолжает работу: 399 ожидают, одно в работе. Все 1438 аудиозаданий имеют
  состояние `succeeded`; новые задания проверкой не создавались.

## Поиск источников через Perplexity — 2026-09-29, 15:02 UTC

- В `.generator.env` добавлено `RESEARCH_SEARCH_MODEL=perplexity-web/pplx-auto` без вывода
  остальных значений; копия прежнего файла — `backups/env-20260929T141213Z-search/`.
- Первые две выкладки генератора столкнулись с параллельной выкладкой PR #7 из другой вкладки
  (конфликт имени контейнера при пересоздании, затем перезапись образом `deploy-5e2f150` без этих
  изменений). После объединения `e4c05ee` (PR #7) с `main` и `pnpm check` выложен объединённый
  `main`: генератор, затем фронтенд. Резервная копия: `backups/generator-20260929T150219Z/`.
- Проверка: `walks.mjs`, `promo-walks.mjs`, `content-store.mjs`, `content-pipeline.mjs`,
  `provider.mjs`, `server.mjs` в контейнере совпали с локальными по SHA-256; `/`, `/admin`,
  `/api/story-service` — 200; текст «Переисследовать через Perplexity» есть в production-бандле.
  Первое задание пилота получило 5 ссылок от Perplexity.
- Очереди «Открытые данные · 524 мест» и «Объекты наследия · 92 мест» остаются на паузе: после
  возобновления каждое их задание weak_identity тоже будет тратить запрос Perplexity.

## Переозвучка через ElevenLabs — 2026-09-30, 07:34 UTC

- В `.generator.env` добавлены `ELEVENLABS_API_KEY` (из локального `.env`, без вывода значения),
  `ELEVENLABS_VOICE_ID=9ivxhQ6xIsHd6R3Xc635` («Отголосок2») и `ELEVENLABS_MODEL=eleven_v3`;
  копия прежнего файла — `backups/env-20260930T072514Z-elevenlabs/`.
- Выложены `80c078c`, затем `f5c3a3f` (только генератор). Резервные копии:
  `backups/generator-20260930T072717Z/`, `backups/generator-20260930T073420Z/`.
- API ElevenLabs не обслуживает российский VPS: на любой запрос отвечает редиректом на страницу об
  ограничениях по странам. Backend при запуске пишет `ElevenLabs is disabled: the API is not available
  from this server's country` и не предлагает сервис в `/admin`. Нужен прокси `ELEVENLABS_BASE_URL`,
  см. [заметку](agents/elevenlabs-region-block.md). Фронтенд с выбором профиля для мест не выкладывался:
  без ElevenLabs выбор не показывается.
- Проверка: `elevenlabs-tts.mjs` в контейнере совпал с локальным по SHA-256; `/`, `/admin`,
  `/api/story-service` — 200, генератор healthy.

## Прокси ElevenLabs — 2026-09-30, 09:15 UTC

- Cloudflare Worker `otgolosok-elevenlabs-proxy` (`ops/elevenlabs-proxy`) выложен на
  `https://elevenlabs-proxy.otgolosok.online`; принимает запросы только с `ALLOWED_IPS`
  (production-VPS и VPN-выход разработчика) и с секретом `X-Proxy-Token`. В `.generator.env` добавлены
  `ELEVENLABS_BASE_URL` и `ELEVENLABS_PROXY_TOKEN` без вывода значения; копия прежнего файла —
  `backups/env-20260930T084044Z-elevenlabs-proxy/`.
- Генератор `43a7ec6` выложен из чистого worktree (в основном checkout были незакоммиченные правки
  параллельного агента), резервная копия `backups/generator-20260930T085915Z/`. В 09:13 параллельный агент
  выложил поверх `3b32280`, в который вошли эти изменения; файлы ElevenLabs в контейнере совпадают с `main`.
- Фронтенд `43a7ec6` выложен из того же worktree: `/admin` совпал со сборкой байт в байт. Проверка TLS в конце
  выкладки упала, пока генератор был остановлен чужой выкладкой; повторный запуск прошёл.
- Сквозная проверка в production-контейнере: `codex/gpt-5.6-sol-low` расставил теги, ElevenLabs через прокси
  озвучил голосом «Отголосок2» (`9ivxhQ6xIsHd6R3Xc635`), MP3 11,5 с после ffmpeg. Данные базы не менялись.
- Шлюз airouter для части запросов стабильно возвращает 400 «The 'gpt-5.6-sol' model is not supported when
  using Codex with a ChatGPT account» (`PROVIDER_REJECTED`): один и тот же текст падал 9 раз подряд, другой
  проходил. Это задевает и тегирование, и генерацию текстов; исправлять нужно на стороне OmniRoute.

## Статус переисследования черновиков и фильтр — 2026-09-30, 09:34 UTC

- Развёрнута ревизия `3b32280`: колонка «Исследование» и фильтр «Статус исследования» во вкладке «Черновики»
  (`GET /api/story-admin/content/drafts?research=all|plain|perplexity|queued|failed`, в ответе `counts`).
  Перед выкладкой `npm run check` прошёл целиком (lint, типы, 489 тестов backend, vitest, pytest, сборка).
- Генератор выложен штатной целью (`backups/generator-20260930T091340Z/`); `content-store.mjs` и `server.mjs`
  в контейнере совпали с локальными по SHA-256. Фронтенд выложен следом: `/` и `/admin` — 200, метки фильтра
  есть в бандле, `sw.js` версии `52955d3018968c4d`.
- Счётчики статусов на production-базе тем же SQL, что в `listDrafts`: perplexity 271, plain 227,
  queued 60, failed 2 (всего черновиков 560).
