# Запуск всех OSM-достопримечательностей в production

## Тестовые точки без генерации (только локальная база)

Для проверки интерфейса можно импортировать каталог и опубликовать явно помеченные
заглушки без создания заданий модели или TTS:

```bash
DATA_DIR=<путь-к-локальным-данным> node scripts/seed-osm-test-points.mjs backend/data/osm-attractions.json --test-data
```

Команда добавляет заглушки только для пригодных объектов без существующих текстов.
Повторный запуск не дублирует их. Профиль `test-placeholder-v1` отделён от настоящей
генерации; обычная публикация получает приоритет перед заглушкой. Не запускайте
эту команду на production. Импорт точек сам по себе не добавляет истории в уже
сохранённые прогулки — маршрут нужно построить заново.

Запуск использует F5 через уже настроенный HTTP-сервер `just-tts`. Отдельный
`WORKER_TOKEN` для этой схемы не нужен: backend сам отправляет аудиозадания в
`just-tts` по `TTS_API_URL`, используя `TTS_API_TOKEN`.

## TL;DR

### 1. Передать каталог

С рабочей машины:

```bash
export PRODUCTION_SSH=<пользователь-и-хост-production>

scp backend/data/osm-attractions.json \
  "$PRODUCTION_SSH:/srv/sites/otgolosok/osm-attractions.json"
```

### 2. Импортировать каталог и запустить задания

На production-сервере сначала дополните `.generator.env`. Получить параметры
профиля можно с F5-сервера командой `GET /v1/profiles`; значения самого токена и
ответ с параметрами профиля не добавляйте в Git:

```dotenv
CONTENT_AUTO_APPROVE=true
LOCAL_TTS_ENGINE=f5
LOCAL_TTS_TRANSPORT=http
TTS_API_URL=<закрытый URL сервера just-tts>
TTS_API_TOKEN=<тот же TTS_API_TOKEN, который настроен в just-tts>
F5_MODEL_SHA256=<modelSha256 профиля f5-ru-v1>
F5_REFERENCE_ID=<voice профиля f5-ru-v1>
F5_CONFIG_SHA256=<configSha256 профиля f5-ru-v1>
F5_REFERENCE_SHA256=<referenceSha256 профиля f5-ru-v1>
```

После изменения окружения пересоздайте backend обычной production-командой
деплоя. Затем на production-сервере из checkout текущей версии приложения:

```bash
export APP_ROOT=<путь-к-checkout-otgolosok>
export GENERATOR_ENV=<путь-к-generator.env>
export PRODUCTION_DATA=<путь-к-production-data>

cd "$APP_ROOT"

set -a
. "$GENERATOR_ENV"
set +a

export DATA_DIR="$PRODUCTION_DATA"

node scripts/load-osm-catalog.mjs \
  /srv/sites/otgolosok/osm-attractions.json --complete
node scripts/create-osm-batch.mjs --next --limit 5000 --start
```

Этого достаточно для текущего снимка: в файле 6 107 объектов, но проверку
пригодности проходят 1 553. Все они попадут в одну запущенную партию. Остальные
4 554 объекта импортируются, но не отправляются модели, потому что имеющихся
OSM-данных недостаточно для надёжного определения конкретного объекта.

Команда с `--next` пропускает уже созданные задания. Её можно повторить после
прерванного запуска; дубликаты не появятся. Если в новом снимке подходящих
объектов станет больше 5 000, повторяйте последнюю команду, пока она не сообщит,
что свободных объектов не осталось.

### 3. Проверить результат

```bash
curl -fsS 'https://otgolosok.softmg.tech/api/content/places?status=ready&limit=10'
```

Ход выполнения и ошибки видны в разделе `content` production-админки.
`CONTENT_AUTO_APPROVE=true` публикует только материалы, прошедшие автоматическую
проверку. Статусы `review_required`, `insufficient_evidence` и `failed`
автоматически не публикуются.

`CONTENT_AUTO_APPROVE=true` действует только на новые успешно проверенные тексты.
Он не публикует результаты с ошибками и не утверждает старые черновики.
