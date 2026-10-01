# Прокси ElevenLabs

ElevenLabs не обслуживает запросы с production-VPS (редирект на страницу об ограничениях по странам, см.
`docs/agents/elevenlabs-region-block.md`). Этот Cloudflare Worker пересылает `/v1/*` в `https://api.elevenlabs.io`.

- Запрос не с адресов `ALLOWED_IPS` (production-VPS `93.189.230.19` и VPN-выход разработчика `95.173.207.163`) или без заголовка
  `X-Proxy-Token`, равного секрету `PROXY_TOKEN`, получает 403. При смене IP сервера обновите `ALLOWED_IPS`. Пересылаются только
  `xi-api-key`, `Content-Type` и `Accept`, ответы не кэшируются.
- Адрес: `https://elevenlabs-proxy.otgolosok.online` (Custom Domain воркера в зоне `otgolosok.online`).
- Выкладка: `npx wrangler deploy` из этого каталога (аккаунт Cloudflare `support@softmg.ru`).
- Секрет: `openssl rand -hex 32 | npx wrangler secret put PROXY_TOKEN`; то же значение — `ELEVENLABS_PROXY_TOKEN`
  в `.generator.env`, адрес воркера с `/v1` — `ELEVENLABS_BASE_URL`.
