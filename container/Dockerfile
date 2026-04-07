# Card renderer container — Node 20 + @napi-rs/canvas (Skia) running behind
# the dmv-agentcommunity Worker's /api/card and /api/og routes.
#
# Build context: this directory (container/). Everything the renderer needs
# is committed here:
#
#   src/card-renderer.js   — canonical server renderer (drift-checked against
#                            js/card-draw.js conceptually, and against
#                            js/qr-encode.js for QR output on every build)
#   src/qr-encode.js       — QR encoder, byte-identical to js/qr-encode.js;
#                            scripts/build-cf.mjs hard-fails on drift
#   fonts/PPSupply...otf   — font, auto-synced from repo-root fonts/ by
#                            scripts/build-cf.mjs at the start of every
#                            cf:dev / cf:deploy run
#   server.mjs             — HTTP wrapper around renderCard() that exposes
#                            /render?format=card|og and /healthz
#
# Wrangler builds this automatically when you `wrangler dev` / `wrangler deploy`.

FROM node:20-alpine

WORKDIR /app

# Install only what we need
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate \
    && pnpm install --prod --no-frozen-lockfile

# Canonical renderer + QR encoder
COPY src/card-renderer.js src/qr-encode.js ./src/

# Font — kept in sync with repo-root fonts/ by scripts/build-cf.mjs
COPY fonts/PPSupplyMono-Regular.otf ./fonts/

# HTTP server wrapper — lives at container/server.mjs on disk so the
# `./src/card-renderer.js` import resolves the same way locally as in the
# container.
COPY server.mjs ./

EXPOSE 8080
CMD ["node", "server.mjs"]
