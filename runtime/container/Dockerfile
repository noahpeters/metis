FROM node:24-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git python3 ripgrep \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global @openai/codex@0.163.0
WORKDIR /app
COPY runtime/container/execute.mjs runtime/container/server.mjs runtime/container/verify-solution.mjs ./
# No credentials or task inputs are baked into this image. Each execution gets
# a separate cloud container, an empty workspace, and a temporary Codex login.
USER node
EXPOSE 8080
CMD ["node", "server.mjs"]
