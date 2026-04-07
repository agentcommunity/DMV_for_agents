# DMV on Cloudflare

> Branch: `cloudflare-migration`. Active migration of `dmv.agentcommunity.org`
> from Vercel to Cloudflare Workers + Containers + R2 + Workers Static Assets.
>
> Original DMV files in `api/`, `js/`, `index.html`, `vercel.json`,
> `middleware.js` are **untouched** on `main` — Vercel production keeps
> working until DNS cutover.
>
> Tracking and broader migration plan live in
> [`agentcommunity_PAGE/docs/admin/CLOUDFLARE-MIGRATION-PLAN.md`](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/admin/CLOUDFLARE-MIGRATION-PLAN.md).

## Why

Vercel bandwidth + serverless invocation costs become a problem at scale
(specifically: a planned Brave new tab takeover that will hit DMV with
millions of impressions). Cloudflare's $5/mo Workers plan includes
unlimited bandwidth, free static asset serving, generous container
allowances, and zero-egress R2 — making it ~10× cheaper at the projected
load. Visual fidelity is preserved via Cloudflare Containers running the
exact same `@napi-rs/canvas` (Skia) renderer DMV uses today.

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
│        │ images/, fonts/, _headers  │   R2   │ ── HIT ──┐    │
│        │                            │ cache  │          │    │
│        │                            └───┬────┘          │    │
│        │                                │ MISS          │    │
│        │                                ▼               │    │
│        │                         ┌──────────────┐       │    │
│        │                         │  Container   │       │    │
│        │                         │  (Node 20 +  │       │    │
│        │                         │   Skia card  │       │    │
│        │                         │   renderer)  │       │    │
│        │                         └──────┬───────┘       │    │
│        │                                │ PNG           │    │
│        │                                ├───────────────┘    │
│        │                                │                    │
│        ▼                                ▼                    │
│   Workers Static Assets (dist/)    Response to caller       │
└─────────────────────────────────────────────────────────────┘
```

The Worker is the only entry point. `assets.run_worker_first` in
`wrangler.jsonc` ensures dynamic routes (`/api/*`, `/c/*`, `/badge/*`,
`/healthz`) hit the Worker first; everything else is served directly from
edge-cached static assets at zero invocation cost.

## Routes

| Path | Handler | What it does |
|---|---|---|
| `/` and any non-matching path | Workers Static Assets | Serves `dist/index.html` (the SPA shell with the TV) |
| `/models/tv1.glb`, `/audio/*`, `/css/*`, `/js/*`, etc. | Workers Static Assets | Direct edge cache, free egress |
| `/api/card?name=&id=&type=` | Worker → R2 → Container | 880×630 PNG (raw card). R2 read-through cache; container only invoked on first miss per unique card |
| `/api/og?name=&id=&type=` | Worker → R2 → Container | 1200×630 PNG (the same Skia card composited centered on a 1200×630 canvas with matching dark background — perfect for OG/Twitter). R2-cached separately |
| `/c/:certId/:agentName` | Worker (HTMLRewriter or pass-through) | Crawler UA → fetch `index.html` via `env.ASSETS`, inject card-specific `<title>`, `og:*`, `twitter:*` meta tags via streaming HTMLRewriter. Human UA → serve `index.html` unchanged so the SPA renders the permalink card client-side |
| `/badge/*` | Worker (proxy) | Forwards to the existing Supabase Edge Function (unchanged) |
| `/healthz` | Worker | `{worker, container}` health probe — pings the container too |

## Card rendering

The card renderer (`api/card-renderer.js`) is the **exact same code** that
runs on Vercel today, vendored into `container/src/` at branch creation.
`@napi-rs/canvas` (Skia native binary) runs unchanged inside a Node 20
Alpine container managed by Cloudflare. There is no port to a different
canvas implementation, no WASM rebuild, no Satori workaround.

A bake-off across 11 representative cards (rarity/palette/holo/account-type
permutations) confirmed **byte-identical PNG output** between this stack
and current Vercel production — same Skia binary + same code + same fonts
→ same MD5. See `test-harness/render-comparison.mjs`.

For OG/Twitter, the same renderer produces an 880×630 card which is then
composited centered onto a 1200×630 canvas (matching dark background)
inside the container — see `container/src/server.mjs`. This gives social
crawlers a beautiful 1.91:1 image with no separate Satori-based fallback.

## Files

| Path | Purpose |
|---|---|
| `worker/index.ts` | Worker entry — routes, R2 cache, HTMLRewriter middleware, Supabase badge proxy |
| `wrangler.jsonc` | Container binding, R2 binding, Workers Static Assets binding, DO migration |
| `tsconfig.json` | TypeScript config for the worker |
| `container/Dockerfile` | Node 20 Alpine + `@napi-rs/canvas` |
| `container/package.json` | Container deps |
| `container/src/server.mjs` | Hono HTTP wrapper around `renderCard()`, format=card and format=og support |
| `container/src/card-renderer.js` | Vendored from `api/card-renderer.js` (refresh via `pnpm cf:vendor`) |
| `container/src/qr-encode.js` | Vendored from `api/qr-encode.js` |
| `container/fonts/PPSupplyMono-Regular.otf` | Vendored from `fonts/` |
| `scripts/build-cf.mjs` | Build script — copies production-facing static files into `dist/` for Workers Static Assets |
| `public/_headers` | Cache + security headers ported from `vercel.json` |
| `test-harness/test-cases.json` | 11 representative cards covering rarity/palette/account-type permutations |
| `test-harness/render-comparison.mjs` | Compares the deployed CF Worker output against current Vercel production |

The Vercel-era files (`api/`, `vercel.json`, `middleware.js`) remain in
place so `main` keeps deploying to Vercel until DNS cutover.

## Development

```bash
# Prereqs: Docker Desktop running, pnpm 10.12.1, Node 20+

# Install
pnpm install

# One-time R2 bucket setup
pnpm wrangler login
pnpm wrangler r2 bucket create dmv-card-cache-test
pnpm wrangler r2 bucket create dmv-card-cache-test-preview

# Local dev — builds container, runs worker on http://localhost:8787
pnpm cf:dev

# Deploy to workers.dev test URL
pnpm cf:deploy

# Visual fidelity check vs Vercel production (run after cf:dev or cf:deploy)
CF_LOCAL_URL=https://dmv-card-test.<account>.workers.dev pnpm cf:test:render
open test-harness/output/index.html
```

The `cf:deploy` script chains:

1. `cf:vendor` — copies `api/card-renderer.js`, `api/qr-encode.js`, `fonts/PPSupplyMono-Regular.otf` into `container/`
2. `cf:build` — copies production static files into `dist/`
3. `wrangler deploy` — builds container image, pushes to CF registry, deploys worker

## What this is NOT (yet)

- Not connected to `dmv.agentcommunity.org` DNS — that's the final cutover step (coordinated with main site Phase 3)
- Container config: `max_instances: 1`, `instance_type` defaults to `lite` (1/4 vCPU, 256 MiB — free on the $5 Workers plan), `sleepAfter: 10m`, singleton routing via `getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID)`. This is right-sized for DMV's expected load (a few thousand requests over the Brave window) — the main site (`agentcommunity_page`) is the 25M-impression hot path, not DMV. An earlier commit bumped DMV to a 5-slot `basic` pool in anticipation of the takeover; reverted once the traffic picture became clearer. Note on naming: the actual default instance type is `lite`, not `dev` as a review run once claimed — verified from the CF Containers docs and the wrangler deploy diff. Valid types are `lite`, `basic`, `standard-1` through `standard-4`.
- Email and Supabase Edge Functions (`register-agent`, `lookup-agent`, `badge`) are **not migrated** — they stay on Supabase, which is the right place for them
- Browser-side `js/supabase.js` and the `dmv-agent` MCP package still POST directly to the Supabase function URL — the Worker only proxies `/badge/*` so far. Hardening plan to fix this lives in [DMV_HARDENING.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/DMV_HARDENING.md) (Phase A: Worker proxy + edge rate limits, Phase B: Turnstile on browser path + MCP migration, Phase C: close the bypass via `X-Forwarded-By` enforcement)
- Custom OTP email flow for DMV (different branding from main site) is a separate piece of future work — see [RESEND_DMV.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/RESEND_DMV.md)
- **No automated worker tests by design.** The test plan is `test-harness/render-comparison.mjs` (the bake-off — 11 cards byte-compared against current Vercel production) plus manual smoke testing of `/healthz`, `/api/card`, `/api/og`, `/c/:id/:name` (crawler + human UA), and `/badge/*`. Worker code is small enough that adding miniflare/vitest scaffolding would cost more than it returns. Re-evaluate when the worker grows or after the Brave takeover lands real traffic.
- Cache API request coalescing in front of R2 is **not yet implemented**. With `max_instances: 1` and the current test traffic this isn't a problem. **It is a Brave-takeover blocker** — a thundering-herd of unique cards on launch day would each independently miss R2 and call the container, eating tail latency. Tracked as I-6 in the post-review fix sprint, deferred to a separate Brave-takeover-prep sprint.

## Related future work

The full backlog of post-migration items lives in the main `agentcommunity_PAGE` repo:

- **[DMV_HARDENING.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/DMV_HARDENING.md)** — layered API hardening plan (Worker proxy + Workers Rate Limiting binding + Turnstile + closing the Supabase bypass)
- **[RESEND_DMV.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/RESEND_DMV.md)** — DMV-branded OTP email flow via `admin.generateLink()` + Resend direct send
- **[CLOUDFLARE-MIGRATION-PLAN.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/admin/CLOUDFLARE-MIGRATION-PLAN.md)** — broader migration plan (DMV is Phase 6a)
- **[CLOUDFLARE-MIGRATION-HANDOFF.md](https://github.com/agentcommunity/agentcommunity_PAGE/blob/main/docs/admin/CLOUDFLARE-MIGRATION-HANDOFF.md)** — current migration state and decisions

## Status

Bake-off complete (visual fidelity verified, 11/11 cards byte-identical to
Vercel). Phase 6a mechanically complete on this branch. Awaiting browser
acceptance test + DNS cutover.
