FROM node:24-bookworm-slim
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/playwright
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.163.0 wrangler@4.127.1 playwright@1.62.1 \
    && playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY runtime/container ./runtime/container
COPY runtime/repositories ./runtime/repositories
COPY src/repository-adapters ./src/repository-adapters
# No credentials or task inputs are baked into this image. Each execution gets
# a separate cloud container, a prepared workspace, and a temporary Codex login.
USER node
EXPOSE 8080
CMD ["node", "runtime/container/server.mjs"]
