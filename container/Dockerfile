# Card renderer container — runs the EXACT same @napi-rs/canvas (Skia) renderer
# that DMV uses on Vercel today, just in a CF Containers Docker image.
#
# Build context: this directory (container/). Files vendored here from the
# repo root via `cp` (api/card-renderer.js → container/src/card-renderer.js,
# etc.) so the build context is self-contained. To re-sync after upstream
# changes: rerun the cp commands or use the npm script.
#
# Wrangler builds this automatically when you `wrangler dev` / `wrangler deploy`.

FROM node:20-alpine

WORKDIR /app

# Install only what we need
COPY package.json pnpm-lock.yaml* ./
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate \
    && pnpm install --prod --no-frozen-lockfile

# Copy renderer source (vendored from ../api/ at branch creation time)
COPY src/card-renderer.js src/qr-encode.js ./src/

# Copy the font (vendored from ../fonts/)
COPY fonts/PPSupplyMono-Regular.otf ./fonts/

# Copy the HTTP server wrapper (lives at container/server.mjs on disk so the
# `./src/card-renderer.js` import resolves the same way locally as in the
# container — see I-8 in docs/superpowers/plans/2026-04-06-dmv-cf-fix-sprint.md)
COPY server.mjs ./

EXPOSE 8080
CMD ["node", "server.mjs"]
