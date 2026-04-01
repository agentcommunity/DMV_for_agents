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
      │         register-agent edge function                │
      │              (Supabase / Deno)                      │
      │                                                     │
      │  1. Validate all fields + length limits             │
      │  2. Redis rate limiting (Upstash, fail-open)        │
      │     ├─ 3 per IP+email / 10 min                     │
      │     ├─ 5 per email / 10 min                         │
      │     └─ 10 per IP / 10 min                           │
      │  3. Lifetime cap (DB, only if rate limit passes)    │
      │     └─ 3 per email (unendorsed) / 10 (endorsed)    │
      │  4. Generate certificate_id (FNV-1a + Luhn)         │
      │  5. INSERT with status = 'provisional_dmv'          │
      │  6. Return cert ID + permalink + badge URLs         │
      └──────────────────────┬──────────────────────────────┘
                             │
                             │ DB trigger fires async
                             │ (on_dmv_registration)
                             ▼
      ┌─────────────────────────────────────────────────────┐
      │    handle-dmv-registration (agentcommunity.org)     │
      │                                                     │
      │  1. Find or create auth user by email               │
      │  2. Link registration: user_id = auth_user.id       │
      │  3. Upsert domain into user_domains table           │
      │  4. Send certificate email with sign-in CTA         │
      │     (NO magic link — PKCE can't work server-side)   │
      └─────────────────────────────────────────────────────┘
                             │
                   user decides to claim
                             │
                             ▼
      ┌─────────────────────────────────────────────────────┐
      │          agentcommunity.org auth hub                │
      │                                                     │
      │  1. User signs in via OTP (6-digit code)            │
      │  2. Detects provisional_dmv registrations           │
      │  3. Upgrades: provisional_dmv → pending_profile     │
      │  4. User now counts as verified member              │
      │  5. Redirects to /members dashboard                 │
      └─────────────────────────────────────────────────────┘
```

## Status Lifecycle

A registration moves through these statuses. Only DMV sets the initial status; everything after is the main site's responsibility.

```
DMV registration          Email verified at            Endorsement
(any entry point)         agentcommunity.org           signed
       │                         │                        │
       ▼                         ▼                        ▼
 provisional_dmv   ──→    pending_profile    ──→      endorsed
 (not a member)          (verified member)        (full member)
```

| Status | Meaning | Counts as member? | Set by |
|--------|---------|-------------------|--------|
| `provisional_dmv` | Pre-registered, email not verified | No | DMV `register-agent` edge function |
| `pending_profile` | Email verified via OTP, not endorsed | Yes | Main site auth hub on sign-in |
| `endorsed` / `signed` | Endorsed by existing member | Yes | Main site endorsement flow |

**Why `provisional_dmv` exists:** Without it, anyone can inflate member counts by spamming registrations with fake emails. The status creates an email-verification gate: you pre-register at DMV, but you don't become a member until you prove you own the email by signing in at agentcommunity.org.

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
- Lockfile is advisory — server-side Redis + lifetime cap are the real enforcement

### What agents get back

On success, the CLI/MCP returns:
- `certificate_id`: e.g. `MESA-DD6-660J` (deterministic, offline-verifiable)
- `permalink_url`: `https://dmv.agentcommunity.org/c/CERT-ID/agent-name`
- `badge_url`: flat shields.io-style SVG
- `badge_card_url`: branded 280x72 card SVG
- Share text and badge markdown for READMEs

### After registration

The agent (or its operator) receives a certificate email. To become a verified member, the operator signs in at agentcommunity.org with the same email. This upgrades the registration from `provisional_dmv` to `pending_profile`.

## Rate Limiting Architecture

Six layers, from cheapest to most expensive:

```
Request arrives
     │
     ▼
┌─────────────────────────────────┐
│  Layer 1: Client lockfile       │  CLI + MCP only
│  3 / machine / 24h             │  Advisory, easily bypassed
└──────────────┬──────────────────┘
               │
               ▼
┌─────────────────────────────────┐
│  Layer 2: Redis per-IP+email    │  Upstash, sub-ms
│  3 / 10 min                     │  Tightest server-side limit
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 3: Redis per-email       │  Upstash, sub-ms
│  5 / 10 min                     │  Catches email rotation
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 4: Redis per-IP          │  Upstash, sub-ms
│  10 / 10 min                    │  Lenient for shared IPs
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 5: DB lifetime cap       │  Postgres query
│  3 (unendorsed) / 10 (endorsed)│  Only runs for non-rate-limited requests
└──────────────┬──────────────────┘
               │ pass
               ▼
┌─────────────────────────────────┐
│  Layer 6: DB unique constraint  │  certificate_id is UNIQUE
│  Same name+email+type = 409    │  Deterministic dedup
└──────────────┬──────────────────┘
               │ pass
               ▼
         Registration created
```

**Fail-open design:** If Upstash Redis is unreachable, layers 2-4 are skipped and the request falls through to the DB lifetime cap (layer 5). This prevents a Redis outage from blocking all registrations while still maintaining abuse protection.

**Redis key design:** All keys are SHA-256 hashed (`dmv:email:{hash}`, `dmv:ip:{hash}`, `dmv:ip-email:{ipHash}:{emailHash}`). Neither emails nor IPs are stored in Redis as plaintext. Key prefixes don't collide with main site prefixes (`otp:email:`, etc.) on the shared Upstash instance.

**Rate limit responses:** 429 with `Retry-After` header (computed from Redis reset timestamp). 403 for lifetime cap (includes `current`, `limit`, `endorsed` fields in JSON body).

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
| `registration_type` | TEXT | INDIVIDUAL / ORGANIZATION / AGENT | Web UI uses first two, CLI/MCP uses AGENT |
| `full_name` | TEXT | Operator name | Required for INDIVIDUAL + ORG, optional for AGENT |
| `organization_name` | TEXT | Org name | Required for ORGANIZATION only |
| `domain_requested` | TEXT | `{name}.agent` | Not unique — pre-registration model |
| `email` | TEXT | User's email | Max 254 chars |
| `certificate_id` | TEXT | `WORD-XXX-XXXC` | Unique (partial index) |
| `signup_source` | TEXT | ui / cli / mcp / api | Tracks which entry point |
| `status` | TEXT | `provisional_dmv` | Always this value from DMV |
| `user_id` | UUID | NULL | Set by trigger, never by DMV |
| `metadata` | JSONB | `{ agent_description, client_ip }` | Description max 500 chars |
| `created_at` | TIMESTAMPTZ | Auto | |

### What the trigger sets

| Column | Value | Set by |
|--------|-------|--------|
| `user_id` | Auth user's UUID | `handle-dmv-registration` edge function |

### What the auth hub upgrades

| Column | Before | After |
|--------|--------|-------|
| `status` | `provisional_dmv` | `pending_profile` |

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

Validated server-side in `register-agent` (client-side validation mirrors this but is not trusted):

| Field | Rule |
|-------|------|
| `agent_name` | 3-32 chars, lowercase alphanumeric, hyphens allowed in middle, regex: `/^[a-z0-9][a-z0-9-]*[a-z0-9]$/` |
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
| Web UI (static) | Vercel | index.html + JS/CSS/fonts/models, no SSR |
| API routes (`/api/card`, `/api/og`) | Vercel Serverless + Edge | Card = Node.js (Canvas2D), OG = Edge (Satori) |
| Middleware | Vercel Edge | Permalink OG tags for crawlers only |
| Edge functions (register, lookup, badge) | Supabase Edge Functions (Deno) | Holds service role key |
| Database | Supabase PostgreSQL | RLS denies anon, service key bypasses |
| Rate limiting | Upstash Redis | Shared instance with agentcommunity.org |
| NPM package | npm registry | `@agentcommunity/dmv-agent` + `dmv-agent` alias |

## Security Model

```
Principle: never trust the client.

Client code:     validates → POST JSON → reads response
                 (no secrets, no DB access, just fetch())

Edge function:   validates again → rate limits → generates cert → INSERTs
                 (holds service role key, server-side authority)

Database:        RLS denies all anon access
                 (only reachable through edge function with service key)
```

No database credentials exist in any client code — web, CLI, MCP, or JS API. The only public-facing URL is the edge function endpoint, which validates and rate-limits everything.

---

## What's Implemented (DMV side, as of 2026-04-01)

Everything below is shipped in this repo and ready to deploy:

| Feature | Status | Where |
|---------|--------|-------|
| Redis triple rate limiting | Done | `supabase/functions/register-agent/index.ts` |
| Lifetime cap (3/10 per email) | Done | Same file |
| Fail-open Redis error handling | Done | Same file |
| `provisional_dmv` status on INSERT | Done | Same file |
| CORS restricted to known origins | Done | Same file |
| Input length validation (all fields) | Done | Same file |
| Retry-After on 429 responses | Done | Same file |
| Security headers (HSTS, X-Frame, nosniff) | Done | `vercel.json` |
| HTML edge caching + stale-while-revalidate | Done | `vercel.json` |
| API input validation (card/og routes) | Done | `api/card.js`, `api/og.js` |
| API stale-while-revalidate + maxDuration | Done | Same files |
| Badge cache 1h/24h | Done | `supabase/functions/badge/index.ts` |
| CLI fetch timeout (30s) + retry on 5xx | Done | `packages/dmv-agent/src/register.ts` |
| Web fetch timeout (15s) | Done | `js/supabase.js` |
| MCP rate limiting + operator required | Done | `packages/dmv-agent/src/mcp-server.ts` |
| Lockfile crash protection | Done | `packages/dmv-agent/src/rate-limit.ts` |
| SKILL.md operator docs fixed | Done | `packages/dmv-agent/skills/dmv/SKILL.md` |
| Render loop pauses when tab hidden | Done | `js/TV.js` |
| CRT scanline throttle in idle | Done | `js/CRTTerminal.js` |
| Dead code removed (CardPoster.js) | Done | Deleted |
| .vercelignore for dev artifacts | Done | `.vercelignore` |
| Fog leak fixed | Done | `js/TV.js` |

## What Needs Migration (main site / database)

These changes must happen on agentcommunity.org or in the shared Supabase database before or alongside DMV deployment:

### Required before DMV deploy

```sql
-- 1. Add provisional_dmv status enum value
ALTER TYPE registration_status ADD VALUE 'provisional_dmv';

-- 2. Add AGENT registration type (if not already present)
ALTER TYPE registration_type ADD VALUE 'AGENT';

-- 3. Add index for lifetime cap query
CREATE INDEX IF NOT EXISTS idx_registrations_email
  ON registrations (email);
```

### Required on main site (can ship separately)

**Auth hub upgrade flow:**

When a user signs in at agentcommunity.org via OTP, check for and upgrade any `provisional_dmv` registrations:

```sql
UPDATE registrations
SET status = 'pending_profile'
WHERE email = :user_email
  AND status = 'provisional_dmv';
```

This is the moment the user becomes a verified member. Should happen in the auth callback or post-sign-in hook.

**Member count exclusion:**

Any query that counts "members" must exclude `provisional_dmv`:

```sql
WHERE status != 'provisional_dmv'
```

Audit locations: admin stats API, directory/map data, homepage member count, any public-facing counts.

**Members dashboard:**

The agent cards section (`AgentCardsSection`) already supports real certificate data behind a feature flag (`NEXT_PUBLIC_SHOW_AGENT_CARDS`). When enabling:
- Fetch `certificate_id` from `user_domains` (not just `domain_name`)
- Render HoloCards for domains with cert IDs, placeholder for those without
- Card images come from DMV `/api/card?id=CERT-ID&name=agent-name`

**Certificate email:**

Update `handle-dmv-registration` edge function email to:
- Remove magic link (PKCE can't work server-initiated)
- CTA: "Sign in at agentcommunity.org to claim your certificate and join the community"
- Link to `https://agentcommunity.org/auth/sign-in`
- Mention endorsement: "Endorsed members can register up to 10 agent identities"
- Keep badge embed snippets and certificate details

## Deploy Order

1. Run SQL migrations on Supabase (`provisional_dmv` enum, `AGENT` enum, email index)
2. `supabase functions deploy register-agent` (Redis rate limiting + provisional_dmv)
3. `supabase functions deploy badge` (cache headers)
4. Push to Vercel (frontend perf + security headers + API hardening)
5. Ship main site auth hub upgrade (provisional_dmv → pending_profile on sign-in)
6. Ship main site member count exclusion
7. Enable `NEXT_PUBLIC_SHOW_AGENT_CARDS=true` on main site

Steps 1-4 can ship together. Steps 5-7 can ship later — `provisional_dmv` registrations will simply wait until the auth hub upgrade is deployed.

## Testing the Full Flow

1. Register via CLI: `bunx dmv-agent register --name test-agent --email you@example.com --operator "Your Name"`
2. Verify in DB: `status = 'provisional_dmv'`, `user_id` set by trigger
3. Check member count → should NOT include the new registration
4. Sign in at agentcommunity.org with the same email via OTP
5. Verify in DB: `status = 'pending_profile'`
6. Check member count → should NOW include the user
7. Check members dashboard → HoloCard should render with real certificate data
8. Test rate limiting: register 4 times rapidly → 4th should return 429
9. Test lifetime cap: register 4 unique agents with same email → 4th should return 403
