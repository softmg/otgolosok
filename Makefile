SHELL := /bin/sh

.DEFAULT_GOAL := help

PNPM ?= pnpm
DOCKER_COMPOSE ?= docker compose
NODE ?= node
VPS ?= services@93.189.230.19
GENERATOR_CONTAINER ?= otgolosok-generator-generator-1

# Quote arguments for the local shell and, for SSH, again for the remote shell.
shell_quote = '$(subst ','"'"',$(1))'

.PHONY: help install dev dev-https replay build serve lint typecheck test check clean
.PHONY: docker-up docker-down docker-logs docker-ps docker-config
.PHONY: db-dump db-pack db-import db-restore db-info db-prune-audio osm-import osm-load
.PHONY: place-images place-images-prune
.PHONY: admin-create admin-create-prod

help: ## Показать доступные команды
	@awk 'BEGIN {FS = ":.*## "; printf "Отголосок\n\n"} /^[a-zA-Z_-]+:.*## / {printf "  %-12s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Установить зависимости
	$(PNPM) install

dev: ## Запустить локальную разработку
	$(PNPM) dev

dev-https: ## Запустить dev-сервер по HTTPS для GPS и PWA
	$(PNPM) dev:https

replay: ## Запустить dev-сервер; открыть http://localhost:3000/?replay=clean
	@printf '%s\n' 'Replay: http://localhost:3000/?replay=clean'
	$(PNPM) dev

build: ## Собрать статический production export в out/
	$(PNPM) build

serve: build ## Собрать и локально раздать production export
	$(PNPM) start

lint: ## Проверить ESLint
	$(PNPM) lint

typecheck: ## Проверить TypeScript
	$(PNPM) typecheck

test: ## Запустить unit-тесты
	$(PNPM) test

check: ## Выполнить все проверки
	$(PNPM) check

clean: ## Удалить генерируемые каталоги Next.js
	rm -rf -- .next out

docker-up: ## Build and start the complete Docker stack
	$(DOCKER_COMPOSE) up -d --build

docker-down: ## Stop Docker stack, preserving data volumes
	$(DOCKER_COMPOSE) down

docker-logs: ## Follow Docker stack logs
	$(DOCKER_COMPOSE) logs -f --tail=100

docker-ps: ## Show Docker stack status and health
	$(DOCKER_COMPOSE) ps

docker-config: ## Validate Compose without printing credentials
	$(DOCKER_COMPOSE) config --quiet

admin-create: ## Создать редактора локально; EMAIL=ваш@email.ru [AUTH_DB_PATH=путь]
	@test -n $(call shell_quote,$(EMAIL)) || { printf '%s\n' 'Укажите EMAIL: make admin-create EMAIL=ваш@email.ru' >&2; exit 1; }
	@$(NODE) scripts/set-editor.mjs $(call shell_quote,$(EMAIL)) $(if $(AUTH_DB_PATH),$(call shell_quote,$(AUTH_DB_PATH)))

admin-create-prod: ## Создать редактора на проде через SSH; EMAIL=ваш@email.ru
	@test -n $(call shell_quote,$(EMAIL)) || { printf '%s\n' 'Укажите EMAIL: make admin-create-prod EMAIL=ваш@email.ru' >&2; exit 1; }
	@ssh -t -- $(call shell_quote,$(VPS)) $(call shell_quote,docker exec -it -- $(call shell_quote,$(GENERATOR_CONTAINER)) node /app/editor-account.mjs $(call shell_quote,$(EMAIL)) /data/auth.sqlite)

db-dump: ## Снять базу генератора с прода в backend/data/prod-dump (нужен доступ по SSH)
	$(NODE) scripts/prod-db.mjs dump

db-pack: ## Упаковать выгрузку в архив для передачи другому разработчику
	$(NODE) scripts/prod-db.mjs pack

db-import: ## Импортировать выгрузку в backend/data, сохранив прежнюю базу
	$(NODE) scripts/prod-db.mjs import

db-restore: ## Вернуть последнюю сохранённую локальную базу
	$(NODE) scripts/prod-db.mjs restore

db-info: ## Показать состав локальной базы генератора
	$(NODE) scripts/prod-db.mjs info

db-prune-audio: ## Удалить старые аудиофайлы без ссылок в базе
	$(NODE) scripts/prune-audio.mjs

place-images: ## Подобрать и обновить фото мест из Wikidata/Commons (аргументы: PLACE_IMAGES_ARGS)
	$(NODE) backend/sync-place-images.mjs $(PLACE_IMAGES_ARGS)

place-images-prune: ## Удалить файлы фото мест без ссылок в базе
	$(NODE) backend/sync-place-images.mjs --prune

osm-import: ## Собрать каталог достопримечательностей; PBF=path/to/Moscow.osm.pbf
	python scripts/import-osm-attractions.py $(PBF) --output backend/data/osm-attractions.json $(OSM_IMPORT_ARGS)

osm-load: ## Загрузить собранный каталог в SQLite
	$(NODE) scripts/load-osm-catalog.mjs backend/data/osm-attractions.json
