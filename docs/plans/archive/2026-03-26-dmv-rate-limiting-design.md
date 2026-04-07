# DMV Rate Limiting & Auth Hardening Design

**Date:** 2026-03-26
**Status:** Draft
**Context:** DMV launch targeting next week. Main site seeing ~30k visits/24h. Need to harden DMV registration against abuse, fix broken magic link PKCE flow, and ensure DMV registrations don't inflate member counts without email verification.

---

## Problem Statement

1. **Magic link PKCE failure:** `handle-dmv-registration` edge function calls Supabase's OTP endpoint server-side, so no `code_verifier` cookie exists in the user's browser. Every magic link click fails with "both auth code and code verifier should be non-empty."
2. **No lifetime cap:** A single email can mint unlimited certificates over time (current limits are only 3/email/hour and 10/IP/hour).
3. **No email verification gate:** DMV registrations create auth users and count as members immediately, even without email verification. Bots can inflate member counts.
4. **DB-based rate limiting:** Rate limit checks in `register-agent` hit Postgres on every request (including an unindexed JSONB extraction), which won't scale under abuse.
5. **MCP has no client-side rate limiting:** Relies entirely on server-side checks.
6. **AGENT registration type not in main site schema:** DMV supports AGENT type but the main site's `registration_type` enum only has INDIVIDUAL | ORGANIZATION.

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Magic link | **Drop entirely from DMV flow** | Server-initiated PKCE can't work. User signs in via OTP at agentcommunity.org instead. |
| Lifetime cap | **3 unendorsed / 10 endorsed per email** | Mirrors agentcommunity.org domain model. Checked server-side in edge function. |
| Unverified registrations | **New `provisional_dmv` status** | Distinct from `pending_profile` (which means verified but not endorsed). Doesn't count in member totals. |
| Rate limiting backend | **Upstash Redis** (same instance as main site) | Protects Supabase from query load under abuse. Proven pattern from main site OTP flow. |
| CAPTCHA | **Deferred to post-launch** | Lifetime cap + Redis rate limiting + provisional status provides sufficient launch protection. |
| Infrastructure | **Keep DMV on Vercel + Supabase** | Vercel WAF can't protect Supabase edge functions anyway. Edge function hardening is the real chokepoint. |
| AGENT registration type | **Add to main site schema** | Required for DMV agents to flow through auth hub on verification. |

---

## Architecture

### Registration Flow (Updated)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ENTRY POINTS                                 │
│   Web UI  ·  CLI  ·  MCP  ·  JS API  ·  Claude Code Skill          │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ POST
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│                  register-agent edge function                       │
│                                                                     │
│  1. Validate input (agent_name, email, type)                        │
│  2. Redis rate limit checks:                                        │
│     ├─ Per-email:    5 / 10 min                                     │
│     ├─ Per-IP:       10 / 10 min                                    │
│     └─ Per-IP+email: 3 / 10 min                                     │
│  3. Lifetime cap check (DB query, after rate limit passes):         │
│     ├─ SELECT COUNT(*) FROM registrations WHERE email = ?           │
│     ├─ Check endorsement status via user_domains/registrations      │
│     └─ Reject if >= 3 (unendorsed) or >= 10 (endorsed)             │
│  4. Generate certificate_id (deterministic FNV-1a + Luhn)           │
│  5. INSERT into registrations with status = 'provisional_dmv'       │
│  6. Return certificate + badge URLs                                 │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ DB trigger (certificate_id IS NOT NULL)
                           ▼
┌─────────────────────────────────────────────────────────────────────┐
│              handle-dmv-registration edge function                   │
│                                                                     │
│  1. Find or create auth user by email                               │
│  2. ██ REMOVED: No longer sends magic link ██                       │
│  3. Link registration row to auth user (user_id)                    │
│  4. Upsert domain into user_domains                                 │
│  5. Send certificate email (updated copy — see below)               │
└─────────────────────────────────────────────────────────────────────┘

                    ··· user decides to claim ···

┌─────────────────────────────────────────────────────────────────────┐
│              User visits agentcommunity.org                         │
│                                                                     │
│  1. Signs in via OTP (6-digit code to their email)                  │
│  2. Auth hub (/auth) detects provisional_dmv registration           │
│  3. Upgrades status: provisional_dmv → pending_profile              │
│  4. User now counts as a verified member                            │
│  5. Redirects to /members dashboard                                 │
└─────────────────────────────────────────────────────────────────────┘
```

### Rate Limiting Architecture (Updated)

```
                    Request arrives
                         │
                         ▼
              ┌─────────────────────┐
              │   Redis: per-email  │──→ 429 + Retry-After
              │   5 / 10 min       │
              └─────────┬───────────┘
                        │ pass
                        ▼
              ┌─────────────────────┐
              │   Redis: per-IP     │──→ 429 + Retry-After
              │   10 / 10 min      │
              └─────────┬───────────┘
                        │ pass
                        ▼
              ┌─────────────────────┐
              │ Redis: per-IP+email │──→ 429 + Retry-After
              │   3 / 10 min       │
              └─────────┬───────────┘
                        │ pass
                        ▼
              ┌─────────────────────┐
              │  DB: lifetime cap   │──→ 403 "limit reached"
              │  3 or 10 per email  │
              └─────────┬───────────┘
                        │ pass
                        ▼
                  Process registration
```

**Why this order:** Redis checks are sub-millisecond and reject most abuse before any DB query runs. The lifetime cap query only hits Postgres for requests that pass all rate limits — a small fraction under abuse.

---

## Schema Changes

### Migration: Add `provisional_dmv` to `registration_status` enum

```sql
-- Add provisional_dmv status for unverified DMV registrations
ALTER TYPE registration_status ADD VALUE 'provisional_dmv';
```

### Migration: Add `AGENT` to `registration_type` enum

```sql
-- Add AGENT type for DMV agent registrations
ALTER TYPE registration_type ADD VALUE 'AGENT';
```

### Indexes for rate limit fallback queries

```sql
-- Index for lifetime cap query (email lookup on registrations)
CREATE INDEX IF NOT EXISTS idx_registrations_email
  ON registrations (email);

-- Index for IP-based rate limiting (if DB fallback is ever needed)
CREATE INDEX IF NOT EXISTS idx_registrations_client_ip
  ON registrations ((metadata->>'client_ip'))
  WHERE metadata->>'client_ip' IS NOT NULL;
```

---

## Code Changes

### 1. `register-agent` edge function (DMV repo)

**File:** `supabase/functions/register-agent/index.ts`

Changes:
- **Add Upstash Redis imports** (`@upstash/ratelimit`, `@upstash/redis`)
- **Replace DB-based rate limiting** with Redis-based triple limiter (email, IP, IP+email)
- **Add lifetime cap check** after rate limits pass:
  ```typescript
  const { count } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .not('certificate_id', 'is', null)

  // Check if user is endorsed (has endorsement_status = 'signed' on any registration)
  const { data: endorsed } = await supabase
    .from('registrations')
    .select('endorsement_status')
    .eq('email', email)
    .eq('endorsement_status', 'signed')
    .limit(1)

  const cap = endorsed?.length ? 10 : 3
  if (count >= cap) {
    return new Response(JSON.stringify({
      error: `Certificate limit reached (${cap} max). Endorsed members can register up to 10.`,
      endorsed: !!endorsed?.length,
      current: count,
      limit: cap,
    }), { status: 403 })
  }
  ```
- **Set status to `provisional_dmv`** instead of `pending_profile` on INSERT
- **Add env vars:** `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`

### 2. `handle-dmv-registration` edge function (main repo)

**File:** `supabase/functions/handle-dmv-registration/index.ts`

Changes:
- **Remove magic link send** — delete the `POST /auth/v1/otp` call entirely (lines ~108-132)
- **Keep everything else:** auth user creation, registration row linking, domain upsert, certificate email send

### 3. Certificate email template

**File:** `supabase/functions/handle-dmv-registration/index.ts` (email HTML section)

Update the certificate email to:
- Remove any "verify your email" language (email is not verified at this stage)
- Add a clear CTA: "Sign in at agentcommunity.org to claim your certificate and join the community"
- Link to `https://agentcommunity.org/auth/sign-in`
- Mention endorsement: "Endorsed members can register up to 10 agent identities. Learn more at agentcommunity.org/members"
- Keep badge embed snippets and certificate details

### 4. Supabase magic link template (Dashboard)

The magic link email template in Supabase Dashboard is DMV-specific. Two options:
- **If magic link toggle can be disabled:** Turn off "Magic link" in Supabase Auth settings. OTP emails (6-digit code) are unaffected. **But** — verify this doesn't break any other flow that depends on magic links.
- **If magic link must stay enabled** (for future use): Leave the template as-is but it won't be triggered from DMV anymore since we're removing the server-side OTP call.

**Recommendation:** Leave the magic link toggle ON but don't call it from DMV. The template stays as a safety net for any future flow that might need it.

### 5. Auth hub (`app/(auth)/auth/page.tsx`)

**File:** `app/auth/page.tsx` (or wherever the auth hub server component lives)

Changes:
- Handle `provisional_dmv` status: when a user signs in and their registration has `status = 'provisional_dmv'`, upgrade it to `pending_profile`
- This is the moment the user becomes a verified member

### 6. Member count queries

Any query that counts "members" should exclude `provisional_dmv`:
```sql
WHERE status != 'provisional_dmv'
```

Audit locations:
- Admin stats API (`app/api/admin/stats/`)
- Directory/map data fetching
- Any marketing/count displays

### 7. DMV Web UI — rate limit UX

**File:** `js/supabase.js` (DMV repo)

Update error handling for the new 403 lifetime cap response:
- Show the cap limit and current count
- Mention endorsement path for higher limits
- Link to agentcommunity.org

### 8. DMV CLI — update for new responses

**File:** `packages/dmv-agent/src/register.ts`

- Handle 403 lifetime cap response (new error type)
- Display endorsement upgrade path in terminal output

---

## Environment Variables

### New env vars for `register-agent` edge function

| Variable | Value | Where |
|----------|-------|-------|
| `UPSTASH_REDIS_REST_URL` | Same as main site | Supabase Edge Function secrets |
| `UPSTASH_REDIS_REST_TOKEN` | Same as main site | Supabase Edge Function secrets |

Set via: `supabase secrets set UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=...`

---

## Rate Limit Configuration

### Redis-based limits (register-agent)

| Limiter | Key pattern | Limit | Window | Rationale |
|---------|-------------|-------|--------|-----------|
| Per-email | `dmv:email:{sha256(email)}` | 5 | 10 min | Prevent email-based spam |
| Per-IP | `dmv:ip:{sha256(ip)}` | 10 | 10 min | Prevent IP-based spam (shared IPs need headroom) |
| Per-IP+email | `dmv:ip-email:{sha256(ip)}:{sha256(email)}` | 3 | 10 min | Tightest per-session limit |

### DB-based lifetime cap

| Check | Limit (unendorsed) | Limit (endorsed) | Query |
|-------|--------------------|--------------------|-------|
| Certificates per email | 3 | 10 | `SELECT COUNT(*) FROM registrations WHERE email = ? AND certificate_id IS NOT NULL` |

### Existing CLI client-side limit (unchanged)

| Check | Limit | Window | Mechanism |
|-------|-------|--------|-----------|
| Per-machine | 3 | 24h | `~/.dmv-agent/registrations.json` lockfile |

---

## Members Dashboard — DMV Card Integration

### What Already Exists

The members dashboard has **comprehensive DMV card support already built**, gated behind the `NEXT_PUBLIC_SHOW_AGENT_CARDS` feature flag:

| Component | File | Status |
|-----------|------|--------|
| `AgentCardsSection` | `features/members/components/dashboard/agent-cards-section.tsx` | Built, uses mock data |
| `HoloCard` | `features/members/components/shared/holo-card.tsx` | Built, CSS 3D tilt + holo overlays |
| `PlaceholderCard` | Inside `holo-card.tsx` | Built, terminal aesthetic matching DMV |
| Dashboard integration | `features/members/components/dashboard/dashboard-v2.tsx` line 326 | Wired up, receives `domains` prop |
| DMV CTA button | Inside `agent-cards-section.tsx` | Built, neon green, links to dmv.agentcommunity.org |

**The `HoloCard` component is a CSS-based 3D effect wrapper** — it doesn't use the DMV's Three.js rendering. Instead it:
- Applies mouse-tracking tilt (±15°) with perspective
- Overlays radial glow + rainbow holo stripe + vignette
- Can render either a real card image (from DMV `/api/card`) or a `PlaceholderCard`

**The DMV's full 3D card (Three.js + WebGL)** is tightly coupled to the DMV site and can't be easily embedded. The recommended approach — already implemented — is:
1. Render a static card image from DMV's `/api/card?id=CERT-ID&name=agent` endpoint
2. Wrap it in the `HoloCard` component for CSS-based 3D effects on hover
3. Click opens the full DMV permalink page (`dmv.agentcommunity.org/c/CERT-ID/agent-name`)

### What Needs to Change

#### 1. Fetch real certificate data instead of mocks

**File:** `features/members/hooks/useMembersDashboard.ts` (lines 295-299)

Currently fetches only `domain_name` from `user_domains`. Needs to also fetch `certificate_id` and `agent_description`:

```typescript
// Before:
const { data: userDomains } = await supabase
  .from('user_domains')
  .select('domain_name')
  .eq('user_id', userId)
  .order('created_at', { ascending: true });

// After:
const { data: userDomains } = await supabase
  .from('user_domains')
  .select('domain_name, certificate_id, agent_description, source')
  .eq('user_id', userId)
  .order('created_at', { ascending: true });
```

The `DashboardRegistration` type and domain mapping need updating to carry certificate data through to `AgentCardsSection`.

#### 2. Swap mock data for real certificates

**File:** `features/members/components/dashboard/agent-cards-section.tsx`

- Remove `MOCK_CERTIFICATES` constant
- Accept full domain objects (with `certificate_id`) instead of `Array<string>`
- Filter domains: those with `certificate_id` → render as `HoloCard`, others → show in "awaiting verification" section
- Uncomment `cardImageUrl` line to use real DMV card images:
  ```typescript
  cardImageUrl={`https://dmv.agentcommunity.org/api/card?id=${cert.certId}&name=${cert.domain.replace('.agent', '')}`}
  ```

#### 3. Enable the feature flag

When DMV launches, set in Vercel dashboard or `.env.local`:
```
NEXT_PUBLIC_SHOW_AGENT_CARDS=true
```

### Card Rendering Strategy

The DMV's `/api/card` endpoint returns a static 880×630 PNG with the full card design (identicon, QR code, certificate details, deterministic palette/rarity). All card traits are computed deterministically from agent name — no database needed.

```
Members dashboard                          DMV
┌──────────────────────┐          ┌─────────────────────────┐
│ HoloCard (CSS 3D)    │          │ /api/card?id=X&name=Y   │
│  ├─ tilt on hover    │ ◄─ img ─│  └─ Canvas2D render     │
│  ├─ rainbow overlay  │          │     └─ Identicon + QR   │
│  ├─ radial glow      │          │     └─ Deterministic    │
│  └─ click → DMV link │          │        palette/traits   │
└──────────────────────┘          └─────────────────────────┘
```

No need to duplicate the DMV rendering in the main site. `HoloCard` wraps the image; DMV is the source of truth for card visuals.

---

## Upstash Redis — Infrastructure Status

### Already configured on agentcommunity.org

| Item | Status |
|------|--------|
| `@upstash/ratelimit@^2.0.6` | Installed in `package.json` |
| `@upstash/redis@^1.35.1` | Installed in `package.json` |
| `UPSTASH_REDIS_REST_URL` | Set in `.env.local` |
| `UPSTASH_REDIS_REST_TOKEN` | Set in `.env.local` |
| `lib/rate-limit.ts` | Working, uses `Redis.fromEnv()` |
| `lib/auth/rate-limit.ts` | Working, triple OTP limiter |

### Needed for DMV edge function

The `register-agent` edge function runs on Supabase (Deno), not Vercel. It needs:

1. **Deno-compatible Upstash packages** — `@upstash/ratelimit` and `@upstash/redis` both support Deno via npm specifiers or esm.sh imports
2. **Set secrets on Supabase:**
   ```bash
   supabase secrets set UPSTASH_REDIS_REST_URL="<same URL as main site>"
   supabase secrets set UPSTASH_REDIS_REST_TOKEN="<same token as main site>"
   ```
3. **Same Redis instance** — share the main site's Upstash Redis. Key prefixes (`dmv:email:`, `dmv:ip:`, `otp:email:`, etc.) prevent collision.

No new Upstash account or Redis instance needed. Just add the existing credentials to Supabase secrets.

---

## What This Does NOT Cover (Post-Launch)

- **CAPTCHA (Cloudflare Turnstile):** Can be added to web UI later if bot abuse is observed. Would require server-side token verification in edge function.
- **Cloudflare proxy:** Would require DNS migration from Vercel. Not feasible pre-launch.
- **Email domain blocklisting:** Block disposable email providers (mailinator, etc.) at the edge function level.
- **Admin review queue:** Manual approval for registrations that look suspicious.
- **Certificate revocation:** Ability to invalidate issued certificates.
- **Supabase custom domain:** Would allow putting Cloudflare in front of Supabase API.

---

## Implementation Order

### Phase 1: Database & Backend (DMV repo + main repo edge functions)
1. **Schema migrations** — `provisional_dmv` status + `AGENT` type + indexes
2. **Set Upstash Redis secrets** on Supabase (`supabase secrets set`)
3. **`register-agent` hardening** — Redis rate limiting + lifetime cap + `provisional_dmv` status
4. **`handle-dmv-registration` fix** — Remove magic link, update certificate email with sign-in CTA + endorsement mention

### Phase 2: agentcommunity.org (main repo)
5. **Auth hub update** — Handle `provisional_dmv` → `pending_profile` upgrade on sign-in
6. **Members dashboard** — Fetch `certificate_id` from `user_domains`, swap mock data for real certs in `AgentCardsSection`
7. **Member count audit** — Exclude `provisional_dmv` from admin stats, directory, any public counts
8. **Enable feature flag** — `NEXT_PUBLIC_SHOW_AGENT_CARDS=true` in Vercel dashboard

### Phase 3: DMV Client Updates (DMV repo)
9. **Web UI** — Handle 403 lifetime cap response, show endorsement upgrade path
10. **CLI + MCP** — Handle 403 response, display cap info in terminal output

### Phase 4: Deploy & Verify
11. **Deploy edge functions** — `register-agent`, `handle-dmv-registration`
12. **Deploy main site** — auth hub + members dashboard changes
13. **End-to-end testing** — full flow from DMV mint → certificate email → sign-in → dashboard

---

## Testing Plan

### Rate Limiting & Registration
- [ ] Register via web UI → receives certificate email without magic link
- [ ] Register via CLI → respects Redis rate limits, shows lifetime cap error at limit
- [ ] Register via MCP → same server-side protections apply
- [ ] Same email registers 4th time (unendorsed) → 403 with cap message and endorsement path
- [ ] Endorsed member registers up to 10 → succeeds
- [ ] Rapid-fire requests → Redis rate limiting returns 429 before hitting DB
- [ ] Certificate email includes sign-in CTA and endorsement mention

### Auth & Verification Flow
- [ ] New DMV user signs in at agentcommunity.org via OTP → status upgrades `provisional_dmv` → `pending_profile`
- [ ] Unverified DMV registrations (`provisional_dmv`) don't appear in member counts
- [ ] Auth hub handles AGENT registration type correctly
- [ ] No magic link is sent from `handle-dmv-registration`

### Members Dashboard
- [ ] Feature flag `NEXT_PUBLIC_SHOW_AGENT_CARDS=true` → Agent Cards section visible
- [ ] Cards display real certificate data from `user_domains` (not mock data)
- [ ] Card images load from DMV `/api/card` endpoint (or placeholder if endpoint not ready)
- [ ] Click on card → opens DMV permalink in new tab
- [ ] Domains without `certificate_id` show in "awaiting verification" section
- [ ] DMV CTA button links to dmv.agentcommunity.org
- [ ] HoloCard 3D tilt + holo effects work on hover
- [ ] Responsive: cards stack on mobile, side-by-side on desktop
