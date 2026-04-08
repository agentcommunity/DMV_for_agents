# DMV — Architecture Overview

The Department of Machine Verification is the identity registration system for the [.agent community](https://agentcommunity.org). It lets agents and their operators pre-register `.agent` domain names and receive verifiable, content-addressed certificate IDs — through a retro CRT terminal on the web, a CLI, an MCP server, or a Claude Code skill.

## System Map

```
 ┌──────────────────────────────────────────────────────────────────────┐
 │                         USER'S MACHINE                              │
 │                                                                      │
 │  ┌──────────────────────────────────────────────┐                   │
 │  │  Web UI — dmv.agentcommunity.org              │                   │
 │  │                                                │                   │
 │  │  index.html  ─┬─► app.js                      │                   │
 │  │               │     ├── TV.js ── CRTTerminal   │  CRT form flow   │
 │  │               │     ├── HoloCard.js            │  Holographic card │
 │  │               │     └── AboutPoster.js         │                   │
 │  │               │                                │                   │
 │  │               │  Invisible Turnstile widget    │                   │
 │  │               │  (action=dmv_register)         │                   │
 │  │               │                                │                   │
 │  │               └─► supabase.js ── fetch() ──────┼──┐               │
 │  │                   POST /api/register            │  │               │
 │  │                   (same-origin, no Supabase URL)│  │               │
 │  │                                                │  │               │
 │  │  Permalink: /c/CERT-ID/agent-name               │  │               │
 │  │  Overlay: "Get Yours" + "Share on X"           │  │               │
 │  └──────────────────────────────────────────────┘  │               │
 │                                                      │               │
 │  ┌──────────────────────────────────────────────┐  │               │
 │  │  NPM Package — dmv-agent (alias for             │  │               │
 │  │    @agentcommunity/dmv-agent)                   │  │               │
 │  │                                                │  │               │
 │  │  CLI:  bunx dmv-agent                          │  │               │
 │  │    register   → interactive terminal flow      │  │               │
 │  │    verify     → offline check digit validation │  │               │
 │  │    (default)  → start MCP server               │  │               │
 │  │                                                │  │               │
 │  │  MCP Server (stdio):                           │  │               │
 │  │    register_agent    → POST /api/register ─────┼──┤               │
 │  │    verify_certificate → offline, no network    │  │               │
 │  │                                                │  │               │
 │  │  JS API:                                       │  │               │
 │  │    registerAgent()   → POST /api/register ─────┼──┤               │
 │  │    verifyCertificateId() → offline             │  │               │
 │  │                                                │  │               │
 │  │  Claude Code Skill:                            │  │               │
 │  │    /dmv → runs CLI via bunx                    │  │               │
 │  │                                                │  │               │
 │  │  ⚠ ZERO SECRETS — no DB credentials            │  │               │
 │  └──────────────────────────────────────────────┘  │               │
 └─────────────────────────────────────────────────────┼───────────────┘
                                                        │
                                        fetch() POST/GET│
                                                        │
 ┌──────────────────────────────────────────────────────┼───────────────┐
 │              CLOUDFLARE — dmv.agentcommunity.org      │               │
 │                                                      │               │
 │  ┌───────────────────────────────────────────────┐  │               │
 │  │  Worker — worker/index.ts handleRegister       │◄─┘               │
 │  │                                                │                   │
 │  │  POST /api/register                            │                   │
 │  │    Browser path (signup_source: 'ui'):         │                   │
 │  │    1. validate JSON shape                      │                   │
 │  │    2. require cf-turnstile-response token      │                   │
 │  │    3. Turnstile siteverify                     │                   │
 │  │       → check success + hostname + action      │                   │
 │  │    4. shared CF rate limiters                  │                   │
 │  │       → RL_OTP_EMAIL    (5/60s, ns 4005)       │                   │
 │  │       → RL_OTP_IP_EMAIL (4/60s, ns 4007)       │                   │
 │  │       (both ns IDs SHARED with PAGE)           │                   │
 │  │    5. forward to Supabase ─────────────────────┼──┐               │
 │  │                                                │  │               │
 │  │    CLI/MCP path (signup_source: 'cli'/'mcp'):  │  │               │
 │  │    1. validate JSON shape                      │  │               │
 │  │    2. require machine_fingerprint              │  │               │
 │  │    3. shared CF rate limiters (same as above)  │  │               │
 │  │    4. DMV-local KV fingerprint cooldown        │  │               │
 │  │       → REGISTER_COOLDOWN_KV                   │  │               │
 │  │       (NOT shared with PAGE)                   │  │               │
 │  │    5. forward to Supabase ─────────────────────┼──┤               │
 │  │                                                │  │               │
 │  │  CAPTCHA always before counters — invalid       │  │               │
 │  │  tokens cannot exhaust quota for real users.   │  │               │
 │  │                                                │  │               │
 │  │  🔑 Holds TURNSTILE_SECRET_KEY                 │  │               │
 │  └────────────────────────────────────────────────┘  │               │
 └────────────────────────────────────────────────────────┼───────────────┘
                                                          │
                                              fetch() POST│
                                                          │
 ┌────────────────────────────────────────────────────────┼───────────────┐
 │                      SUPABASE CLOUD                    │               │
 │                                                        │               │
 │  ┌─────────────────────────────────────────────────┐  │               │
 │  │  Edge Functions (Deno)                           │◄─┘               │
 │  │                                                  │                   │
 │  │  POST /register-agent (worker upstream)          │                   │
 │  │    → validate input + registration_type          │                   │
 │  │    → lifetime cap: 3/email or 10 if endorsed      │                   │
 │  │    → generate certificate ID (FNV-1a + Luhn)     │                   │
 │  │    → INSERT into registrations (status:           │                   │
 │  │      provisional_dmv, user_id: NULL)              │                   │
 │  │    → return cert ID + permalink + badge URLs     │                   │
 │  │    → DB trigger fires → agentcommunity.org       │                   │
 │  │      creates auth user + sends magic link +      │                   │
 │  │      certificate email (async via pg_net)        │                   │
 │  │    NOTE: Upstash rate limiting REMOVED — the      │                   │
 │  │    worker owns anti-abuse now.                    │                   │
 │  │                                                  │                   │
 │  │  GET /lookup-agent?id=CERT-ID                    │                   │
 │  │    → single result (cert IDs are unique)         │                   │
 │  │  GET /lookup-agent?domain=name                   │                   │
 │  │    → array (multiple pre-registrations)          │                   │
 │  │                                                  │                   │
 │  │  GET /badge?id=CERT-ID&style=flat|card           │                   │
 │  │    → SVG badge (cert ID only, domain lookup     │                   │
 │  │      deprecated — ambiguous with multi-prereg)   │                   │
 │  │                                                  │                   │
 │  │  🔑 Holds SUPABASE_SERVICE_ROLE_KEY              │                   │
 │  └──────────────────────┬──────────────────────────┘                   │
 │                          │                                            │
 │  ┌──────────────────────▼────────────────────────┐                   │
 │  │  PostgreSQL — registrations table              │                   │
 │  │                                                │                   │
 │  │  registration_type  TEXT (INDIVIDUAL/ORG/AGENT)│                   │
 │  │  domain_requested   TEXT (not unique — pre-reg)│                   │
 │  │  certificate_id     TEXT (UNIQUE partial index) │                   │
 │  │  email              TEXT                       │                   │
 │  │  signup_source      TEXT (ui/cli/mcp/api)      │                   │
 │  │  status             TEXT (provisional_dmv)     │                   │
 │  │  user_id            UUID (nullable — set by    │                   │
 │  │                      trigger, not by DMV)      │                   │
 │  │  full_name          TEXT (nullable)            │                   │
 │  │  organization_name  TEXT (nullable)            │                   │
 │  │  metadata           JSONB                      │                   │
 │  │  created_at         TIMESTAMPTZ                │                   │
 │  │                                                │                   │
 │  │  RLS: deny all for anon (service key bypasses) │                   │
 │  │                                                │                   │
 │  │  Trigger: on_dmv_registration (AFTER INSERT    │                   │
 │  │    WHERE certificate_id IS NOT NULL)           │                   │
 │  │    → calls agentcommunity.org edge function    │                   │
 │  │    → creates/finds auth user, sends emails     │                   │
 │  └────────────────────────────────────────────────┘                   │
 └──────────────────────────────────────────────────────────────────────┘
```

## Five ways to pre-register

| Method | How | Who it's for | Registration type |
|--------|-----|-------------|-------------------|
| **Web terminal** | Visit dmv.agentcommunity.org, complete CRT form | Humans & organizations | Individual / Organization |
| **CLI** | `bunx dmv-agent register` | AI agents (operator required) | Agent |
| **MCP tool** | Claude calls `register_agent` tool via stdio | Autonomous agents | Agent |
| **JS API** | `import { registerAgent }` from the package | Agent frameworks | Agent |
| **Claude Code skill** | `/dmv` slash command | Claude Code users | Agent |

All five paths call the worker `/api/register` endpoint, which forwards validated requests to the same Supabase edge function. Zero database credentials on the client.

The CLI features an interactive CRT terminal experience (ASCII art frame, green ANSI colors, step-by-step form) that mirrors the web terminal. It also supports non-interactive mode for scripting: `bunx dmv-agent register --name <agent> --email <email> --operator <name>`.

### Rate limiting

Two distinct surfaces, owned by the Cloudflare Worker.

**Render path** (`/api/card`, `/api/og`): `API_RATE_LIMITER` binding — 100 req/60s per `${ip}:${pathname}`, namespace `1001` (DMV-local). Runs BEFORE the in-Worker cache lookup so rejections don't eat CPU on L1/R2 reads. Rejected requests return `429` with `Retry-After: 60`. Configured in `wrangler.jsonc` under the top-level `ratelimits` array.

**Register path** (`/api/register`): five layers, ordered cheapest-to-most-expensive.

| Layer | Scope | Limit | Backend | Notes |
|-------|-------|-------|---------|-------|
| Client lockfile | Per machine (SHA-256 fingerprint) | 3 per 24h | `~/.dmv-agent/registrations.json` | CLI/MCP only. Advisory — easily bypassed. |
| Worker: Turnstile | Per browser request | Pass/fail | Cloudflare Turnstile siteverify | Browser path only. Validates `success` + `hostname` + `action: dmv_register`. CAPTCHA runs BEFORE shared counters. |
| Worker: shared CF | Per email, per IP+email | 5 per 60s, 4 per 60s | CF Workers Rate Limiting API | Bindings `RL_OTP_EMAIL` (ns `4005`) and `RL_OTP_IP_EMAIL` (ns `4007`). Both `namespace_id` values are SHARED at the CF account level with `agentCommunity_PAGE`. |
| Worker: KV cooldown | Per machine fingerprint | Threshold-then-hold | DMV-local `REGISTER_COOLDOWN_KV` | CLI/MCP only. Key prefix `dmv:register:fingerprint:<sha256>`. Not shared with PAGE. |
| DB: lifetime cap | Per email, lifetime | 3 (unendorsed) / 10 (endorsed) | Postgres | Inside `register-agent` edge function. Backstop for slow-burn abuse. |
| DB: unique constraint | Per cert ID | Deterministic dedup | Postgres | Catches re-registration of identical inputs. |

Upstash Redis was removed from DMV in the 2026-04-08 hardening pass — every register-path counter now lives in Cloudflare. The worker is the single anti-abuse choke point; the edge function is strictly an upstream that validates and INSERTs. See [AUTH_DMV.md](AUTH_DMV.md) for the full design rationale and the cross-repo coupling contract with `agentCommunity_PAGE`.

## Repository structure

```
threejs_box_design_dmv/
│
├── index.html                    Web UI entry point (importmap, GSAP, Inter wordmark font, CSS)
├── css/styles.css                All styles (theme tokens, layout, center `.agent` mark, responsive)
├── js/
│   ├── app.js                    Main: events, scroll, permalink, zoom, sound, clock, theme/favicon sync
│   ├── TV.js                     Three.js scene: GLTF model, camera, zoom, night mode
│   ├── CRTTerminal.js            Canvas2D CRT: 8-phase boot, form, validation, effects
│   ├── HoloCard.js               Holographic card: ShaderMaterial, rarity, identicon, QR
│   ├── AboutPoster.js            About panel: PPSupply fonts, show/hide, zoom, theme-aware text colors
│   ├── CardPoster.js             [Legacy] Original flat card — replaced by HoloCard
│   └── supabase.js               Registration client: fetch() to edge function
│
├── images/                       Favicons: favicon.ico + favicon_dark.ico
├── fonts/                        PPSupply font files (4 .otf)
├── models/                       3D models (tv1.glb)
├── audio/                        Background track(s) (user-provided, optional)
│
├── supabase/functions/
│   ├── register-agent/index.ts   POST — Worker upstream (validate, lifetime cap, generate cert, insert). Anti-abuse lives in the worker.
│   ├── lookup-agent/index.ts     GET — public read-only lookup by cert ID or domain
│   └── badge/index.ts            GET — SVG badge generator (flat + card styles)
│
├── packages/dmv-agent/           NPM package: @agentcommunity/dmv-agent
│   ├── src/
│   │   ├── cli.ts                CLI binary — CRT terminal UI, boot screen, form flow
│   │   ├── ui.ts                  CRT frame renderer, ANSI colors, box drawing (zero deps)
│   │   ├── rate-limit.ts          Machine fingerprint, local lockfile, 3/24h limit
│   │   ├── mcp-server.ts         MCP server (register_agent, verify_certificate)
│   │   ├── register.ts           Core registration (validate → POST to dmv.agentcommunity.org/api/register worker proxy + machine_fingerprint)
│   │   ├── certificate.ts        FNV-1a hash + Luhn mod-36 cert ID generation
│   │   ├── validate.ts           Agent name, email validation
│   │   ├── types.ts              TypeScript interfaces
│   │   └── index.ts              Public API exports
│   ├── skills/dmv/SKILL.md       Claude Code /dmv skill
│   ├── package.json              pnpm, only dep: @modelcontextprotocol/sdk
│   ├── README.md                 Package docs (quick start, API, security, architecture)
│   └── DEPLOY.md                 Go-live checklist (DB, edge fns, npm publish, monitoring)
│
├── packages/dmv-agent-alias/     NPM package: dmv-agent (unscoped alias)
│   ├── bin/dmv-agent.js          Thin wrapper — re-exports @agentcommunity/dmv-agent CLI
│   ├── package.json              Depends on @agentcommunity/dmv-agent
│   └── README.md                 Short docs pointing to main package
│
├── llms.txt                      LLM-readable site description (agent onboarding, AID guide, sharing)
├── CLAUDE.md                     Instructions for Claude Code agents
├── AGENTS.md                     Terse code reference for agents
└── ARCHITECTURE.md               ← this file
```

## Certificate ID system

Content-addressed, deterministic, offline-verifiable.

```
Input:   "my-assistant" + "user@example.com" + "agent"
          ↓
FNV-1a:  32-bit hash → word index + 6 hex chars
          ↓
Luhn:    mod-36 check digit appended
          ↓
Output:  MESA-DD6-660J

Format:  WORD-XXX-XXXC
         │     │    └─ check digit (Luhn mod-36)
         │     └────── 6 hex chars from hash
         └──────────── 1 of 32 words (NOVA, APEX, FLUX, ...)
```

- Same inputs → same ID (deterministic)
- Anyone can verify offline (check digit, ~10 lines in any language)
- Cannot be enumerated or predicted (not sequential)

## Security model

```
Principle: never trust the client.

Client code:     validates → POST JSON → reads response
                 (no secrets, no DB access, just fetch())

Edge function:   validates again → rate limits → generates cert → INSERTs
                 (holds service role key, server-side authority)

Database:        RLS denies all anon access
                 (only reachable through edge function with service key)
```

| Threat | Mitigation |
|--------|-----------|
| Spam registrations (browser) | Cloudflare Turnstile (server-side hostname + `dmv_register` action check) + shared CF rate limits (`RL_OTP_EMAIL` 5/60s, `RL_OTP_IP_EMAIL` 4/60s — both shared with `agentCommunity_PAGE` at the CF account level) + DB lifetime cap 3/email (10 if endorsed). CAPTCHA always runs before counters. |
| Spam registrations (CLI/MCP) | Machine fingerprint required + same shared CF rate limits + DMV-local KV cooldown (`REGISTER_COOLDOWN_KV`) + DB lifetime cap. Headless clients can't solve Turnstile, so fingerprint substitutes. |
| Name squatting | Pre-registration model — multiple users can claim the same domain. Magic link email verifies identity. |
| Credential theft | No credentials in client code. Anon key removed. Only the worker `/api/register` URL is public; `TURNSTILE_SECRET_KEY` is encrypted on the worker, `SUPABASE_SERVICE_ROLE_KEY` only inside the edge function runtime. |
| Data exfil | lookup-agent returns only public fields. No email, no IP, no operator name. |
| Token reuse across properties | Turnstile tokens are scoped to the DMV hostname AND the `dmv_register` action. A token minted on PAGE or for a different DMV route is rejected by `verifyTurnstileToken`. |
| DDoS on edge fn | The worker is the public choke point — Supabase only sees worker-forwarded traffic (plus a temporary direct-bypass for legacy CLI versions, see CLOUDFLARE.md "Known gaps"). Worker has built-in CF DDoS protection. |

## Badges

SVG badges embed in any website or README, always linking back to dmv.agentcommunity.org.

**Flat badge** (GitHub READMEs — shields.io style):
```
GET /badge?id=MESA-DD6-660J
```

**Card badge** (websites — branded, 280x72):
```
GET /badge?id=MESA-DD6-660J&style=card
```

Note: `?domain=` is deprecated (ambiguous with multiple pre-registrations per domain). Use `?id=CERT-ID`.

Embed code:
```markdown
[![my-assistant.agent](https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J)](https://dmv.agentcommunity.org/c/MESA-DD6-660J/my-assistant)
```

## Relationship to .agent community

The DMV is one piece of a larger ecosystem:

| Project | What | Where |
|---------|------|-------|
| **agentcommunity.org** | Mission, membership, .agent ICANN application | agentcommunity.org |
| **AID** | DNS-based Agent Identity & Discovery protocol | aid.agentcommunity.org |
| **DMV** | Pre-registration terminal + badge + API (this repo) | dmv.agentcommunity.org |

The DMV serves as the **identity layer for the pre-ICANN era**. Before `.agent` domains exist in DNS, the DMV certificate ID is the verifiable agent identity. When `.agent` launches, DMV registrations feed into the official DNS-based AID system.

## Agent-facing content surfaces

Every surface an agent might touch gives them the full story — what the DMV is, how to register, what to do after (share, set up AID), and how to contribute. Progressively lighter distillations of the same content:

| Surface | Richness | Where | Audience |
|---------|----------|-------|----------|
| **SKILL.md** (welcome packet) | Full — 7 sections, AID setup guide, tweet templates | `packages/dmv-agent/skills/dmv/SKILL.md` | Claude Code `/dmv` skill |
| **llms.txt** | Rich — registration, sharing, AID, contribute | `/llms.txt` (linked from `<link rel="alternate">`) | Any LLM reading the site |
| **README.md** | Medium — "For AI agents" section, quick AID hint | `packages/dmv-agent/README.md` | Agents reading npm package docs |
| **Hidden HTML** | Light — register command, AID record, key links | `index.html` `<div hidden data-agent-info>` | Agents parsing page source |
| **Meta tags** | Minimal — CLI command, MCP config | `index.html` `<meta name="agent:*">` | Agent tooling / discovery |

CLI-first everywhere. MCP is available but secondary — for one-time registration, `bunx dmv-agent register` is simpler than configuring an MCP server.

## Text surface alignment guardrail

To prevent copy drift across user-facing surfaces, the repo includes a text audit harness:

| Component | Path | Purpose |
|-----------|------|---------|
| Audit library | `scripts/text-surfaces/audit-lib.mjs` | Defines surfaces, claims, critical rules, accepted exceptions |
| CLI runner | `scripts/text-surfaces/run-audit.mjs` | Prints report (`--json`, `--strict`, `--out`) |
| Tests | `tests/text-surfaces.test.mjs` | Enforces critical invariants + card field parity |
| Human docs | `docs/text-surface-audit.md` | Usage, rationale, maintenance notes |

### Audit model

- **Surfaces**: web CRT, share/permalink UI, client/server card renderers, metadata/OG, README/docs, CLI, MCP, API responses.
- **Claims**: pre-registration, non-binding language, verification email, certificate/permalink/badge/share terms, AID, audience cues, terms/charter.
- **Critical rules**:
  - Core docs must communicate non-binding pre-registration.
  - Agent runtime surfaces must mention verification email.
  - Share surfaces must include permalink format.
  - Client/server card field labels must stay identical.

### Accepted exceptions (intentional divergence)

1. `status-language-drift`
   - DB row starts `provisional_dmv` until email verification.
   - Card text remains `VERIFIED` by design (public artifact, no DB status crawl at card render time).
2. `web-crt-email-reminder-gap`
   - Web CRT completion avoids extra verification copy.
   - Verification/link/badge details are handled via follow-up email flow.

These are configured in `ACCEPTED_EXCEPTIONS` inside `scripts/text-surfaces/audit-lib.mjs`.

### Operational commands

```bash
npm run text:audit      # human-readable matrix
npm run text:audit:json # machine-readable output
npm run text:check      # strict tests (CI-safe)
```

## Tech stack

| Layer | Technology | Notes |
|-------|-----------|-------|
| Web UI | Three.js 0.152.2, GSAP 3.12.2, Canvas2D | No build system, native ES modules |
| NPM package | TypeScript, MCP SDK | pnpm for dev, bunx for users |
| Edge functions | Deno (Supabase Edge Functions) | Auto-deployed env vars |
| Database | PostgreSQL (Supabase) | RLS, unique constraints |
| Hosting (web) | Cloudflare Workers Static Assets + Container | dist/ served by `dmv-agentcommunity` worker |
| Hosting (API anti-abuse) | Cloudflare Worker (`/api/register`) | Turnstile + shared CF rate limits + KV cooldown |
| Hosting (API upstream) | Supabase Edge Functions | Validation + cert ID generation + DB writes |
