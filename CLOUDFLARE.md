# DMV on Cloudflare

> `dmv.agentcommunity.org` runs on Cloudflare Workers Static Assets + a
> Cloudflare Container (Node 20 + `@napi-rs/canvas`) + R2 read-through cache.
> Worker `dmv-agentcommunity` on the Taqanu account. The Vercel-era stack
> (`api/`, `vercel.json`, `middleware.js`) has been removed; git history is
> the only reference for what it looked like.

## Why Cloudflare

Vercel bandwidth + serverless invocation cost was a problem at the traffic
profile DMV was being asked to absorb (a planned Brave new tab takeover
pointing millions of impressions at card permalinks). Cloudflare's $5/mo
Workers plan gives unlimited static-asset bandwidth, free egress from R2,
and generous container allowances, which adds up to roughly 10× cheaper at
the projected load. Visual fidelity is preserved because the container runs
the exact same `@napi-rs/canvas` (Skia) renderer the Vercel serverless
function used — the renderer source just moved from `api/card-renderer.js`
into `container/src/card-renderer.js` where it's now canonical.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (worker/index.ts)                        │
│                                                              │
│   ┌──────────────────┐  ┌─────────────────────────────┐    │
│   │ Static Assets    │  │ Dynamic routes              │    │
│   │ (free, edge-     │  │  /api/card  /api/og         │    │
│   │  cached)         │  │  /c/:id/:name (HTMLRewriter)│    │
│   │                  │  │  /badge/*  (Supabase proxy) │    │
│   └──────────────────┘  └──────────────┬──────────────┘    │
│        ▲                                │                    │
│        │ index.html, js/, css/,         ▼                    │
│        │ models/tv1.glb, audio/,    ┌────────┐               │
│        │ images/, fonts/, _headers  │ caches │ ── L1 HIT ─┐  │
│        │                            │.default│            │  │
│        │                            └───┬────┘            │  │
│        │                                │ MISS            │  │
│        │                                ▼                 │  │
│        │                            ┌────────┐            │  │
│        │                            │   R2   │ ── L2 ──┐  │  │
│        │                            │ cache  │         │  │  │
│        │                            └───┬────┘         │  │  │
│        │                                │ MISS         │  │  │
│        │                                ▼              │  │  │
│        │                         ┌──────────────┐      │  │  │
│        │                         │  Container   │      │  │  │
│        │                         │  (Node 20 +  │      │  │  │
│        │                         │   Skia card  │      │  │  │
│        │                         │   renderer)  │      │  │  │
│        │                         └──────┬───────┘      │  │  │
│        │                                │ PNG          │  │  │
│        │                                ├──────────────┘  │  │
│        │                                ├─────────────────┘  │
│        ▼                                ▼                    │
│   Workers Static Assets (dist/)    Response to caller       │
└─────────────────────────────────────────────────────────────┘
```

The Worker is the only entry point. `assets.run_worker_first` in
`wrangler.jsonc` makes dynamic routes (`/api/*`, `/c/*`, `/badge/*`,
`/healthz`) hit the Worker first; every other path falls through to
edge-cached static assets at zero invocation cost.

The cache hierarchy is **L1 `caches.default` → L2 R2 → L3 Container**. L1 is
in-region edge cache (fastest, free); R2 is the cross-region source of
truth so a cold PoP can warm L1 without re-rendering; the container is only
invoked when both miss. Every cached response carries an `X-Cache` header
(`L1-HIT` / `L2-HIT` / `MISS`) so `wrangler tail` shows exactly what's
being served.

## Routes

| Path | Handler | What it does |
|---|---|---|
| `/` and any non-matching path | Workers Static Assets | Serves `dist/index.html` (the SPA shell with the TV) |
| `/models/tv1.glb`, `/audio/*`, `/css/*`, `/js/*`, etc. | Workers Static Assets | Direct edge cache, free egress |
| `/api/card?name=&id=&type=` | Worker → L1 → R2 → Container | 880×630 PNG (raw card). Container only invoked on first miss per unique `(name, type, id)` |
| `/api/og?name=&id=&type=` | Worker → L1 → R2 → Container | Same Skia card composited on a 1200×630 canvas (perfect for OG/Twitter). Separate cache namespace from `/api/card` |
| `/c/:certId/:agentName` | Worker (HTMLRewriter or pass-through) | Crawler UA → fetch `index.html` via `env.ASSETS` and inject card-specific `<title>` + `og:*` + `twitter:*` meta tags via streaming HTMLRewriter. Human UA → serve `index.html` unchanged so the SPA renders the permalink card client-side |
| `/badge/*` | Worker (proxy) | Forwards to the Supabase badge edge function with header hygiene + path-traversal defense |
| `/healthz` | Worker | `{ worker, container }` health probe — pings the container too |

## Card rendering

`container/src/card-renderer.js` is the canonical Node port of the browser
renderer (`js/card-draw.js`). Same `CardDNA` hashing, same `CARD_VERSION`,
same 880×630 landscape layout. `@napi-rs/canvas` runs unchanged inside a
Node 20 Alpine container managed by Cloudflare. No WASM rebuild, no Satori
workaround, no separate OG path.

For OG/Twitter, `container/src/server.mjs` composites the 880×630 card
centered on a 1200×630 canvas with the matching dark background. The card's
internal layout is unchanged — social crawlers get a beautiful 1.91:1 image
from the same Skia renderer.

### Drift invariants enforced at build time

`scripts/build-cf.mjs` runs at the start of every `cf:dev` and `cf:deploy`
and hard-fails on:

1. **QR encoder drift** — `js/qr-encode.js` (served to the browser via
   Workers Static Assets) must be byte-identical to
   `container/src/qr-encode.js` (loaded by the container renderer).
   Divergence would mean the browser preview and the server PNG encode
   subtly different QR matrices for the same permalink.
2. **Font drift** — `fonts/PPSupplyMono-Regular.otf` (browser) is copied
   into `container/fonts/PPSupplyMono-Regular.otf` so the Docker build
   context picks up any font swap automatically.

`js/card-draw.js` ↔ `container/src/card-renderer.js` alignment (CardDNA,
layout, rarity logic) is **not** checked mechanically — they have different
runtime targets (browser DOM vs Node + Skia) so a byte diff doesn't make
sense. When the browser renderer changes, port the change by hand and
eyeball the bake-off output (`pnpm cf:test:render` — see below).

## Files

| Path | Purpose |
|---|---|
| `worker/index.ts` | Worker entry — routes, L1/R2/container cache hierarchy, HTMLRewriter permalink middleware, `/badge/*` Supabase proxy, cron prewarm |
| `worker/container-instance.ts` | **Generated** by `scripts/build-cf.mjs` — content-hash of container sources that doubles as the Durable Object instance ID |
| `wrangler.jsonc` | Static Assets + Container binding, R2 binding, DO migration, cron trigger, `PREWARM_ORIGIN` |
| `tsconfig.json` | TypeScript config for the worker |
| `container/Dockerfile` | Node 20 Alpine + `@napi-rs/canvas` |
| `container/package.json` | Container runtime deps (Hono + `@napi-rs/canvas`) |
| `container/server.mjs` | HTTP wrapper around `renderCard()` — `/render?format=card|og` + `/healthz` |
| `container/src/card-renderer.js` | Canonical server renderer (Skia + `CardDNA`) |
| `container/src/qr-encode.js` | QR encoder, byte-identical to `js/qr-encode.js` |
| `container/fonts/PPSupplyMono-Regular.otf` | Auto-synced from `fonts/` by `scripts/build-cf.mjs` |
| `scripts/build-cf.mjs` | Font sync → QR drift check → `dist/` copy → container-hash write |
| `public/_headers` | Cache + security headers for Workers Static Assets |
| `test-harness/test-cases.json` | 11 representative cards covering rarity/palette/account-type permutations |
| `test-harness/render-comparison.mjs` | Compares local `wrangler dev` output against the deployed worker for eyeball visual regression |

## Development

```bash
# Prereqs: Docker Desktop running, pnpm 10.12.1, Node 20+

# Install
pnpm install

# One-time R2 bucket setup (already done in the Taqanu account — only needed
# if you're bootstrapping a fresh account or a new environment)
pnpm wrangler login
pnpm wrangler r2 bucket create dmv-card-cache-test
pnpm wrangler r2 bucket create dmv-card-cache-test-preview

# Local dev — runs build-cf.mjs then wrangler dev on http://localhost:8787
pnpm cf:dev

# Deploy to production (dmv-agentcommunity worker, dmv.agentcommunity.org)
pnpm cf:deploy

# Visual fidelity spot-check: local vs deployed
CF_LOCAL_URL=http://localhost:8787 pnpm cf:test:render
open test-harness/output/index.html
```

`pnpm cf:deploy` chains:

1. `pnpm cf:build` — syncs the font into `container/fonts/`, hard-fails on
   QR encoder drift, writes `worker/container-instance.ts` with the fresh
   container content-hash, and copies the production-facing static files
   into `dist/`.
2. `wrangler deploy` — builds the container image, pushes it to the CF
   registry, and rolls out the Worker.

## Operational notes

- **Container sizing**: `max_instances: 1`, `instance_type` defaults to
  `lite` (1/4 vCPU, 256 MiB — free on the $5 Workers plan), `sleepAfter:
  10m`, singleton routing via
  `getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID)`. Right-sized for
  DMV's actual load — the main `agentcommunity_page` worker is the
  25M-impression hot path, not DMV. If DMV ever needs a pool, see git
  history around commit `fafef20` for the version-namespaced pool
  implementation.

- **Cache invalidation**: `CONTAINER_INSTANCE_ID` is the sha256 of every
  container source file. Any change to the Dockerfile, `server.mjs`,
  `src/*`, or the font changes the hash, which forces the Durable Object to
  spawn a fresh container instance on the next request AND namespaces the
  R2 + L1 keys under the new version. Old cache entries become orphaned
  (R2 is cheap, they sit until purge).

- **Cron prewarm**: hourly cron hits the hot OG + card URLs from inside the
  Worker so the first Brave hit in any cold PoP is an L1-HIT. Paths live in
  `PREWARM_PATHS` in `worker/index.ts`. CF rotates cron execution across
  PoPs so over the course of a day the prewarm reaches a reasonable spread
  of serving regions. `PREWARM_ORIGIN` lives in `wrangler.jsonc vars` and
  points at `https://dmv.agentcommunity.org`.

- **Observability**: `observability.enabled = true` in `wrangler.jsonc`.
  Use `pnpm cf:tail` to stream live logs. Every card response carries
  `X-Cache: L1-HIT | L2-HIT | MISS` and `X-Cache-Key`, which makes cache
  health visible at a glance.

- **No automated worker tests by design**. The worker code is small enough
  that adding miniflare/vitest scaffolding would cost more than it returns.
  Test plan is `test-harness/render-comparison.mjs` (eyeball bake-off) plus
  manual smoke of `/healthz`, `/api/card`, `/api/og`, `/c/:id/:name`
  (crawler UA + human UA), and `/badge/*`. Revisit if the worker grows.

## Known gaps (separate sprints)

- **Cache API request coalescing** is not yet implemented. Under a
  thundering herd of unique cards (brand-new viral card hit at launch),
  concurrent first-misses can each independently call the container and
  eat tail latency. Flagged as Brave-takeover prep in the post-review fix
  sprint.

- **API hardening** — `js/supabase.js` (browser) and `packages/dmv-agent/`
  (CLI + MCP) still POST directly to the Supabase `register-agent` edge
  function. Only `/badge/*` is worker-proxied so far. Layered hardening
  plan (Worker proxy + Workers Rate Limiting + Turnstile + closing the
  Supabase bypass) lives in `DMV_HARDENING.md` in the `agentcommunity_page`
  repo.

- **DMV-branded OTP email flow** — custom branding via
  `admin.generateLink()` + Resend direct send is future work. See
  `RESEND_DMV.md` in the `agentcommunity_page` repo.

- **R2 bucket name** — still `dmv-card-cache-test` for historical reasons.
  Functional; cosmetic rename deferred (requires bucket create + cutover +
  purge).
