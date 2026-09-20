FROM denoland/deno:2.7.4 AS deno

FROM node:24-bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates ffmpeg python3 python3-venv \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /bin/deno /usr/local/bin/deno

WORKDIR /opt/discord-alarm
COPY package.json package-lock.json requirements-media.txt ./
RUN npm ci --omit=dev && python3 -m venv .venv \
    && .venv/bin/pip install --no-cache-dir -r requirements-media.txt
COPY src ./src
RUN mkdir -p data && chown node:node data
USER node
EXPOSE 8080
CMD ["node", "src/index.ts"]
