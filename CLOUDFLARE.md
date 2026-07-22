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
│   │  cached)         │  │  /api/register (Turnstile + │    │
│   │                  │  │     shared CF limits + KV)  │    │
│   │                  │  │  /api/lookup (30/min/IP +   │    │
│   │                  │  │     KV result cache)        │    │
│   │                  │  │  /c/:id/:name (HTMLRewriter)│    │
│   │                  │  │  /badge/*  (Supabase proxy) │    │
│   │                  │  │  /healthz                   │    │
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
| `POST /api/register` | Worker (`handleRegister`) → Supabase | Canonical registration endpoint for browser, CLI, MCP, and JS API. Browser path: validate JSON → require `cf-turnstile-response` → Turnstile siteverify (server-side hostname + `dmv_register` action check) → shared CF rate limiters → forward to Supabase. CLI/MCP path: validate JSON → require `machine_fingerprint` → shared CF rate limiters → DMV-local KV fingerprint cooldown → forward. Anti-abuse ordering matches `docs/plans/2026-04-08-cross-repo-hardening-handoff-prompt.md` §3, §4 — CAPTCHA always runs before shared counters |
| `GET /api/lookup?id=CERT-ID` | Worker (`handleCertificateLookup`) → Supabase | Implementation-ready, unpublished route. After Task 8 deploy SHA + live smoke evidence, this becomes the only public certificate lookup. Certificate IDs only; domain lookup is removed. `RL_CERT_LOOKUP` is a coarse 60/60 filter; `CERT_LOOKUP_LIMITER` is the exact 30/60 authority before the KV result cache. Returns only `certificate_id`, `status`, `valid_format`, `issued`, `agent_name`, and `certificate_url`; `issued` means a matching registration row exists, not that email verification or DNS allocation completed. |
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
| `worker/index.ts` | Worker entry — routes, L1/R2/container cache hierarchy, HTMLRewriter permalink middleware, public `/api/register` and `/api/lookup`, `/badge/*` Supabase proxy, cron prewarm |
| `worker/certificate-lookup.ts` | Worker-only public lookup policy: certificate-ID validation, coarse-filter/exact-DO ordering, result cache, upstream secret, typed envelope validation, minimal response shaping |
| `worker/certificate-lookup-rate-limiter.ts` | SQLite Durable Object for atomic fixed-minute 30/60 accounting per SHA-256 hashed IP; v2 migration |
| `worker/rate-limit-kv.ts` | DMV-local KV helper used only for the CLI/MCP registration fingerprint cooldown in `REGISTER_COOLDOWN_KV` |
| `worker/container-instance.ts` | **Generated** by `scripts/build-cf.mjs` — content-hash of container sources that doubles as the Durable Object instance ID |
| `wrangler.jsonc` | Static Assets + Container/R2 bindings, unchanged CardRenderer v1 plus CertificateLookupRateLimiter v2 migration, cron, registration bindings, coarse `RL_CERT_LOOKUP`, and result-cache KV |
| `tsconfig.json` | TypeScript config for the worker |
| `container/Dockerfile` | Node 20 Alpine + `@napi-rs/canvas` |
| `container/package.json` | Container runtime deps (Hono + `@napi-rs/canvas`) |
| `container/server.mjs` | HTTP wrapper around `renderCard()` — `/render?format=card|og` + `/healthz` |
| `container/src/card-renderer.js` | Canonical server renderer (Skia + `CardDNA`) |
| `container/src/qr-encode.js` | QR encoder, byte-identical to `js/qr-encode.js` |
| `container/fonts/PPSupplyMono-Regular.otf` | Auto-synced from `fonts/` by `scripts/build-cf.mjs` |
| `scripts/build-cf.mjs` | Font sync → QR drift check → `dist/` copy → container-hash write |
| `public/_headers` | Cache + security headers for Workers Static Assets. Sets global security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy), immutable cache headers for hashed assets (`/js/`, `/css/`, `/fonts/`, `/models/`), and `Link: rel=preload` headers on `/` and `/index.html` that Cloudflare auto-promotes to HTTP 103 Early Hints (requires zone-level Early Hints toggle enabled in the dashboard under Speed → Optimization → Content Optimization). CSP includes a `sha256-…` hash for the inline importmap in `index.html`, `'wasm-unsafe-eval'` for DRACOLoader, and `worker-src 'self' blob:` for the Draco decoder Worker. The same CSP is also emitted by `worker/index.ts` `handlePermalink` (as `PERMALINK_CSP` constant) because `run_worker_first: ["/c/*"]` bypasses Static Assets `_headers` on permalink routes — keep the two copies in sync manually. |
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

# Deploy the public boundary first (dmv-agentcommunity, dmv.agentcommunity.org)
pnpm cf:deploy

# Only after the Worker is live, deploy the secret-gated lookup upstream.
supabase functions deploy lookup-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt

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

The lookup changes are implementation-ready but unpublished as of 2026-07-22;
do not call this boundary live until Task 8 records the deployed SHA and smoke
evidence. Lookup rollout order is non-negotiable: configure the same generated
`DMV_PROXY_SECRET` on Cloudflare and Supabase, confirm the Worker bindings
`RL_CERT_LOOKUP`, `CERT_LOOKUP_LIMITER`, and `BADGE_CACHE_KV`, deploy the
Worker first, and only then deploy the secret-gated `lookup-agent` Edge
Function. This establishes `/api/lookup` before the former direct Edge surface
starts returning 403. Never record the secret in this repository or pass it to
clients.

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

- **Observability**: `observability.enabled = true` in `wrangler.jsonc`. Use
  `pnpm cf:tail` to stream live logs. Successful card responses carry
  `X-Cache: L1-HIT | L2-HIT | MISS` and `X-Cache-Key` for point-in-time
  debugging (304 revalidation responses reuse the originating tier's
  `X-Cache` value, so a conditional GET that matches L1 returns
  `HTTP/2 304` with `X-Cache: L1-HIT`). Rate-limited responses emit
  `X-RateLimit-Limit` + `X-RateLimit-Window`. Badge KV responses emit
  `X-Badge-Cache: KV-HIT | MISS`. For structured aggregate telemetry
  (cache hit ratio, render latency, KV hit ratio, rate-limit rejections),
  see the `dmv_worker_events` Analytics Engine dataset — queryable from
  the CF dashboard → Workers → dmv-agentcommunity → Analytics Engine. The
  analytics `tier` field uses the extended vocabulary (`L1-HIT`, `L2-HIT`,
  `MISS`, `304`, `KV-HIT`, `SUPABASE`, `405`, `429`, `validation`,
  `L1-EXCEPTION`, `container-render-failed`, `inflight-rejected`). Schema
  is documented at the `emitAnalytics()` helper in `worker/index.ts`.

- **Rate limiting**: three distinct surfaces, all via the Workers Rate
  Limiting API.

  **Render path** (`/api/card`, `/api/og`): guarded by `API_RATE_LIMITER`
  — 100 req/60s per `${ip}:${pathname}`, namespace `1001`. Runs BEFORE L1
  lookup so rejected requests don't eat cache-tier work; prewarm cron
  requests bypass via UA check (`dmv-cf-prewarm/1.0`). DMV-local namespace.

  **Register path** (`/api/register`): guarded by two SHARED bindings —
  `RL_OTP_EMAIL` (5 req/60s, namespace `4005`) and `RL_OTP_IP_EMAIL`
  (4 req/60s, namespace `4007`). Both `namespace_id` values are shared at
  the Cloudflare account level with `agentCommunity_PAGE`, so a single
  attacker spending email-keyed quota on PAGE has less of it available on
  DMV. Plus the DMV-local KV cooldown via `REGISTER_COOLDOWN_KV` for
  CLI/MCP machine fingerprints (`dmv:register:fingerprint:<sha256>`).
  CAPTCHA (Turnstile) runs BEFORE both shared counters on the browser
  path so invalid tokens cannot exhaust quota for real users. PAGE's
  `RL_AUTH` (4001) and `RL_OTP_IP` (4006) are intentionally NOT bound by
  DMV — plain-IP limits are too blunt for shared corporate networks and
  PAGE's live OTP path doesn't use `RL_AUTH` anyway.

  Cross-repo coupling drift points (rare, watch these): if PAGE renames a
  shared namespace_id, DMV silently drifts; if PAGE changes the
  email-normalization function, DMV's keys land in a different keyspace
  within the same namespace. Both are mitigated by keeping the relevant
  helpers in sync manually.

  Rate-limit rejections emit `register_attempt` Analytics Engine events
  with status blob `rate_limited` (matching PAGE's vocabulary). For a
  future zone-level upgrade to Pro+, layer a WAF Rate Limiting Rule on
  top — WAF runs earlier in the request pipeline and rejected requests
  don't count as Worker invocations.

  **Certificate lookup** (`/api/lookup`): `RL_CERT_LOOKUP` (namespace `1002`)
  is a permissive/eventually consistent 60/60 emergency filter, not exact
  accounting. One `CERT_LOOKUP_LIMITER` SQLite Durable Object per hashed IP
  then transactionally enforces exact 30/60 and supplies remaining/reset
  headers. A binding, fetch, or response failure fails closed before
  `BADGE_CACHE_KV` or upstream. Issued results use a 300-second KV TTL; only a
  typed HTTP 200 `not_found` envelope uses 60 seconds; non-200 and malformed
  upstream results are unavailable and uncached. All client responses use
  `Cache-Control: private, no-store`.

- **Turnstile**: `/api/register` browser path requires a valid Turnstile
  token (`cf-turnstile-response` field in the JSON body). The site key
  `0x4AAAAAAC2BwC5T9LSdndaK` is public and served via
  `<meta name="dmv-turnstile-site-key">` in `index.html`. The secret key
  is installed as the `TURNSTILE_SECRET_KEY` worker secret (encrypted,
  via Cloudflare dashboard — `wrangler secret put` is currently blocked
  on this worker by a version-mismatch guard, see
  `docs/plans/2026-04-08-handoff-prompt.md`). `verifyTurnstileToken` in
  `worker/index.ts` checks `success` AND `hostname` matches the request
  host AND `action` equals `dmv_register` — handoff prompt §5 requirement
  to prevent token reuse across properties or routes. CLI/MCP traffic
  bypasses Turnstile (headless clients can't solve it) and instead
  proves identity with `machine_fingerprint`.

- **Badge KV cache**: `/badge/*` is proxied through the Worker to the
  Supabase `badge` edge function with a 10-minute KV read-through cache
  (`BADGE_CACHE_KV`). Badge SVGs are deterministic per cert ID and stale
  content is cosmetic, so the 10-min window trades invisible freshness for
  ~10x fewer Supabase invocations during peak traffic. Only `GET` requests
  are cached, and only `upstream.ok` responses are written. Content-Type
  and HTTP status are stored in KV metadata (1024-byte cap). Misses emit
  `X-Badge-Cache: MISS`, hits emit `X-Badge-Cache: KV-HIT`. KV puts are
  tethered to `ctx.waitUntil()` so the runtime doesn't cancel them when
  the response returns.

- **Request coalescing**: concurrent first-misses on the same cache key
  are deduplicated per Worker isolate via an in-memory `inflightRenders`
  Map in `worker/index.ts`. Scope is single-isolate (not global): CF may
  run multiple isolates per PoP, but within each isolate a thundering herd
  of N requests collapses to one container call. Failure of the primary
  render fails all awaiters of that batch with 502 — we do NOT
  auto-re-render to avoid amplifying a thundering-herd against a broken
  container. The Map entry is cleaned up in a `finally` block so the next
  batch of requests starts fresh. Closes the "Cache API request coalescing
  is not yet implemented" known gap from earlier.

- **Healthz schema**: `/healthz` returns `{ worker: 'ok', container: { ... } }`
  where `container` is always an object. Happy path: `{ status: 'ok',
  renderer_version: <CARD_VERSION>, node: <process.version>, uptime_ms,
  boot_ms }`. Parse fallback (container returned non-JSON, e.g. old image
  mid-deploy): `{ status: 'ok', legacy: true }` — observed briefly during
  the 2026-04-07 deploy while the new container booted, then transitioned
  to the full payload. HTTP error: `{ status: 'error', http: <code> }`.
  Network error: `{ status: 'error', message: <string> }`. Probes can
  safely read `container.status` across all branches.

- **Worker tests**: certificate lookup policy and dispatch are covered by
  `tests/worker-certificate-lookup.test.ts`; atomic transaction and alarm
  behavior is covered by `tests/worker-certificate-lookup-rate-limiter.test.ts`.
  Rendering still uses
  `test-harness/render-comparison.mjs` plus manual smoke of `/healthz`,
  `/api/card`, `/api/og`, `/c/:id/:name`, and `/badge/*`.

## Known gaps (separate sprints)

- **Closing the direct-Supabase bypass** — *Closed 2026-05-29.* Replaced
  with the `DMV_PROXY_SECRET` shared-secret gate (constant-time compared,
  fail-closed if unset): the worker sets `x-dmv-proxy: <DMV_PROXY_SECRET>`
  and `register-agent` accepts only that secret. The retired public `v1`
  constant and any direct-to-Supabase call now return 403
  `direct_access_deprecated`. `/api/register` on the worker is the only
  path that reaches validation.

- **Certificate lookup exposure** — *Implementation ready; unresolved in
  production.* The planned public lookup is Worker
  `GET /api/lookup?id=CERT-ID`. The staged `lookup-agent` Edge change uses the
  same `DMV_PROXY_SECRET` gate, rejects direct calls before database client
  creation, removes domain queries, and returns typed HTTP 200
  `issued`/`not_found` envelopes. This gap is not closed until Task 8
  records a deployed SHA and live smoke evidence.

- **DMV-branded OTP email flow** — custom branding via
  `admin.generateLink()` + Resend direct send is future work. See
  `RESEND_DMV.md` in the `agentcommunity_page` repo.

- **R2 bucket name** — still `dmv-card-cache-test` for historical reasons.
  Functional; cosmetic rename deferred (requires bucket create + cutover +
  purge).
