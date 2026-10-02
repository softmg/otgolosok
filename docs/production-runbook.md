# Production: эксплуатация

Справочник по устройству production и проверкам после выкладки. Журнал отдельных
выкладок в репозитории не ведётся: репозиторий публичный. Адреса и учётные данные
production сюда не записываются; SSH-адрес VPS хранится в локальном `.env.ops`
(`VPS=user@host`), его читают `make admin-create-prod`, `make db-dump` и
`scripts/verify-production-tls.sh`.

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

## TLS и HTTP/2

Для `otgolosok.online` на HTTPS разрешены TLS 1.2 и 1.3; запросы HTTP/1.1 получают 505, сайт и `/api/` обслуживаются по HTTP/2. Порт 80 сохраняет HTTP-перенаправление и проверку сертификата Let's Encrypt. Конфигурация, расположение исходника middleware, резервная копия и результаты проверок описаны в [заметке о TLS и HTTP/2](agents/production-tls-http2.md).

Production: https://otgolosok.online

## Домен

Основной адрес — `otgolosok.online` (регистратор reg.ru, DNS в Cloudflare:
`A @` и `A www` → адрес production-VPS). `www.otgolosok.online` и старый
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

Infrastructure scripts live in `/Users/fenix007/projects/utils/services` (a local
Git repository without a remote). Use its `deploy-otgolosok-prod` and
`deploy-otgolosok-generator` Make targets. The SSH address of the VPS is not
published: keep `VPS=user@host` in the gitignored `.env.ops` of this repository.
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
  удаляются (архив ≈ 1,2 ГБ). Считаются только каталоги с проверенным
  `generator.tar.gz`; базы SQLite попадают в архив снимками `VACUUM INTO`, см.
  [заметку о бэкапе генератора](agents/generator-backup-snapshots.md). Бэкапы
  `ingress-*`, `env-*` и каталоги внутри `generator-data` ротация не трогает.
  После каждой сборки образа, в том числе неудачной, скрипт выполняет
  `docker builder prune -af` (без `-a` остаётся невисячий кэш): 28.09.2026 кэш сборки (3,2 ГБ) заполнил диск и деплой упал с `ENOSPC`.

Valhalla is pinned to
`ghcr.io/valhalla/valhalla-scripted@sha256:64b8f444a39521a8409ae39c8c1f5a80ec8d7167af906d9767c0bbea704fadc7`.
It uses one build/server thread, 0.75 CPU, 768 MiB RAM and a 1280 MiB combined
RAM/swap ceiling. Port 8002 is internal only. Readiness probes `/status`;
the generator uses `WALK_ROUTER_URL=http://valhalla:8002/route` and
`WALK_TRACE_URL=http://valhalla:8002/trace_attributes` (tunnels on the built route,
drawn dashed; set `WALK_TRACE_URL=` empty in `.env` to switch the lookup off without
a code change, see `docs/agents/route-tunnels.md`).

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
generator, archives its data/configuration (SQLite as consistent snapshots), then recreates it. Never use
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
