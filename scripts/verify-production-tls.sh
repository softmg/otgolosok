#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE="${ROOT}/ops/production/traefik"
# The production SSH address is not published: VPS=user@host comes from the environment or
# the gitignored .env.ops. The site is checked on the same host unless SITE_IP says otherwise.
if [[ -z "${VPS:-}" && -f "${ROOT}/.env.ops" ]]; then
  VPS="$(sed -n 's/^VPS[[:space:]]*=[[:space:]]*//p' "${ROOT}/.env.ops" | tail -n 1)"
fi
VPS="${VPS:-}"
SITE_IP="${SITE_IP:-${VPS#*@}}"

[[ "${VPS}" =~ ^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+$ ]] || { echo 'Некорректный адрес VPS' >&2; exit 2; }
[[ "${SITE_IP}" =~ ^[0-9.]+$ ]] || { echo 'Некорректный IPv4-адрес сайта' >&2; exit 2; }

hash_file() { LC_ALL=C shasum -a 256 "$1" | cut -d ' ' -f 1; }

if ! ssh -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=3 "${VPS}" bash -s -- \
  "$(hash_file "${SOURCE}/otgolosok-tls.yml")" \
  "$(hash_file "${SOURCE}/h2only/.traefik.yml")" \
  "$(hash_file "${SOURCE}/h2only/go.mod")" \
  "$(hash_file "${SOURCE}/h2only/h2only.go")" <<'REMOTE'
set -euo pipefail
check_hash() {
  local actual
  actual="$(sha256sum "$2" | cut -d ' ' -f 1)"
  [ "${actual}" = "$1" ] || { echo "Отличается конфигурация: $2" >&2; exit 1; }
}
check_hash "$1" /srv/traefik/otgolosok-tls.yml
check_hash "$2" /srv/traefik/plugins-local/src/github.com/softmg/h2only/.traefik.yml
check_hash "$3" /srv/traefik/plugins-local/src/github.com/softmg/h2only/go.mod
check_hash "$4" /srv/traefik/plugins-local/src/github.com/softmg/h2only/h2only.go
docker compose -f /srv/traefik/docker-compose.yml config -q
docker compose -f /srv/sites/otgolosok.softmg.tech/docker-compose.yml config -q
docker compose -p otgolosok-generator -f /srv/sites/otgolosok.softmg.tech/generator-compose.yml config -q
[ "$(docker inspect otgolosok-generator-generator-1 --format '{{index .Config.Labels "traefik.http.routers.otgolosok-generator.tls.options"}}')" = 'otgolosok@file' ]
[ "$(docker inspect otgolosok-generator-generator-1 --format '{{index .Config.Labels "traefik.http.routers.otgolosok-generator.middlewares"}}')" = 'otgolosok-h2-only@file' ]
[ "$(docker inspect otgolosoksoftmgtech-otgolosok-softmg-tech-1 --format '{{index .Config.Labels "traefik.http.routers.otgolosok-softmg-tech.tls.options"}}')" = 'otgolosok@file' ]
[ "$(docker inspect otgolosoksoftmgtech-otgolosok-softmg-tech-1 --format '{{index .Config.Labels "traefik.http.routers.otgolosok-softmg-tech.middlewares"}}')" = 'otgolosok-softmg-tech-security,otgolosok-h2-only@file' ]
[ "$(docker inspect otgolosok-generator-generator-1 --format '{{.State.Health.Status}}')" = healthy ]
REMOTE
then
  echo 'Проверка конфигурации TLS на VPS не прошла' >&2
  exit 1
fi

probe() {
  local expected="$1" protocol="$2" path="$3" actual
  if ! actual="$(curl --silent --show-error --connect-timeout 5 --max-time 10 \
    --resolve "otgolosok.online:443:${SITE_IP}" "${protocol}" \
    --output /dev/null --write-out '%{http_code}' "https://otgolosok.online${path}")"; then
    echo "Не удалось проверить ${path} по ${protocol}" >&2
    return 1
  fi
  [ "${actual}" = "${expected}" ] || { echo "${path} ${protocol}: ожидался ${expected}, получен ${actual}" >&2; return 1; }
}
probe 200 --http2 /
probe 505 --http1.1 /
probe 200 --http2 /api/story-service
probe 505 --http1.1 /api/story-service
echo 'TLS и HTTP/2 на production проверены'
