# cf-test-containers — DMV Card Renderer Bake-off

> Test branch (NOT for production). Verifies that the existing
> `@napi-rs/canvas` (Skia) card renderer runs unchanged inside a Cloudflare
> Container, fronted by a Worker with R2 read-through caching, and produces
> visually identical output to the current Vercel deployment.
>
> If this test passes, this is the path we adopt for **Phase 6a** of the
> Cloudflare migration. The full plan lives in
> `agentcommunity_PAGE/docs/admin/CLOUDFLARE-MIGRATION-PLAN.md`.

## Why this branch exists

DMV's `/api/card` route renders a holographic 880×630 PNG via
`@napi-rs/canvas` (Skia native binary). It cannot run in a Cloudflare Worker
directly because Workers can't load native Node modules. We need a different
runtime for the renderer while preserving 100% visual fidelity — the card
appearance is a feature, not an implementation detail.

Three options were considered:

| Option | Same code? | Maintenance | Status |
|---|---|---|---|
| A. Pre-generate to R2 at registration time | depends on B/C | low | layered on top of B or C |
| B. Port renderer to CanvasKit-WASM in Worker | ~95% | low | possible follow-up optimization |
| **C. Run unchanged in Cloudflare Containers** | **100%** | **zero (CF managed)** | **this branch** |

Option C wins because:
1. **Visual fidelity is guaranteed** — the same Skia binary, same code, same fonts
2. **Zero hardening burden** — Cloudflare manages the host, no VPS to patch
3. **Fits in the existing $5/mo Workers plan** — 25 GB-hours RAM + 375 vCPU min included
4. **Scale-to-zero** — container sleeps when idle, only pays for active seconds
5. **R2 read-through cache in front** — first render is the only one that pays the
   ~200ms cold start; every subsequent fetch is a static R2 hit (free, fast)

## Architecture

```
[caller — DMV permalink crawler, main site /members, anyone]
    │
    ▼
[Worker: worker/index.ts — receives /api/card]
    │
    ├─► R2.get(cards/{type}/{name}-{id}.png) ──── HIT ───► return PNG  (free, ~10ms global)
    │
    └─── MISS ───► env.CARD_RENDERER.fetch()
                          │
                          ▼
                  [Container: Node 20 + @napi-rs/canvas + PPSupplyMono]
                  [container/Dockerfile + container/src/server.mjs]
                          │
                          ▼
                  PNG buffer (880×630, deterministic from name+type)
                          │
                          ▼
                  R2.put(cards/...) — written for next time
                          │
                          ▼
                  return PNG to caller
```

The renderer code (`api/card-renderer.js` + `api/qr-encode.js` + `fonts/`) is
**unchanged** from main. The Dockerfile copies it into the container image
verbatim — same Skia, same fonts, same output.

## Files

| Path | Purpose |
|---|---|
| `worker/index.ts` | Worker entry — handles `/api/card`, R2 cache, container invocation |
| `container/Dockerfile` | Node 20 Alpine + `@napi-rs/canvas` + the renderer |
| `container/src/server.mjs` | Hono HTTP wrapper around `renderCard()` |
| `container/package.json` | Container deps (separate from project root) |
| `wrangler.jsonc` | CF config: container binding, R2 binding, DO migrations |
| `tsconfig.json` | TS config for the worker |
| `test-harness/test-cases.json` | 11 representative cards covering rarity/palette/account-type permutations |
| `test-harness/render-comparison.mjs` | Fetches the same cards from production Vercel + local CF Worker, generates side-by-side HTML |
| `package.json` | Adds `cf:*` scripts alongside the existing DMV ones |

The original DMV files (`api/`, `js/`, `index.html`, `vercel.json`,
`middleware.js`, etc.) are **untouched** — production Vercel deployment
still works on `main`.

## Running the test

### Prerequisites

- Docker Desktop installed and running (Cloudflare wrangler dev launches the
  container locally via Docker)
- pnpm 10.12.1 (matches the rest of the project)
- Cloudflare account logged in: `pnpm wrangler login`

### Steps

```bash
# 1. Install deps
pnpm install

# 2. Create the R2 buckets (one-time)
pnpm wrangler r2 bucket create dmv-card-cache-test
pnpm wrangler r2 bucket create dmv-card-cache-test-preview

# 3. Start the worker + container locally
pnpm cf:dev
# → wrangler builds container/Dockerfile, starts the container,
#   exposes worker on http://localhost:8787

# 4. Smoke test
curl -o /tmp/alice.png 'http://localhost:8787/api/card?name=alice&type=individual'
open /tmp/alice.png

# 5. Health check (verifies worker → container connectivity)
curl http://localhost:8787/healthz
# → {"worker":"ok","container":"ok"}

# 6. Render the bake-off comparison (in another terminal, leave cf:dev running)
pnpm cf:test:render
open test-harness/output/index.html
```

### Pass criteria

For each of the 11 test cards in `test-cases.json`:

1. **Local CF Container output is byte-identical (or visually indistinguishable) to Vercel production output.** This is the headline test. Same Skia + same code + same fonts → should be identical.
2. **First request: cache MISS, container cold start in <500ms.**
3. **Second request to the same card: cache HIT, ~10–50ms response time.**
4. **No errors in `wrangler tail` or container logs.**

If all four pass → declare Path 1 verified, update tracking docs, proceed to
Phase 6a scaffolding (port middleware + `/api/og`, set up production
deployment).

If visual diff is detected (font rendering, antialiasing, gradient banding,
etc.) → diagnose. Most likely culprits are font path resolution or
@napi-rs/canvas version mismatch between local Vercel and the container.

## What this branch is NOT

- **Not a deployable production worker.** No custom domain, no static assets
  binding, no security headers, no rate limiting. Test infrastructure only.
- **Not a port of `/api/og`.** That route currently uses `@vercel/og`
  (Satori-based) and is a separate migration step. Worker stub has TODO.
- **Not a port of `middleware.js`.** Crawler OG injection lives in the same
  worker eventually but is out of scope for the bake-off.
- **Does not change the Supabase backend.** `register-agent`, `lookup-agent`,
  `badge` edge functions stay exactly as they are.

## Tracking

Status updates and decisions land in
`agentcommunity_PAGE/docs/admin/CLOUDFLARE-MIGRATION-PLAN.md` (Phase 6a) and
`CLOUDFLARE-MIGRATION-HANDOFF.md`. **Do not** update those files until the
bake-off settles the renderer question — they stay frozen on the current plan
until we have data.
