# Прокси ElevenLabs

ElevenLabs не обслуживает запросы с production-VPS (редирект на страницу об ограничениях по странам, см.
`docs/agents/elevenlabs-region-block.md`). Этот Cloudflare Worker пересылает `/v1/*` в `https://api.elevenlabs.io`.

- Запрос не с адресов из секрета `ALLOWED_SOURCE_IPS` (production-VPS и VPN-выход разработчика) или без заголовка
  `X-Proxy-Token`, равного секрету `PROXY_TOKEN`, получает 403. Без секрета `ALLOWED_SOURCE_IPS` воркер отклоняет все
  запросы. Адреса не публикуются в репозитории: актуальный список хранится в локальном `.env.ops`
  (`ELEVENLABS_PROXY_ALLOWED_IPS`). При смене IP сервера обновите секрет:
  `printf '%s' "ip1,ip2" | npx wrangler secret put ALLOWED_SOURCE_IPS`. Пересылаются только
  `xi-api-key`, `Content-Type` и `Accept`, ответы не кэшируются.
- Адрес: `https://elevenlabs-proxy.otgolosok.online` (Custom Domain воркера в зоне `otgolosok.online`).
- Выкладка: `npx wrangler deploy` из этого каталога (аккаунт Cloudflare `support@softmg.ru`).
- Секрет: `openssl rand -hex 32 | npx wrangler secret put PROXY_TOKEN`; то же значение — `ELEVENLABS_PROXY_TOKEN`
  в `.generator.env`, адрес воркера с `/v1` — `ELEVENLABS_BASE_URL`.
