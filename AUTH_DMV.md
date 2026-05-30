# DMV Registration & Auth System

Complete reference for how DMV pre-registration works, how it connects to agentcommunity.org auth, what's implemented, what needs migration, and how the CLI-first agent flow is designed.

## System Overview

The DMV (Department of Machine Verification) is the identity pre-registration system for the .agent community. It lets agents and their operators claim `.agent` domain names through 5 entry points, all hitting the same backend. The CLI is the primary agent-facing path — no browser needed, no UI dependency.

```
                              ENTRY POINTS
 ┌──────────┐  ┌─────────┐  ┌──────────┐  ┌────────┐  ┌──────────────┐
 │  Web UI  │  │   CLI   │  │   MCP    │  │ JS API │  │ Claude Code  │
 │(humans + │  │(agents) │  │(agents)  │  │(agent  │  │   /dmv skill │
 │   orgs)  │  │         │  │          │  │ frames)│  │              │
 └────┬─────┘  └────┬────┘  └────┬─────┘  └───┬────┘  └──────┬───────┘
      │             │            │             │              │
      │    signup_  │   signup_  │   signup_   │   signup_    │ runs CLI
      │   source:   │  source:   │  source:    │  source:     │ via bunx
      │    'ui'     │   'cli'    │   'mcp'     │   'api'      │
      └──────┬──────┴─────┬──────┴──────┬──────┴──────┬───────┘
             │            │             │             │
             ▼            ▼             ▼             ▼
      ┌─────────────────────────────────────────────────────┐
      │      Cloudflare Worker — POST /api/register         │
      │           (worker/index.ts handleRegister)           │
      │                                                     │
      │  1. Validate JSON shape                             │
      │  2. Browser path: verify Turnstile siteverify       │
      │     (success + hostname + action=dmv_register)      │
      │     CLI/MCP path: require machine_fingerprint       │
      │  3. Shared CF rate limiters (BOTH paths)            │
      │     ├─ RL_OTP_EMAIL    (5/60s, ns 4005, shared)    │
      │     └─ RL_OTP_IP_EMAIL (4/60s, ns 4007, shared)    │
      │  4. CLI/MCP only: DMV-local KV cooldown             │
      │     └─ REGISTER_COOLDOWN_KV (fingerprint hash)      │
      │  5. Forward to Supabase ────────────────────────────┼──┐
      │                                                     │  │
      │  Anti-abuse always runs BEFORE upstream forward.    │  │
      │  CAPTCHA always runs BEFORE shared counters.        │  │
      └─────────────────────────────────────────────────────┘  │
                                                                 │
      ┌──────────────────────────────────────────────────────┐  │
      │         register-agent edge function                  │◄─┘
      │              (Supabase / Deno)                        │
      │                                                       │
      │  1. Verify x-dmv-proxy secret header from the worker  │
      │  2. Validate all fields + length limits               │
      │  3. Lifetime cap (DB)                                 │
      │     └─ 5 per email (unendorsed) / 12 (endorsed)      │
      │  4. Generate certificate_id (FNV-1a + Luhn)           │
      │  5. INSERT with certificate_id set (status defaults   │
      │     to pending_profile via baseline.sql:3345)         │
      │  6. Return cert ID + permalink + badge URLs           │
      │                                                       │
      │  NOTE: Upstash Redis rate limiting REMOVED in the    │
      │  2026-04-08 hardening pass. The worker owns           │
      │  anti-abuse now; this function is strictly an         │
      │  upstream that validates and INSERTs. The gate on     │
      │  the x-dmv-proxy header blocks direct calls to the    │
      │  Supabase URL that would bypass the worker. The       │
      │  header value is the shared DMV_PROXY_SECRET (set on   │
      │  both platforms), replacing the old public `v1`        │
      │  constant. Rollout completed 2026-05-29: Phase C      │
      │  removed the `v1` branch, so replaying the public     │
      │  constant now returns 403. Fails closed (rejects all) │
      │  if DMV_PROXY_SECRET is unset.                         │
      └──────────────────────┬────────────────────────────────┘
                             │
                             │ DB trigger fires async
                             │ (on_dmv_registration, fires on
                             │  certificate_id IS NOT NULL)
                             ▼
      ┌─────────────────────────────────────────────────────┐
      │    handle-dmv-registration (agentcommunity.org)     │
      │                                                     │
      │  1. Find or create auth user by email               │
      │  2. Link registration: user_id = auth_user.id       │
      │  3. Upsert domain into user_domains table           │
      │  4. Send certificate email (cert card, no link)     │
      │  5. New users: send separate magic-link email       │
      └─────────────────────────────────────────────────────┘
                             │
                   user decides to claim
                             │
                             ▼
      ┌─────────────────────────────────────────────────────┐
      │          agentcommunity.org auth hub                │
      │                                                     │
      │  1. New user: magic link / existing: OTP code       │
      │  2. Normal PAGE auth flow runs — no special DMV     │
      │     status handling, because DMV rows look like     │
      │     any other pending_profile row from PAGE's view  │
      │  3. Redirects to /members dashboard                 │
      └─────────────────────────────────────────────────────┘
```

## Status Lifecycle

**TL;DR: DMV does NOT participate in the `registration_status` lifecycle.** PAGE's `registration_status` enum contains six values — `pending_profile`, `pending_signature`, `complete`, `failed`, `blocked`, `anonymized` — none of which are DMV-specific. The DMV edge function omits the `status` field from its INSERT entirely; the column's `DEFAULT 'pending_profile'::registration_status NOT NULL` (baseline.sql:3345) applies cleanly. PAGE's TypeScript types (`types/supabase.ts`), auth hub (`app/auth/page.tsx`), and member count queries all work unchanged for DMV rows.

**How PAGE distinguishes DMV rows from regular agentcommunity.org signups:** the `certificate_id` column. PAGE's DMV integration (shipped in `agentCommunity_PAGE/supabase/migrations/20260210999999_dmv_add_agent_enum.sql`, `20260211000000_dmv_schema_and_trigger_guard.sql`, `20260211000100_dmv_registration_trigger.sql`) uses `WHERE certificate_id IS NOT NULL` as the DMV marker everywhere it matters:

- The `handle_welcome_email_on_registration` trigger: `IF NEW.certificate_id IS NOT NULL THEN RETURN NEW;` — DMV rows get their own certificate email, not the generic welcome
- The `handle_endorsement_request_on_registration` trigger: same skip for DMV rows
- The `on_dmv_registration` trigger fires specifically `WHEN (NEW.certificate_id IS NOT NULL)` and calls `handle-dmv-registration` to wire up the auth user
- All DMV-aware member count queries filter by `certificate_id IS NOT NULL` rather than by a status value

**Historical note:** an earlier version of this doc (and the DMV edge function code through 2026-04-08) described a `provisional_dmv` status value that was supposed to live in the enum until email verification upgraded it to `pending_profile`. That design was written into the plan but **never shipped on the PAGE side** — PAGE's team chose the `certificate_id IS NOT NULL` marker approach instead. The stale `status: 'provisional_dmv'` line in the DMV edge function was a latent bug that produced `22P02 invalid input value for enum` on every INSERT once the function was deployed against the modern PAGE schema. Fixed in commit `8d73924` by removing the status field from the INSERT.

If you need to exclude DMV rows from a query, use `WHERE certificate_id IS NULL`. If you need only DMV rows, use `WHERE certificate_id IS NOT NULL`. Never use status.

## The CLI-First Agent Flow

The CLI (`bunx dmv-agent register`) is designed as the primary path for AI agents. It's fast, scriptable, and doesn't require a browser.

### Interactive mode

```
$ bunx dmv-agent register
```

Presents a CRT-style terminal: boot screen → about/terms/charter menu → step-by-step form (agent name → operator name [required] → email → description) → confirmation → submit → success screen with card link, share commands, badge markdown.

### Non-interactive mode (for scripting / CI)

```
$ bunx dmv-agent register --name my-agent --email operator@example.com --operator "Jane Doe"
```

All fields validated client-side before network call. Exit codes: 0 = success, 1 = server/network error, 2 = validation error.

### MCP mode (for autonomous agents)

```json
{
  "mcpServers": {
    "dmv": { "command": "bunx", "args": ["dmv-agent"] }
  }
}
```

Exposes `register_agent` and `verify_certificate` tools. `operator_name` is required (the human accountable for the agent). Rate-limited identically to CLI (shared lockfile).

### Client-side protections

Both CLI and MCP enforce:
- Machine fingerprint: SHA-256 of hostname + username + platform
- Local lockfile: `~/.dmv-agent/registrations.json`, max 3 registrations per 24h
- Lockfile is advisory — the worker's `REGISTER_COOLDOWN_KV` cooldown plus the shared CF rate limits are the real enforcement

### What agents get back

On success, the CLI/MCP returns:
- `certificate_id`: e.g. `MESA-DD6-660J` (deterministic, offline-verifiable)
- `permalink_url`: `https://dmv.agentcommunity.org/c/CERT-ID/agent-name`
- `badge_url`: flat shields.io-style SVG
- `badge_card_url`: branded 280x72 card SVG
- Share text and badge markdown for READMEs

### After registration

The agent (or its operator) receives a **certificate email** (holographic card + share-first CTAs + badge embed — **no sign-in link**). For **brand-new** auth users, `handle-dmv-registration` also sends a **separate verify email** — a clickable, non-PKCE magic link (`admin.generateLink` → `agentcommunity.org/api/auth/magiclink/verify?token_hash=…`, reusing PAGE's existing route): a real link on **our** domain, never a 6-digit code and never a raw `<project>.supabase.co` URL. That link is the new user's only sign-in path. Existing PAGE users get the certificate email only and sign in via the normal flow with the same email. PAGE's normal auth flow takes over from there — no DMV-specific status transitions happen, because DMV rows live in the same status lifecycle as any other registration (they're just tagged by `certificate_id IS NOT NULL`).

## Rate Limiting Architecture

The Cloudflare Worker is the single anti-abuse choke point. The Supabase edge function trusts that anything reaching it has already cleared the worker's gates, and enforces that trust with the `x-dmv-proxy` shared-secret gate: it accepts only requests carrying the `DMV_PROXY_SECRET` value the worker sets (constant-time compared, fail-closed if unset). The earlier temporary direct-Supabase bypass for legacy CLI versions was **closed 2026-05-29** — the public `v1` constant is retired and any direct-to-Supabase call now returns 403 `direct_access_deprecated`.

Five effective layers on the register path, ordered cheapest-to-most-expensive:

```
Request arrives at Worker /api/register
     │
     ▼
┌─────────────────────────────────┐
│  Layer 0: Client lockfile        │  CLI + MCP only
│  3 / machine / 24h              │  Advisory, easily bypassed
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Layer 1: Worker validation     │  Reject malformed JSON,
│  Schema + length limits         │  unknown signup_source, etc.
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 2a: Turnstile (browser)  │  Browser path only.
│  Validates success +            │  Action=dmv_register,
│  hostname + action              │  hostname must match.
│                                 │  CAPTCHA before counters!
│  Layer 2b: Fingerprint required │  CLI/MCP path only.
│  (CLI/MCP)                     │  Headless cannot solve CAPTCHA.
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 3: Shared CF limiters    │  Both paths.
│  RL_OTP_EMAIL    5/60s ns 4005 │  ns IDs SHARED with PAGE
│  RL_OTP_IP_EMAIL 4/60s ns 4007 │  at the CF account level.
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 4: KV cooldown           │  CLI/MCP only.
│  REGISTER_COOLDOWN_KV           │  Threshold-then-hold.
│  Key: dmv:register:fingerprint: │  DMV-local namespace.
│       <sha256(fingerprint)>     │  NOT shared with PAGE.
└──────────────┬──────────────────┘
               │ pass — forward to Supabase
               ▼
┌─────────────────────────────────┐
│  Layer 5: DB lifetime cap       │  Postgres query in
│  5 (unendorsed) / 12 (endorsed)│  register-agent edge fn.
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 6: DB unique constraint  │  certificate_id is UNIQUE.
│  Same name+email+type = 409    │  Deterministic dedup.
└──────────────┬──────────────────┘
               │ pass
               ▼
         Registration created
```

**Why CAPTCHA before counters:** if shared CF limiters ran first, an attacker submitting invalid Turnstile tokens could exhaust the 5/60s email quota for real users. Browser path: validate → Turnstile → counters → forward. CLI/MCP path: validate → fingerprint → counters → KV cooldown → forward. This ordering is non-negotiable per `docs/plans/2026-04-08-cross-repo-hardening-handoff-prompt.md` §3, §4.

**Cross-repo coupling with `agentCommunity_PAGE`:** the `4005` and `4007` namespace_ids are SHARED at the Cloudflare account level. A signup attempt that consumes email quota on PAGE has less email quota available on DMV. This is intentional — those two counters represent the same abuse surface across both properties. PAGE's `RL_AUTH` (4001) and `RL_OTP_IP` (4006) are NOT shared by DMV; plain-IP limits are too blunt for shared corporate networks and PAGE's live OTP path doesn't use `RL_AUTH` anyway. The coupling matters in three drift scenarios documented in `worker/index.ts` and `CLOUDFLARE.md`.

**KV cooldown key design:** keys are SHA-256 hashed (`dmv:register:fingerprint:<hash>`). Fingerprints are never stored in KV as plaintext. Key prefix does not collide with PAGE's `KV_RATE_LIMIT` namespace because DMV uses a separate, DMV-local KV namespace (`REGISTER_COOLDOWN_KV` id `ec0cdc55c2f94267af84f0218c961a00`). PAGE's OTP cooldown uses `c0e0d88fff1a4c59805ab85c7a03100f` — fully separate.

**Rate limit responses:** Worker returns `429` with `Retry-After: 60` and JSON body `{ error: 'rate_limited', message: '...', retry_after_seconds: 60 }`. Fingerprint cooldown returns `{ error: 'fingerprint_cooldown', ... }` with the cooldown duration. Lifetime cap inside Supabase still returns `403` with `{ current, limit, endorsed }`.

## Certificate ID System

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

- Same inputs → same ID (deterministic). Re-registering the same agent+email returns 409 with the existing cert ID.
- Anyone can verify offline with ~10 lines in any language (check digit validation).
- The cert ID is generated server-side (authoritative), but the same algorithm runs in the CLI package for offline verification.
- **Collision risk:** FNV-1a 32-bit with 29 bits of effective entropy. Birthday problem reaches 50% at ~23K unique input combinations. Mitigated by the DB unique constraint (returns 409 on collision). Consider upgrading to FNV-1a 64-bit before 10K registrations.

## Pre-Registration Model

Multiple users CAN pre-register interest in the same `.agent` domain. `domain_requested` is NOT unique. `certificate_id` IS unique (same user+agent+type = same cert ID). This is intentional: pre-registration records interest, it does not guarantee assignment. When `.agent` launches in DNS, the community will decide allocation.

## Database Schema

### What DMV writes (INSERT)

| Column | Type | Value | Notes |
|--------|------|-------|-------|
| `registration_type` | TEXT (enum) | INDIVIDUAL / ORGANIZATION / AGENT | Web UI uses first two, CLI/MCP uses AGENT. `AGENT` was added to the enum by PAGE migration `20260210999999_dmv_add_agent_enum.sql`. |
| `full_name` | TEXT | Operator name | Required for INDIVIDUAL + ORG, optional for AGENT (CHECK constraint relaxed by PAGE migration `20260211000000_dmv_schema_and_trigger_guard.sql`) |
| `organization_name` | TEXT | Org name | Required for ORGANIZATION only |
| `domain_requested` | TEXT | `{name}.agent` | Not unique — pre-registration model |
| `email` | TEXT | User's email | Max 254 chars |
| `certificate_id` | TEXT | `WORD-XXX-XXXC` | Unique partial index (`certificate_id IS NOT NULL`). Also the DMV-vs-non-DMV marker PAGE keys off. |
| `signup_source` | TEXT | ui / cli / mcp / api | Tracks which entry point |
| `metadata` | JSONB | `{ agent_description, client_ip }` | Description max 500 chars |

**Columns DMV does NOT set** (and relies on the DB to fill in):

| Column | Default / how it gets set | Notes |
|--------|---------------------------|-------|
| `status` | `pending_profile` (DB default, `baseline.sql:3345`) | NEVER set by DMV. Lives in PAGE's status lifecycle. |
| `user_id` | Set asynchronously by `handle-dmv-registration` edge function after trigger fires | Nullable; DMV inserts with it unset, trigger fills it in |
| `created_at` | `now()` | |

### What the trigger sets

| Column | Value | Set by |
|--------|-------|--------|
| `user_id` | Auth user's UUID | `handle-dmv-registration` edge function, after `on_dmv_registration` trigger fires on `certificate_id IS NOT NULL` |

### Indexes needed

```sql
-- For lifetime cap query (email lookup)
CREATE INDEX IF NOT EXISTS idx_registrations_email
  ON registrations (email);

-- For IP-based rate limiting fallback (if DB fallback is ever needed)
CREATE INDEX IF NOT EXISTS idx_registrations_client_ip
  ON registrations ((metadata->>'client_ip'))
  WHERE metadata->>'client_ip' IS NOT NULL;
```

## Registration Types

| Type | Source | Fields required | Operator model |
|------|--------|----------------|----------------|
| `INDIVIDUAL` | Web UI | agent_name, email, full_name | Human registers for themselves |
| `ORGANIZATION` | Web UI | agent_name, email, full_name, organization_name | Org registers an agent |
| `AGENT` | CLI, MCP, JS API, skill | agent_name, email, operator_name | Agent registers with human operator backing |

The `AGENT` type may need to be added to the main site's `registration_type` enum if it only has `INDIVIDUAL` and `ORGANIZATION`:

```sql
ALTER TYPE registration_type ADD VALUE 'AGENT';
```

## Input Validation

Validated server-side by **both** the Worker (`/api/register`) and `register-agent`, which now share a single rule module — `supabase/functions/_shared/registration-validation.ts` — so the two can't drift (client-side validation mirrors this but is not trusted):

| Field | Rule |
|-------|------|
| `agent_name` | 3-63 chars, lowercase alphanumeric, hyphens allowed in middle, regex: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` (63 = DNS label max per RFC 1035) |
| `email` | RFC-ish regex, max 254 chars |
| `operator_name` | Max 100 chars |
| `organization_name` | Max 100 chars |
| `description` | Max 500 chars |
| `signup_source` | Must be one of: ui, cli, mcp, api |
| `registration_type` | Must be one of: AGENT, INDIVIDUAL, ORGANIZATION |

## CORS Policy

The `register-agent` edge function restricts CORS to:
- `https://dmv.agentcommunity.org`
- `https://agentcommunity.org`

CLI and MCP are not browser-based and don't send `Origin` headers, so CORS does not affect them. The `Vary: Origin` header prevents CDN cache poisoning.

## Hosting & Infrastructure

| Component | Hosted on | Notes |
|-----------|-----------|-------|
| Web UI (static) | Cloudflare Workers Static Assets (`dist/`) | index.html + JS/CSS/fonts/models, no SSR |
| API routes (`/api/card`, `/api/og`) | Cloudflare Worker → L1 (`caches.default`) → R2 → Cloudflare Container | Both served by the same Skia renderer (`@napi-rs/canvas`); container only invoked on first miss |
| Registration anti-abuse (`/api/register`) | Cloudflare Worker (`handleRegister`) | Turnstile + shared CF rate limits + DMV-local KV cooldown. Forwards to Supabase. |
| Permalink crawler OG | Cloudflare Worker HTMLRewriter | `worker/index.ts handlePermalink` — streams index.html and injects per-card `og:*` / `twitter:*` tags for crawler UAs |
| `/badge/*` | Cloudflare Worker proxy → Supabase Edge Function | `handleBadge` forwards with header hygiene + path-traversal defense |
| Edge functions (register, lookup, badge) | Supabase Edge Functions (Deno) | Holds service role key. `register-agent` is now strictly an upstream from the worker (validation + cert ID + INSERT, no rate limiting). |
| Database | Supabase PostgreSQL | RLS denies anon, service key bypasses |
| Rate limiting (DMV) | Cloudflare Workers Rate Limiting API + Workers KV | `RL_OTP_EMAIL`/`RL_OTP_IP_EMAIL` shared with `agentCommunity_PAGE` at the CF account level, `REGISTER_COOLDOWN_KV` is DMV-local. Upstash removed. |
| NPM package | npm registry | `@agentcommunity/dmv-agent` + `dmv-agent` alias |

## Security Model

```
Principle: never trust the client.

Client code:     validates → POST JSON → reads response
                 (no secrets, no DB access, just fetch())

Worker:          validates → CAPTCHA (browser) or fingerprint (CLI/MCP)
                 → shared CF rate limits → DMV-local KV cooldown
                 → forward to Supabase
                 (holds TURNSTILE_SECRET_KEY, owns anti-abuse)

Edge function:   validates again → lifetime cap → generates cert → INSERTs
                 (holds service role key, validates upstream, no
                  rate limiting — that's the worker's job now)

Database:        RLS denies all anon access
                 (only reachable through edge function with service key)
```

No database credentials exist in any client code — web, CLI, MCP, or JS API. The only public-facing URL for registration is `https://dmv.agentcommunity.org/api/register` on the worker. The Supabase edge function URL is also still public (legacy bypass for older CLI versions); closing it is tracked under "Known gaps" in `CLOUDFLARE.md`.

---

## What's Implemented (DMV side, as of 2026-04-08)

Everything below is shipped in this repo and ready to deploy:

| Feature | Status | Where |
|---------|--------|-------|
| Worker `/api/register` proxy | Done | `worker/index.ts` `handleRegister` |
| Cloudflare Turnstile (browser) | Done | `worker/index.ts` `verifyTurnstileToken`, `index.html` widget mount |
| Shared CF rate limits with PAGE | Done | `wrangler.jsonc` `RL_OTP_EMAIL`/`RL_OTP_IP_EMAIL` (ns 4005/4007) |
| DMV-local KV fingerprint cooldown | Done | `worker/rate-limit-kv.ts`, `REGISTER_COOLDOWN_KV` binding |
| Upstash Redis REMOVED from edge fn | Done | `supabase/functions/register-agent/index.ts` (-90 lines) |
| Lifetime cap (5/12 per email) | Done | `supabase/functions/register-agent/index.ts` |
| `x-dmv-proxy` shared-secret gate on `register-agent` (direct-access block) | Done | `supabase/functions/register-agent/index.ts` — requires the worker-set `DMV_PROXY_SECRET` header value (constant-time compared) on every non-OPTIONS request; the public `v1` constant was retired 2026-05-29 |
| DMV uses DB default for `status` (no `provisional_dmv`) | Done | `supabase/functions/register-agent/index.ts` — commit `8d73924` removed the stale status line |
| CORS restricted to known origins | Done | Same file |
| Input length validation (all fields) | Done | Same file |
| Retry-After on 429 responses | Done | Worker (`/api/register`) and edge function (lifetime cap) |
| Security headers (HSTS, X-Frame, nosniff) | Done | `public/_headers` |
| HTML edge caching + stale-while-revalidate | Done | `public/_headers` |
| API input validation (card/og routes) | Done | `worker/index.ts`, `container/server.mjs` |
| API L1+R2 cache + long-lived immutable PNGs | Done | `worker/index.ts` (cache hierarchy) |
| Badge cache 1h/24h | Done | `supabase/functions/badge/index.ts` |
| CLI fetch timeout (30s) + retry on 5xx | Done | `packages/dmv-agent/src/register.ts` |
| Web fetch timeout (15s) | Done | `js/register.js` (`:36`) |
| MCP rate limiting + operator required | Done | `packages/dmv-agent/src/mcp-server.ts` |
| Lockfile crash protection | Done | `packages/dmv-agent/src/rate-limit.ts` |
| SKILL.md operator docs fixed | Done | `packages/dmv-agent/skills/dmv/SKILL.md` |
| Render loop pauses when tab hidden | Done | `js/TV.js` |
| CRT scanline throttle in idle | Done | `js/CRTTerminal.js` |
| Dead code removed (CardPoster.js) | Done | Deleted |
| Dead Vercel artifacts removed (`api/`, `vercel.json`, `middleware.js`) | Done | Deleted post-cutover |
| Fog leak fixed | Done | `js/TV.js` |

## Cross-Repo Migrations (owned by PAGE)

All DB schema changes required for DMV to function were shipped by the PAGE team in `agentCommunity_PAGE/supabase/migrations/`:

| Migration | What it does | Live? |
|---|---|---|
| `20260210999999_dmv_add_agent_enum.sql` | `ALTER TYPE registration_type ADD VALUE IF NOT EXISTS 'AGENT'` | Yes — DMV INSERTs with `registration_type: 'AGENT'` are accepted |
| `20260211000000_dmv_schema_and_trigger_guard.sql` | Adds `certificate_id`, `signup_source`, `metadata` columns to `registrations`. Makes `user_id` nullable. Relaxes CHECK constraints for AGENT. Adds `certificate_id` columns + unique indexes. Guards welcome/endorsement email triggers with `IF NEW.certificate_id IS NOT NULL THEN RETURN;` | Yes |
| `20260211000100_dmv_registration_trigger.sql` | Creates `on_dmv_registration` trigger + `handle_dmv_registration()` function that calls the `handle-dmv-registration` edge function via `pg_net` | Yes |

**No DMV-side SQL migrations are required.** Earlier versions of this doc listed three `ALTER TYPE` / `CREATE INDEX` statements as "required before DMV deploy" — those turned out to be either already shipped by PAGE (AGENT enum, certificate_id unique index) or unnecessary for the actual design (the `provisional_dmv` enum value was never added because PAGE uses the `certificate_id IS NOT NULL` marker instead).

### Not required — but would be nice to have

**Member count hygiene on PAGE:** if PAGE's admin stats / homepage counts currently treat `certificate_id IS NOT NULL` rows as regular members (i.e., users whose email hasn't been verified yet), those counts may drift higher than expected once DMV starts seeing real traffic. PAGE's team should audit queries that count "members" and decide whether to exclude unclaimed DMV rows (e.g., filter on `certificate_id IS NULL OR user_id IS NOT NULL AND <other verified conditions>`). This is a PAGE-side hygiene task, not a blocker for DMV deploy.

**Members dashboard:**

The agent cards section (`AgentCardsSection`) already supports real certificate data behind a feature flag (`NEXT_PUBLIC_SHOW_AGENT_CARDS`). When enabling:
- Fetch `certificate_id` from `user_domains` (not just `domain_name`)
- Render HoloCards for domains with cert IDs, placeholder for those without
- Card images come from DMV `/api/card?id=CERT-ID&name=agent-name`

**Certificate email (as-built — PAGE side):**

`handle-dmv-registration` sends **two** separate emails to a new registrant (both rebuilt 2026-05-29):

- **Certificate email** — sent to everyone. Self-contained slate-palette design (matches `otp-verification.ts`): the holographic card (PNG via `/api/card` — **not** the `/badge` SVG, which Gmail/Outlook drop), the cert ID, a **share-first** layout (**Share on X** = primary button, **LinkedIn** = secondary, a copy-ready permalink box, "View certificate" = quiet link; WhatsApp + "Email a colleague" buttons **removed**), and a Markdown badge embed. **No sign-in link.** Renderer `generateDmvCertificateEmailHtml`, FROM `updates@member.agentcommunity.org` (`usePersonalSender`). All interpolated values are HTML-escaped.
  - **Delivery:** `handle-dmv-registration` INSERTs an `email_queue` row (`template: 'dmv_certificate'`) then calls the Postgres RPC **`process_email_queue_immediate(p_queue_id)`** — the same path every other trigger email uses, which fires `net.http_post` to the `email-gateway` **from inside Postgres** (decoupled from the worker; sub-second). The gateway owns dedup (keyed on `template`+`user_id`), tracking, unsubscribe injection, and suppression. A 5-min `drain-pending-emails` pg_cron job is the backstop. *(Do NOT use an awaited cross-function `fetch()` to the gateway here: `handle-dmv-registration` runs under the `on_dmv_registration` pg_net trigger's ~5s timeout, so an awaited 6-10s round-trip gets torn down and leaves the row `pending` forever — this was a real bug, fixed 2026-05-29 commit `82ba251`.)*
  - **Requires `FEATURE_DMV_REGISTRATION_ENABLED=true`** as a Supabase project secret. The gateway's `isTemplateEnabled` treats the unset flag as OFF and **silently skips** the `dmv_certificate` send (`status=skipped`, reason `feature_flag_disabled`) — set it via `supabase secrets set` and redeploy `email-gateway`.
- **Verify email** (new users only) — a **clickable magic link, NOT a 6-digit code** (DMV registrants arrive via CLI / the card terminal and have no browser code box). `handle-dmv-registration` mints a non-PKCE link with `admin.generateLink({ type: 'magiclink' })`, then builds a URL pointed at **our own domain** — `https://agentcommunity.org/api/auth/magiclink/verify?token_hash=<hashed_token>&type=magiclink` — reusing PAGE's existing magic-link route. It does **not** use `generateLink`'s raw `<project>.supabase.co/auth/v1/verify` `action_link` (that reads as phishing + hurts deliverability), and it does **not** use GoTrue's `/auth/v1/otp` (which sends PAGE's shared 6-digit-code template). Sent via the dedicated `dmv-verify` template through a **direct Resend send** (NOT the queue — so this critical sign-in path can't get stuck `pending`). `magicLinkSent` is surfaced in the response; failures log at `error` level.

Genuine remaining gaps (not deploy blockers):
- **Existing PAGE users who register via DMV get no sign-in link in any email** — they receive the certificate email only and sign in normally at agentcommunity.org. A sign-in CTA in the cert email for the existing-user case would close this.
- `?from=dmv` has no special handler in PAGE's `app/auth/page.tsx`; new users land on the default post-auth destination (`/members`) after the magic link verifies.
- **Automatic card pre-warm** is not wired: `/api/card` cold-renders (~3s) on first request, so a freshly-registered cert's card can lag the first time the email is opened. A fire-and-forget `/api/card` warm at registration would fix it. Low priority.

## Deploy Order

Historical, captured after the 2026-04-08 shipping sprint:

1. PAGE migrations already applied: `20260210999999_dmv_add_agent_enum.sql`, `20260211000000_dmv_schema_and_trigger_guard.sql`, `20260211000100_dmv_registration_trigger.sql` — shipped earlier by the PAGE team
2. `supabase functions deploy register-agent --no-verify-jwt` — Upstash removed, `x-dmv-proxy` gate active, no more `status: provisional_dmv`. **MUST be deployed with `--no-verify-jwt`**: the worker does not forward an Authorization header, so Supabase's platform-level JWT verification has to be off for the function to be reachable.
3. `supabase functions deploy badge` — already deployed historically
4. **Provision worker secrets** in the Cloudflare dashboard for `dmv-agentcommunity`:
   - `TURNSTILE_SECRET_KEY` (encrypted secret) — `wrangler secret put` is currently blocked on this worker by a version-mismatch guard, see `docs/plans/2026-04-08-handoff-prompt.md` §69 for the operational workaround
5. **Provision worker bindings** (one-time, done 2026-04-08):
   - `REGISTER_COOLDOWN_KV` namespace via `pnpm wrangler kv namespace create REGISTER_COOLDOWN_KV` (+ `--preview`), ids pasted into `wrangler.jsonc`
6. `pnpm cf:deploy` (or git auto-deploy via Cloudflare git integration on main) — frontend + worker + container: security headers + `/api/register` + Turnstile + shared CF rate limits + KV cooldown
7. **Publish `@agentcommunity/dmv-agent@0.2.0` to npm** so `bunx dmv-agent register` fetches the worker-proxied version. Done 2026-04-08.
8. **First-submission smoke test:** open `pnpm cf:tail` in another shell and submit a real browser registration. If Turnstile siteverify rejects with `invalid-input-secret`, the dashboard-pasted secret has a typo or trailing whitespace.

All of the above is **complete as of 2026-04-08**. PAGE-side follow-ups (member count hygiene, members dashboard flag) are not blockers — the DMV registration flow works end-to-end without them.

## Testing the Full Flow

1. Register via CLI: `bunx dmv-agent register --name test-agent --email you@example.com --operator "Your Name"`
2. Verify in DB: `certificate_id IS NOT NULL`, `status = 'pending_profile'` (the DB default — not set by DMV), `user_id` populated by `handle-dmv-registration`. In `email_queue`, the `dmv_certificate` row should reach `status = 'sent'` within seconds (auto-sent via `process_email_queue_immediate` — it must NOT be left `pending`; if it is, check `FEATURE_DMV_REGISTRATION_ENABLED`).
3. Check email: the **certificate email** arrives (holographic card + share CTAs, no sign-in link). **New users** also get a **verify email** — click its **magic link** (`agentcommunity.org/api/auth/magiclink/verify?token_hash=…`, a real link on our domain, not a 6-digit code) to sign in. **Existing users** sign in normally with the same email.
4. Verify in DB: `user_id` is set (if it wasn't already), normal PAGE auth flow applied
5. Check members dashboard → HoloCard should render with real certificate data (requires `NEXT_PUBLIC_SHOW_AGENT_CARDS` on PAGE)
6. Test rate limiting (shared CF limiters): register 6 times rapidly with the same email → 6th should return `429 rate_limited` from the worker
7. Test lifetime cap (Supabase DB): register 6 unique agents with the same email → 6th should return `403` with `error: You've maxed out your quota on this email: up to 5 agent identities. Members who've signed the endorsement letter can pre-register up to 12.`
8. Test direct-access gate: `curl -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent -H 'Content-Type: application/json' -d '{}'` → should return `403 direct_access_deprecated`
9. Test the legacy constant is retired: same curl but with `-H 'x-dmv-proxy: v1'` → should return `403` (the public `v1` constant was removed in the 2026-05-29 secret rollout; only the worker's `DMV_PROXY_SECRET` header value is accepted now)
