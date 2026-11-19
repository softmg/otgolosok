FROM node:24.22.3-bookworm-slim@sha256:dc26ae92c9fb15cf6b1d63e20f0944b2efe0f115b20e00be48fb23fceb061c54
RUN apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -o Acquire::Retries=1 update && apt-get -o Acquire::ForceIPv4=true -o Acquire::http::Timeout=20 -y --no-install-recommends install ffmpeg ca-certificates python3 python3-venv && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY vendor/softmg-airouter-logs-0.1.0.tgz ./vendor/
RUN corepack enable && pnpm install --prod --frozen-lockfile
COPY backend/requirements.txt ./
RUN python3 -m venv /opt/venv && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt
RUN mkdir -p /data && chown node:node /data
COPY --chown=node:node backend/*.mjs backend/*.json ./backend/
COPY --chown=node:node backend/normalize-tts.py ./backend/
COPY --chown=node:node legal/ ./legal/
USER node
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000 DATA_DIR=/data PATH=/opt/venv/bin:$PATH
CMD ["node", "backend/server.mjs"]
