# ElevenLabs недоступен с production-VPS

30 сентября 2026 года после выкладки переозвучки через ElevenLabs (`80c078c`) backend не смог прочитать голоса аккаунта.

- Production-VPS `93.189.230.19` находится в России. `api.elevenlabs.io` на любой запрос с него, включая запрос с ключом,
  отвечает `302` на `help.elevenlabs.io/.../Do-you-restrict-access-to-the-service-and-platform-for-any-specific-countries`.
- С рабочего Mac тот же ключ работает: голоса читаются, синтез `eleven_v3` проходит.
- Клиент запрашивает API с `redirect: "manual"` и превращает 3xx в `TTS_REGION_BLOCKED`. При запуске такой ответ
  выключает ElevenLabs целиком, чтобы в `/admin` не было варианта, который всегда падает.
- Исправление — `ELEVENLABS_BASE_URL`: HTTPS reverse proxy к `https://api.elevenlabs.io/v1` на сервере вне России.
  Прокси должен передавать заголовок `xi-api-key` и не кэшировать ответы. Сервер `airouter.softmg.tech` находится в NL.

## Прокси

- Нидерландские серверы airouter (AS216024) и codotok (HOSTKEY) ElevenLabs тоже блокирует, прокси на них не поможет.
  Выход через Cloudflare работает.
- Прокси — Cloudflare Worker `otgolosok-elevenlabs-proxy` из `ops/elevenlabs-proxy`, адрес
  `https://elevenlabs-proxy.otgolosok.online/v1`, секрет в заголовке `X-Proxy-Token` (`ELEVENLABS_PROXY_TOKEN`).
  С production-VPS через него: без токена 403, с токеном и ключом — 200 и голоса аккаунта.
