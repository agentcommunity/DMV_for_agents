# DMV API Hardening Plan — `/api/register` proxy + shared rate limits with `agentCommunity_PAGE`

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans`. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal.** Move the `register-agent` endpoint behind the DMV Cloudflare Worker so browser traffic gets **Invisible Turnstile** + CF-native rate limiting + origin-pinning protection, while preserving the direct-Supabase path for older CLI clients during a staged rollout. **Align all rate limiting with `agentCommunity_PAGE` by sharing CF Rate Limiting namespace IDs at the account level** — one counter, two properties — and **delete Upstash from DMV entirely** in the process.

**Architecture.** Adds a new `/api/register` handler to `worker/index.ts` that forwards to the existing Supabase `register-agent` edge function. New clients (browser + latest CLI) POST to `/api/register`; old clients keep hitting Supabase direct for a version window. After adoption, the Supabase-direct path gets an origin check that closes the bypass (Task 11, deferred). Invisible-mode Turnstile protects the browser path without any visible UI because the CRT canvas is incompatible with an iframe. A KV-backed cooldown (vendored from PAGE) handles the 24h per-fingerprint limit that CF native can't express. Upstash is removed from the Supabase edge function — the SQL lifetime cap (`3 unendorsed / 10 endorsed per email`) stays as the Supabase-layer floor.

**Tech Stack.** Cloudflare Workers (existing), Cloudflare Workers Rate Limiting API (SHARED namespace IDs with `agentCommunity_PAGE`), Cloudflare Workers KV (shared `KV_RATE_LIMIT` namespace with PAGE for long-window cooldown counters), Cloudflare Turnstile (Invisible widget mode). **No Upstash anywhere in DMV after this plan lands.**

---

## Preamble — read before starting

**Required reading (in order):**
1. `CLAUDE.md` — project overview.
2. `CLOUDFLARE.md` — updated 2026-04-07 post-hardening, describes the existing Worker topology.
3. `docs/plans/archive/2026-04-07-cf-native-hardening.md` — the prior plan. Pay particular attention to Task 5 (Workers Rate Limiting) and Task 6 (KV badge cache) — this plan reuses their binding-addition + handler-dispatch patterns.
4. `supabase/functions/register-agent/index.ts` (363 lines) — the current Supabase edge function.
5. `js/supabase.js` — the browser client (70 lines).
6. `packages/dmv-agent/src/register.ts` — the CLI client (97 lines).
7. `AUTH_DMV.md` — the broader auth integration flow.
8. **Rate-limit pattern references in `agentCommunity_PAGE`** (sibling repo at `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE`):
   - `lib/rate-limit-cf.ts` — the shim DMV is vendoring + adapting in Task 0.
   - `lib/rate-limit-kv.ts` — the KV cooldown helpers DMV is vendoring + adapting in Task 0.
   - `lib/utils/normalize-email.ts` — vendored verbatim into DMV.
   - `lib/auth/rate-limit.ts` — the OTP rate-limit callsite DMV mirrors in Task 2 for the register path.
   - `wrangler.jsonc` lines 27-55 — the authoritative `ratelimits` + `kv_namespaces` + `analytics_engine_datasets` config for PAGE. DMV's Task 1 config mirrors the namespace IDs exactly.

**What's NEW and what's PRESERVED:**
- **NEW:** `/api/register` worker route with Invisible Turnstile + CF-native rate limiting + upstream forwarding.
- **NEW:** Four **SHARED** CF Rate Limiting bindings — `RL_AUTH` (namespace_id `4001`), `RL_OTP_EMAIL` (`4005`), `RL_OTP_IP` (`4006`), `RL_OTP_IP_EMAIL` (`4007`) — all matching `agentCommunity_PAGE`'s namespace IDs. Sharing the namespace_id at the CF account level means both Workers increment the **same counter** per key, so an attacker can't rotate between `dmv.agentcommunity.org` and `agentcommunity.org` to double their attempts.
- **NEW:** DMV-only CF Rate Limiting binding **renamed**: `API_RATE_LIMITER` (namespace 1001, 100 req/60s) is renamed to `RL_CARDS` for convention alignment with PAGE's `RL_*` naming. The namespace_id stays `1001` (DMV-only — PAGE doesn't render cards). **This is a rename-only refactor with zero behavior change**, landed in Task 0 as a separate commit ahead of everything else.
- **NEW:** Vendored rate-limit shim at `worker/rate-limit-cf.ts` — adapted from `agentCommunity_PAGE/lib/rate-limit-cf.ts` for DMV's plain-Worker env (PAGE uses `@opennextjs/cloudflare`'s `getCloudflareContext()` which DMV doesn't have, so the DMV version takes `env` as an explicit parameter). Exports `tryCfRateLimit(env, bindingName, key)` returning `true | false | null`.
- **NEW:** Vendored KV cooldown helpers at `worker/rate-limit-kv.ts` — adapted from `agentCommunity_PAGE/lib/rate-limit-kv.ts`. Exports `incrementKvCooldown(kv, key, threshold, cooldownSeconds)` used by `handleRegister` for the 24h per-fingerprint cooldown.
- **NEW:** Vendored `worker/normalize-email.ts` — byte-identical copy of `agentCommunity_PAGE/lib/utils/normalize-email.ts` so DMV's email-hash keys collide with PAGE's in the shared namespace.
- **NEW:** Feature flag `USE_CF_RATE_LIMIT` — Worker environment variable. When `"true"`, the CF-native rate-limit path is active. When unset or anything else, `tryCfRateLimit()` returns `null`. DMV will default it to `"true"` in `wrangler.jsonc` `vars` (not secrets) so there's no per-deploy friction, but the flag exists for instant kill-switch via `wrangler secret put USE_CF_RATE_LIMIT --text false` without a redeploy.
- **NEW:** Browser Turnstile widget in **Invisible widget mode** (configured in Cloudflare dashboard). Zero UI ever renders, zero CRT scene disturbance. Widget mounts off-screen in `#turnstile-container`, Promise-wrapped `executeTurnstile()` handles the silent verification.
- **NEW:** "Bot protection by Cloudflare Turnstile" attribution in the page footer (Turnstile ToS).
- **NEW:** Analytics tier vocabulary aligned with PAGE — DMV's Worker emits `tier: 'rate_limited'` (snake_case) for rate-limit block events instead of the previous `'429'` label. DMV keeps its own `dmv_worker_events` dataset separate from PAGE's `AGENTCOMMUNITY_EVENTS`, but the vocabulary overlaps for cross-dashboard readability.
- **REMOVED:** All Upstash Redis usage from `supabase/functions/register-agent/index.ts`. The `@upstash/ratelimit` and `@upstash/redis` imports, the `createRateLimiters()` factory, the `_limiters` singleton, and the `checkRateLimit(email, ip)` function are all deleted in Task 3. The SQL lifetime cap (`3 unendorsed / 10 endorsed per email`) stays as the Supabase-layer floor.
- **PRESERVED:** Certificate ID generation, database schema, email flow, the `on_dmv_registration` trigger, and the R2/Container card-render path. This plan only touches rate limiting, the `/api/register` route, and Turnstile.
- **PRESERVED:** Existing machine fingerprint generation in `packages/dmv-agent/src/rate-limit.ts` (the CLI-side SHA-256 of hostname+user+platform and the local lockfile at `~/.dmv-agent/registrations.json`). The server-side fingerprint cooldown moves from Supabase/Upstash → DMV Worker/KV, but the client-side fingerprint computation is unchanged.

**Hard constraints:**
- **Do NOT break existing CLI users.** `bunx dmv-agent` installations in the wild hit Supabase direct. Support dual paths for at least 2 weeks before closing the bypass.
- **Do NOT require Turnstile for the CLI.** Headless environments can't solve CAPTCHAs. CLI uses `machine_fingerprint` (verified server-side via KV cooldown in Task 2).
- **Do NOT add any new runtime dependencies** to the worker or browser (no npm installs).
- **Supabase Edge Functions use Deno** — any server-side changes use Deno-compatible imports (`https://esm.sh/...`), not Node.
- **Verification is manual smoke + `wrangler tail`** — there are no automated Worker tests by design in DMV.
- **Don't touch** the CF-native hardening work from the 2026-04-07 plan. This plan is additive on top.
- **Do NOT invent new namespace IDs for the shared limiters.** The four shared bindings MUST use the exact numeric values `4001`, `4005`, `4006`, `4007`. These are the `namespace_id` values PAGE uses in `agentCommunity_PAGE/wrangler.jsonc` lines 31–37 as of 2026-04-08. If PAGE's values have changed, verify and update both DMV and the drift-check script in Task 10.
- **Do NOT skip the vendored-file header comments** that identify each file as a vendor from PAGE + the exact source path. Those comments are tripwires for future coupling drift (see the self-review notes).

**Execution order:**
- **Task 0** (vendor shims + rename `API_RATE_LIMITER` → `RL_CARDS`) MUST ship first. It's a pure refactor with no behavior change; verifiable in isolation via the existing card-path smoke tests.
- **Task 1** (wrangler bindings + Turnstile site key + feature flag) runs second and builds on Task 0's rename.
- **Tasks 2–3** (worker `handleRegister` + Supabase Upstash removal) are independent by file but interact at deploy time. Sequence them Task 2 → Task 3 during implementation so we can smoke Task 2's new path before removing Task 3's bridge protection.
- **Tasks 4–5** (browser HTML + JS) follow Task 2.
- **Task 6** (CLI update) follows Task 2.
- **Task 7** (MCP inheritance check) follows Task 6.
- **Task 8** (local smoke) gates Task 9 (deploy).
- **Task 9** deploy order: Worker first (adds protection), then Supabase edge function (removes Upstash), then CLI publish.
- **Task 10** (docs) runs after deploy and includes the drift-check addition.
- **Task 11** (Supabase bypass closure) is **explicitly deferred** — do NOT run it until 2+ weeks after Task 9 deploys and CLI adoption is confirmed.

---

## File Structure

| File | Task(s) | Responsibility |
|---|---|---|
| `worker/rate-limit-cf.ts` | 0 | NEW. Vendored + adapted from `agentCommunity_PAGE/lib/rate-limit-cf.ts`. Exports `tryCfRateLimit(env, bindingName, key)` → `true \| false \| null`. Takes `env` as an explicit parameter (PAGE uses `getCloudflareContext()` which DMV doesn't have). Gated by `env.USE_CF_RATE_LIMIT === 'true'`. |
| `worker/rate-limit-kv.ts` | 0 | NEW. Vendored + adapted from `agentCommunity_PAGE/lib/rate-limit-kv.ts`. Exports `incrementKvCooldown(kv, key, threshold, cooldownSeconds)` and `checkKvBucketLimit(kv, key, limit, windowSeconds)`. Takes `kv: KVNamespace` as an explicit parameter. |
| `worker/normalize-email.ts` | 0 | NEW. Byte-identical copy of `agentCommunity_PAGE/lib/utils/normalize-email.ts`. Exports `normalizeEmail()` and `normalizeEmailDeep()`. |
| `wrangler.jsonc` | 0, 1 | Task 0 renames the existing `API_RATE_LIMITER` binding to `RL_CARDS`. Task 1 adds four new shared bindings (`RL_AUTH`, `RL_OTP_EMAIL`, `RL_OTP_IP`, `RL_OTP_IP_EMAIL`), adds the `KV_RATE_LIMIT` KV binding (shared namespace id with PAGE), adds `TURNSTILE_SITE_KEY` + `USE_CF_RATE_LIMIT` vars. |
| (wrangler secret) | 1 | `TURNSTILE_SECRET_KEY` — already installed via Cloudflare dashboard on 2026-04-08, sub-agent skips. |
| `worker/index.ts` | 0, 2 | Task 0 renames every `env.API_RATE_LIMITER.*` call to `env.RL_CARDS.*` and swaps the inline `.limit()` call for `tryCfRateLimit(env, 'RL_CARDS', key)`. Task 2 adds the `handleRegister` handler with the multi-layer CF + KV limiter pattern, the Turnstile verify helper, the upstream forward, and dispatches `/api/register` from the main `fetch`. |
| `supabase/functions/register-agent/index.ts` | 3 | DELETES all Upstash imports, the `createRateLimiters()` + `_limiters` singleton, the `checkRateLimit()` function, and the `checkRateLimit(email, ip)` call in the handler. Keeps the SQL lifetime cap (3 unendorsed / 10 endorsed per email). Adds a minimal `x-dmv-proxy: v1` sentinel check in Task 11 (deferred). |
| `index.html` | 4 | Adds Turnstile API script tag, off-screen `#turnstile-container` mount div, `dmv-turnstile-site-key` meta tag, footer attribution line. |
| `public/_headers` | 4 | CSP additions: `https://challenges.cloudflare.com` in `script-src` + `connect-src` + new `frame-src`. Preserves the `blob:` tokens from commit `65b82e4`. |
| `worker/index.ts` `PERMALINK_CSP` | 4 | Same CSP additions as `public/_headers` — the two strings must stay byte-identical. |
| `js/supabase.js` | 5 | `REGISTER_ENDPOINT` → `/api/register`. `insertRegistration()` signature extended to accept a Turnstile token as the third argument. |
| `js/CRTTerminal.js` | 5 | Invisible Turnstile mount lifecycle: `mountTurnstileWidget()`, `executeTurnstile()`, `resetTurnstile()`. Called from the form's review/submit phase. |
| `packages/dmv-agent/src/register.ts` | 6 | `REGISTER_ENDPOINT` → `https://dmv.agentcommunity.org/api/register` with `DMV_API_ENDPOINT` env override. |
| `packages/dmv-agent/package.json` | 6 | Version bump `0.1.0` → `0.2.0`. |
| `packages/dmv-agent-alias/package.json` | 6 | Version bump `0.1.0` → `0.2.0`, dependency range `>=0.1.0` → `>=0.2.0`. |
| `CLOUDFLARE.md` | 10 | Operational notes: `/api/register` proxy, shared rate-limit namespaces with PAGE, the drift-check script. Removes the "API hardening" known gap bullet. |
| `ARCHITECTURE.md` | 10 | Rate limiting section: update Layer 0 scope to reflect shared namespaces, remove the Upstash layer entries from the register-agent path. |

---

## Task 0: Vendor PAGE's rate-limit shim + rename `API_RATE_LIMITER` → `RL_CARDS`

**Why this task exists and why it's first.** The Option E alignment chosen on 2026-04-08 makes PAGE's rate-limit pattern the canonical one across AgentCommunity Cloudflare Workers. DMV should adopt the same shim, the same KV helpers, the same feature flag, and the same naming convention. Task 0 lands this as a **pure refactor** — zero behavior change on the card-render path — so the rest of the plan can build on the shim without mixing refactor and new-feature diffs in the same commits.

**Files:**
- NEW: `worker/rate-limit-cf.ts`
- NEW: `worker/rate-limit-kv.ts`
- NEW: `worker/normalize-email.ts`
- Modify: `worker/index.ts` — rename every `env.API_RATE_LIMITER` reference to `env.RL_CARDS`, swap the inline `.limit({ key })` call for `tryCfRateLimit(env, 'RL_CARDS', key)`, extend the `Env` interface with the new binding name
- Modify: `wrangler.jsonc` — rename the existing `ratelimits` entry from `API_RATE_LIMITER` to `RL_CARDS` (only the `name` field; `namespace_id: "1001"` and `simple: { limit: 100, period: 60 }` unchanged)
- Modify: `wrangler.jsonc` `vars` — add `"USE_CF_RATE_LIMIT": "true"` so the shim returns booleans instead of null. Add a JSONC comment noting the flag exists for instant rollback via `wrangler secret put USE_CF_RATE_LIMIT --text false`

### Step 1: Create `worker/rate-limit-cf.ts`

Content — adapted from `agentCommunity_PAGE/lib/rate-limit-cf.ts` with the `getCloudflareContext()` bits replaced by explicit `env` passing:

```ts
// worker/rate-limit-cf.ts
//
// VENDORED FROM: agentCommunity_PAGE/lib/rate-limit-cf.ts (as of 2026-04-08)
// ADAPTED: PAGE uses @opennextjs/cloudflare's getCloudflareContext() to read
// env/ctx from the Next.js async-local-storage context. DMV's plain Cloudflare
// Worker doesn't have that helper, so tryCfRateLimit() takes env as its first
// parameter instead. Behavior is otherwise identical.
//
// ⚠ COUPLING NOTE: The four shared namespace IDs (4001 for RL_AUTH, 4005 for
// RL_OTP_EMAIL, 4006 for RL_OTP_IP, 4007 for RL_OTP_IP_EMAIL) MUST match
// agentCommunity_PAGE/wrangler.jsonc. If PAGE changes them, DMV silently
// drifts out of the shared counter. See the drift-check script in
// CLOUDFLARE.md Operational notes (Task 10) for how this is guarded.
//
// Re-vendor this file if PAGE's version materially changes by running:
//   diff /path/to/agentCommunity_PAGE/lib/rate-limit-cf.ts \
//        /path/to/AgentCommunity_DMV/worker/rate-limit-cf.ts
// and reconciling the diff.

import type { Env } from './index';

/**
 * Cloudflare Workers Rate Limiting binding shim.
 *
 *   - true   → allowed by CF (request may proceed)
 *   - false  → blocked by CF (return 429)
 *   - null   → shim is disabled / binding missing / errored — caller decides
 *              what to do. In DMV we treat null as "rate limiting is
 *              disabled, allow the request" because there's no legacy
 *              Upstash fallback to drop through to (unlike PAGE which has
 *              a transitional Upstash path during its Phase 6 migration).
 *
 * Gated behind `env.USE_CF_RATE_LIMIT === 'true'` so the feature can be
 * flipped on/off via `wrangler secret put USE_CF_RATE_LIMIT --text false`
 * without a redeploy. The default value in wrangler.jsonc `vars` is "true",
 * so normal deploys are protected.
 */

type RateLimitBindingName =
  | 'RL_CARDS'
  | 'RL_AUTH'
  | 'RL_OTP_EMAIL'
  | 'RL_OTP_IP'
  | 'RL_OTP_IP_EMAIL';

interface CFRateLimiter {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

function isFeatureEnabled(env: Env): boolean {
  return env.USE_CF_RATE_LIMIT === 'true';
}

export async function tryCfRateLimit(
  env: Env,
  bindingName: RateLimitBindingName,
  key: string,
): Promise<boolean | null> {
  if (!isFeatureEnabled(env)) {
    return null;
  }

  try {
    const binding = (env as unknown as Record<string, CFRateLimiter | undefined>)[bindingName];
    if (!binding) {
      // Binding not provisioned (local dev without bindings) — fall through.
      return null;
    }
    const result = await binding.limit({ key });
    return result.success === true;
  } catch (error) {
    console.warn(`[rate-limit-cf] ${bindingName} failed:`, error);
    return null;
  }
}
```

### Step 2: Create `worker/rate-limit-kv.ts`

Content — adapted from `agentCommunity_PAGE/lib/rate-limit-kv.ts`:

```ts
// worker/rate-limit-kv.ts
//
// VENDORED FROM: agentCommunity_PAGE/lib/rate-limit-kv.ts (as of 2026-04-08)
// ADAPTED: Takes kv: KVNamespace as an explicit parameter instead of pulling
// it from getCloudflareContext(). Behavior otherwise identical.
//
// ⚠ COUPLING NOTE: The KV namespace ID c0e0d88fff1a4c59805ab85c7a03100f is
// SHARED with agentCommunity_PAGE. DMV uses the "dmv:rl:fp:*" prefix for
// its fingerprint cooldown keys; PAGE uses "otp:*" prefixes — no collision.
// If PAGE's KV_RATE_LIMIT namespace id changes, DMV silently drifts to its
// own isolated keyspace. See the drift-check script in CLOUDFLARE.md.

/**
 * Workers KV-backed rate-limit primitives for windows that exceed CF Rate
 * Limiting's 60-second period ceiling.
 *
 * Two flavours:
 *   - incrementKvCooldown: counter that triggers a cooldown when threshold
 *     is hit. Used for DMV's 3-per-fingerprint-per-24h register cooldown.
 *   - checkKvBucketLimit: bucket counter that allows up to N in W seconds.
 *     Not used by DMV yet — included for future symmetry with PAGE.
 *
 * Both functions:
 *   - Fail OPEN: if KV is down or the binding is missing, requests are
 *     allowed. The CF Rate Limiting bindings (60s burst stop) provide a
 *     hard backstop against abuse during KV outages.
 *   - KV read-modify-write is NOT atomic. Concurrent requests from the same
 *     key can both read the same count and both write count+1, allowing
 *     one extra request through. The drift is constant-factor, not
 *     multiplicative, and acceptable for anti-abuse use cases.
 */

/**
 * OTP-style cooldown: increments a counter and returns cooldown seconds once
 * the counter reaches `threshold`. Returns null if below threshold or on
 * error (fail-open).
 *
 * The counter TTL is `cooldownSeconds`. After the TTL elapses, the counter
 * resets and the user can try again.
 *
 * IMPORTANT: Once threshold is hit, do NOT refresh the TTL. Refreshing
 * would restart the cooldown on every retry, trapping any user who retries
 * more often than the window in a permanent lockout.
 */
export async function incrementKvCooldown(
  kv: KVNamespace,
  key: string,
  threshold: number,
  cooldownSeconds: number,
): Promise<number | null> {
  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) : 0;

    // Already at or past threshold: return cooldown WITHOUT refreshing TTL.
    if (count >= threshold) {
      return cooldownSeconds;
    }

    const next = count + 1;
    await kv.put(key, String(next), { expirationTtl: cooldownSeconds });
    if (next >= threshold) {
      return cooldownSeconds;
    }
    return null;
  } catch (error) {
    console.warn('[rate-limit-kv] incrementKvCooldown failed:', error);
    return null;
  }
}

/**
 * Bucket counter: returns true if `key` has fewer than `limit` in the
 * current `windowSeconds` window, false if it has hit the limit.
 * Fails OPEN: returns true on KV errors.
 */
export async function checkKvBucketLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<boolean> {
  try {
    const current = await kv.get(key);
    const count = current ? parseInt(current, 10) : 0;
    if (count >= limit) {
      return false;
    }
    await kv.put(key, String(count + 1), { expirationTtl: windowSeconds });
    return true;
  } catch (error) {
    console.warn('[rate-limit-kv] checkKvBucketLimit failed:', error);
    return true;
  }
}
```

### Step 3: Create `worker/normalize-email.ts`

**Byte-identical copy** of `agentCommunity_PAGE/lib/utils/normalize-email.ts`. Do not modify. The coupling of this file is intentional — both DMV and PAGE hash the same normalized form so their shared-namespace counters land on the same keys.

```ts
// worker/normalize-email.ts
//
// VENDORED VERBATIM FROM: agentCommunity_PAGE/lib/utils/normalize-email.ts
// (as of 2026-04-08)
//
// ⚠ COUPLING NOTE: This file MUST stay byte-identical to PAGE's version.
// DMV and PAGE hash email-based rate-limit keys using normalizeEmail();
// if the normalization drifts between repos, the shared-namespace counter
// in RL_OTP_EMAIL (ns 4005) silently splits into two disjoint keyspaces
// and cross-property counting stops working. Re-vendor on PAGE changes:
//   cp /path/to/agentCommunity_PAGE/lib/utils/normalize-email.ts \
//      /path/to/AgentCommunity_DMV/worker/normalize-email.ts

/**
 * Basic email normalization: trim + lowercase.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * Deep normalization: basic + Gmail dot removal.
 * Use for matching/dedup where Gmail aliases should resolve to the same address.
 */
export function normalizeEmailDeep(email?: string | null): string | null {
  if (!email || typeof email !== 'string') return null
  const trimmed = email.trim().toLowerCase()
  const atIndex = trimmed.indexOf('@')
  if (atIndex === -1) return trimmed
  const local = trimmed.slice(0, atIndex)
  const domain = trimmed.slice(atIndex + 1)
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    return `${local.replace(/\./g, '')}@${domain}`
  }
  return trimmed
}
```

### Step 4: Rename `API_RATE_LIMITER` → `RL_CARDS` in `wrangler.jsonc`

**Pre-read:** `grep -n 'API_RATE_LIMITER\|RL_CARDS\|ratelimits' wrangler.jsonc` to find the current state.

The existing entry (after the 2026-04-07 plan landed) looks like:
```jsonc
"ratelimits": [
  {
    "name": "API_RATE_LIMITER",
    "namespace_id": "1001",
    "simple": { "limit": 100, "period": 60 }
  }
],
```

Change **only the `name` field**, keeping everything else identical:
```jsonc
"ratelimits": [
  {
    "name": "RL_CARDS",
    "namespace_id": "1001",
    "simple": { "limit": 100, "period": 60 }
  }
],
```

Do NOT change `namespace_id` — it stays `"1001"` because this counter is DMV-specific (card rendering, not shared with PAGE). The `RL_*` naming convention is adopted purely for readability alignment with PAGE.

Also in the same file, add `"USE_CF_RATE_LIMIT": "true"` to the `vars` block alongside the existing `PREWARM_ORIGIN`:

```jsonc
"vars": {
  "PREWARM_ORIGIN": "https://dmv.agentcommunity.org",
  // Feature flag for the CF-native rate-limit shim at worker/rate-limit-cf.ts.
  // When "true", tryCfRateLimit() enforces limits. When anything else (or
  // unset via wrangler secret override), tryCfRateLimit() returns null and
  // callers treat that as "rate limiting disabled". Default "true" here
  // keeps production protected; the kill switch is:
  //   pnpm wrangler secret put USE_CF_RATE_LIMIT --text false
  // (which promotes the secret over the var without a redeploy).
  "USE_CF_RATE_LIMIT": "true"
},
```

### Step 5: Rename call sites in `worker/index.ts`

**Pre-read:** `grep -n 'API_RATE_LIMITER' worker/index.ts` to find all references. As of commit `65b82e4` there should be:
- The `Env` interface field declaration (`API_RATE_LIMITER: RateLimit;`)
- The `.limit({ key })` call inside the card-path handler (approximately line 432 in the pre-refactor file)
- Any error-log message mentioning the limiter by name (`console.error('[ratelimit] API_RATE_LIMITER.limit failed', ...)`)
- Any analytics-event `category` or `tier` field mentioning `'API_RATE_LIMITER'` (probably none, but grep to be sure)

Changes:

1. In the `Env` interface — rename the field:

```ts
// OLD
API_RATE_LIMITER: RateLimit;

// NEW
RL_CARDS: RateLimit;
```

2. At the inline `.limit()` call site, swap for the shim call. The existing code looks something like:

```ts
try {
  const { success } = await env.API_RATE_LIMITER.limit({ key: rlKey });
  if (!success) {
    emitError('429');
    return new Response('Rate limit exceeded', {
      status: 429,
      headers: { /* ... */ },
    });
  }
} catch (err) {
  console.error('[ratelimit] API_RATE_LIMITER.limit failed', err);
  // Fall through — limiter failure must not break responses.
}
```

Replace with:

```ts
import { tryCfRateLimit } from './rate-limit-cf';
// ...
const decision = await tryCfRateLimit(env, 'RL_CARDS', rlKey);
if (decision === false) {
  emitError('rate_limited');  // note vocab change: 'rate_limited' not '429'
  return new Response('Rate limit exceeded', {
    status: 429,
    headers: { /* ... */ },
  });
}
// decision === true (allowed) or null (shim disabled) → fall through
```

3. Update the analytics-tier vocabulary for rate-limit rejections. If the existing `emitError()` helper emits `tier: '429'` for rate-limit blocks, change the call site to emit `tier: 'rate_limited'`. This aligns DMV's analytics vocabulary with PAGE's (`blob2: 'rate_limited'`). Keep the HTTP 429 status code — only the analytics label changes.

4. Update any log-line mentions of `API_RATE_LIMITER` to say `RL_CARDS`.

### Step 6: Verify via `wrangler deploy --dry-run`

From the worktree:
```bash
cd /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
pnpm wrangler deploy --dry-run 2>&1 | tail -40
```

Expected bindings (existing 7, with `API_RATE_LIMITER` renamed to `RL_CARDS`):
- `env.CARD_RENDERER (CardRenderer)` — Durable Object
- `env.BADGE_CACHE_KV` — KV Namespace
- `env.CARD_CACHE (dmv-card-cache-test)` — R2 Bucket
- `env.ANALYTICS (dmv_worker_events)` — Analytics Engine Dataset
- **`env.RL_CARDS (100 requests/60s)`** — Rate Limit (was `API_RATE_LIMITER`)
- `env.ASSETS` — Assets
- `env.PREWARM_ORIGIN ("https://dmv.agentcommunity.org")` — Environment Variable
- **`env.USE_CF_RATE_LIMIT ("true")`** — Environment Variable (NEW)

### Step 7: Local smoke test (card path behavior unchanged)

Task 0 is a pure refactor. Smoke the card-rendering endpoints to make sure the rename + shim swap didn't break anything:

```bash
pnpm cf:dev > /tmp/cf-dev-task0.log 2>&1 &
CFDEV_PID=$!
# wait for "Ready on http://...:PORT"
sleep 3
PORT=$(grep -oE 'Ready on http://[^ ]+' /tmp/cf-dev-task0.log | grep -oE ':[0-9]+' | head -1 | tr -d :)
BASE="http://localhost:$PORT"

# Card endpoint — should return 200/304 normally
curl -sI "$BASE/api/card?name=smoke&type=AGENT&id=NOVA-ABC-123F" | head -5

# OG endpoint — same
curl -sI "$BASE/api/og?name=smoke&type=AGENT&id=NOVA-ABC-123F" | head -5

# Rate-limit behavior — spam 110 requests from same IP, expect 429 on the 101st
for i in $(seq 1 110); do
  curl -s -o /dev/null -w "%{http_code}\n" "$BASE/api/card?name=rl$i&type=AGENT&id=NOVA-ABC-123F"
done | sort | uniq -c

# Expected: ~100 of "200" (or "304" on cached hits) and ~10 of "429"
# The exact split depends on cache hits, but you MUST see 429s in the mix.

kill $CFDEV_PID
```

### Step 8: Commit

```bash
cd /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
git add worker/rate-limit-cf.ts worker/rate-limit-kv.ts worker/normalize-email.ts \
        worker/index.ts wrangler.jsonc
git commit -m "$(cat <<'EOF'
refactor(worker): vendor PAGE rate-limit shim, rename API_RATE_LIMITER to RL_CARDS

Pure refactor commit on the card-render path. Zero behavior change — the
existing 100/60s rate limit on /api/card and /api/og still fires exactly
as before, just via the vendored worker/rate-limit-cf.ts shim instead of
an inline env.API_RATE_LIMITER.limit() call.

Vendors three files from agentCommunity_PAGE with header comments
identifying the source and the coupling invariants:
- worker/rate-limit-cf.ts      (adapted from lib/rate-limit-cf.ts —
                                 takes env as explicit parameter instead
                                 of getCloudflareContext())
- worker/rate-limit-kv.ts      (adapted from lib/rate-limit-kv.ts —
                                 takes kv: KVNamespace as explicit
                                 parameter, unused by this commit but
                                 added for Task 2's fingerprint cooldown)
- worker/normalize-email.ts    (byte-identical copy of
                                 lib/utils/normalize-email.ts)

Renames the existing CF Rate Limiting binding from API_RATE_LIMITER to
RL_CARDS for convention alignment with PAGE's RL_* naming. The
namespace_id stays "1001" — this counter is DMV-only (card rendering,
not shared with PAGE). Only the local binding name changed.

Adds USE_CF_RATE_LIMIT="true" to wrangler.jsonc vars as the default
feature-flag value. The flag can be kill-switched via
`wrangler secret put USE_CF_RATE_LIMIT --text false` without redeploying.

Also changes the analytics tier vocabulary for rate-limit blocks from
'429' to 'rate_limited' (snake_case) to align with PAGE's blob2
convention. HTTP status code stays 429 — only the analytics label changes.

Prepares the ground for Task 1 of the 2026-04-08 DMV API hardening plan
(wrangler bindings for the shared-namespace register limiters) and
Task 2 (handleRegister using this shim).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 0 dispatch briefing (for the implementer subagent)

When dispatching the implementer for Task 0, include the full step text above AND these additional context points inlined:

- The worktree path is `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening`, branch `feat/api-hardening`, already on top of commit `825e402` which is a plan-revision commit on top of main's `65b82e4`.
- **Read the actual current state** of `worker/index.ts` and `wrangler.jsonc` first before making any edits. The plan describes the pre-refactor state but the real file may have drifted since the plan was written. Use grep with line numbers to find every `API_RATE_LIMITER` reference and report them before touching them.
- **Do NOT touch `worker/container-instance.ts`** — it's generated by `scripts/build-cf.mjs` at build time. The container hash doesn't change because we're not touching container sources.
- **Do NOT edit anything outside the worktree.** The main checkout at `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV` is for reference only; all changes go in the worktree.
- **Do NOT install new dependencies.** `@cloudflare/workers-types` already provides `KVNamespace`, `RateLimit`, and `AnalyticsEngineDataset` types. No npm install needed.
- **Report back** with the full `wrangler deploy --dry-run` tail-40 output showing the renamed binding, the commit hash, and a paste of the new three vendored files (so the reviewer can eyeball them against PAGE's originals).

---

## Task 1: Wrangler bindings — shared CF limiters + Turnstile site key

**Files:**
- Modify: `wrangler.jsonc`

The Turnstile **secret** key (`TURNSTILE_SECRET_KEY`) was installed by the user via the Cloudflare dashboard on 2026-04-08 (Worker Settings → Variables and Secrets → encrypted variable). Sub-agent does NOT need to install it and CANNOT via `wrangler secret put` due to a Worker-version-mismatch guard in the current account state. The secret is already present at runtime as `env.TURNSTILE_SECRET_KEY`; it just won't show in `wrangler deploy --dry-run` output (dry-run never shows secrets by design).

The Turnstile **site** key is the public value `0x4AAAAAAC2BwC5T9LSdndaK`. Safe to commit to `wrangler.jsonc`.

### Step 1: Add four SHARED CF Rate Limiting bindings

Open `wrangler.jsonc`. Find the `ratelimits` array (which should now contain one entry — `RL_CARDS` — after Task 0 landed). Add four new entries with the **EXACT** namespace IDs that PAGE uses:

```jsonc
"ratelimits": [
  // DMV-only: card rendering. Namespace 1001.
  {
    "name": "RL_CARDS",
    "namespace_id": "1001",
    "simple": { "limit": 100, "period": 60 }
  },
  // SHARED with agentCommunity_PAGE at the CF account level.
  // Same namespace_id = same counter per key across both Workers.
  // See docs/plans/2026-04-08-dmv-api-hardening-plan.md self-review
  // section for the coupling invariants.
  {
    "name": "RL_AUTH",
    "namespace_id": "4001",
    "simple": { "limit": 5, "period": 60 }
  },
  {
    "name": "RL_OTP_EMAIL",
    "namespace_id": "4005",
    "simple": { "limit": 5, "period": 60 }
  },
  {
    "name": "RL_OTP_IP",
    "namespace_id": "4006",
    "simple": { "limit": 20, "period": 60 }
  },
  {
    "name": "RL_OTP_IP_EMAIL",
    "namespace_id": "4007",
    "simple": { "limit": 4, "period": 60 }
  }
],
```

**CRITICAL:** The four new namespace IDs — `4001`, `4005`, `4006`, `4007` — MUST match PAGE's `wrangler.jsonc` exactly. Verify by reading `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc` lines 31–37 before committing. If PAGE has changed these values since 2026-04-08, STOP and flag the discrepancy — it means DMV either needs to update to match, or we need to accept the drift (unlikely — the shared counter benefit is the whole point of Option E).

### Step 2: Add the shared `KV_RATE_LIMIT` KV namespace

Find the existing `kv_namespaces` block (added by the 2026-04-07 plan's Task 6 for `BADGE_CACHE_KV`). Add a second entry that binds to **the same KV namespace id** PAGE uses:

```jsonc
"kv_namespaces": [
  {
    "binding": "BADGE_CACHE_KV",
    "id": "af14d3897b7b4964a75d7f0bfeb84600"
  },
  {
    // SHARED with agentCommunity_PAGE. Same CF KV namespace id means
    // DMV and PAGE write to the same underlying key-value store.
    // DMV uses the "dmv:rl:fp:*" key prefix for its fingerprint cooldown;
    // PAGE uses "otp:*" prefixes — no collision. Verify via:
    //   pnpm wrangler kv key list --binding KV_RATE_LIMIT
    "binding": "KV_RATE_LIMIT",
    "id": "c0e0d88fff1a4c59805ab85c7a03100f"
  }
],
```

Verify the id from PAGE is still `c0e0d88fff1a4c59805ab85c7a03100f` by grepping `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc` line 47.

### Step 3: Add `TURNSTILE_SITE_KEY` to `vars`

In the existing `vars` block (which should already have `PREWARM_ORIGIN` and `USE_CF_RATE_LIMIT` from Task 0), add:

```jsonc
"vars": {
  "PREWARM_ORIGIN": "https://dmv.agentcommunity.org",
  "USE_CF_RATE_LIMIT": "true",
  "TURNSTILE_SITE_KEY": "0x4AAAAAAC2BwC5T9LSdndaK"
},
```

### Step 4: Verify via dry-run

```bash
cd /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
pnpm wrangler deploy --dry-run 2>&1 | tail -50
```

Expected bindings — 13 total now:
- `env.CARD_RENDERER (CardRenderer)` — Durable Object
- `env.BADGE_CACHE_KV` — KV Namespace
- **`env.KV_RATE_LIMIT`** — KV Namespace (NEW, shared with PAGE)
- `env.CARD_CACHE (dmv-card-cache-test)` — R2 Bucket
- `env.ANALYTICS (dmv_worker_events)` — Analytics Engine Dataset
- `env.RL_CARDS (100 requests/60s)` — Rate Limit
- **`env.RL_AUTH (5 requests/60s)`** — Rate Limit (NEW, shared)
- **`env.RL_OTP_EMAIL (5 requests/60s)`** — Rate Limit (NEW, shared)
- **`env.RL_OTP_IP (20 requests/60s)`** — Rate Limit (NEW, shared)
- **`env.RL_OTP_IP_EMAIL (4 requests/60s)`** — Rate Limit (NEW, shared)
- `env.ASSETS` — Assets
- `env.PREWARM_ORIGIN ("https://dmv.agentcommunity.org")` — Environment Variable
- `env.USE_CF_RATE_LIMIT ("true")` — Environment Variable
- **`env.TURNSTILE_SITE_KEY ("0x4AAAAAAC2BwC5T9LSdndaK")`** — Environment Variable (NEW)

`TURNSTILE_SECRET_KEY` will NOT appear in dry-run output — that's expected (installed via dashboard, secrets never appear in dry-run).

### Step 5: Commit

```bash
git add wrangler.jsonc
git commit -m "$(cat <<'EOF'
feat(cf): add shared rate-limit bindings + Turnstile site key

Adds four CF Rate Limiting bindings with namespace IDs matching
agentCommunity_PAGE/wrangler.jsonc exactly, so DMV and PAGE share the
same counter per key at the CF account level:

  RL_AUTH          namespace_id 4001  ( 5 req/60s) — per-IP signup
  RL_OTP_EMAIL     namespace_id 4005  ( 5 req/60s) — per-email signup
  RL_OTP_IP        namespace_id 4006  (20 req/60s) — per-IP (wider)
  RL_OTP_IP_EMAIL  namespace_id 4007  ( 4 req/60s) — per-IP+email combo

An attacker hitting PAGE's /api/auth/otp/request 3 times in a minute
can only hit DMV's /api/register 2 more times before the combined
RL_AUTH bucket is empty. One counter, two properties, no duplicated
state, no Redis.

Also adds the shared KV_RATE_LIMIT namespace
(id c0e0d88fff1a4c59805ab85c7a03100f, same as PAGE) for the 24h
per-fingerprint cooldown used by handleRegister in Task 2. DMV keys
under "dmv:rl:fp:*", PAGE keys under "otp:*" — no collision.

TURNSTILE_SITE_KEY is added to wrangler.jsonc vars (public value,
safe to commit). The private secret TURNSTILE_SECRET_KEY was installed
via the Cloudflare dashboard on 2026-04-08 and is available at runtime
as env.TURNSTILE_SECRET_KEY without appearing in dry-run output.

Closes the "API hardening" known gap from the 2026-04-07 CF-native
hardening plan and establishes Option E (shared-namespace) alignment
with agentCommunity_PAGE per docs/plans/2026-04-08-dmv-api-hardening-plan.md.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1 dispatch briefing

- Worktree path, branch, prior commit context (as in Task 0).
- **Verify PAGE's current state** — the sub-agent MUST read `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc` and grep for the four namespace IDs before adding them to DMV. If PAGE's IDs have drifted, STOP and report.
- **Do NOT use `wrangler secret put TURNSTILE_SECRET_KEY`** — it's already installed via dashboard and `secret put` is blocked by a Worker version mismatch anyway.
- **The KV namespace id `c0e0d88fff1a4c59805ab85c7a03100f` must also be verified** against PAGE's `kv_namespaces` block (line 47 as of 2026-04-08).

---

## Task 2: `/api/register` worker handler

**Files:**
- Modify: `worker/index.ts`

Mirrors the pattern of `handleBadge` (Task 6 of the 2026-04-07 plan): Env interface field, handler function, dispatch site in `fetch`. The rate-limit ordering mirrors `agentCommunity_PAGE/lib/auth/rate-limit.ts` `checkRateLimit()` — tightest-combo-first, parallel CF calls, KV cooldown second.

### Step 1: Extend the `Env` interface

Add the new fields alongside the existing ones:

```ts
interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  ASSETS: Fetcher;
  PREWARM_ORIGIN: string;
  ANALYTICS: AnalyticsEngineDataset;
  BADGE_CACHE_KV: KVNamespace;
  RL_CARDS: RateLimit;
  // Feature flag for tryCfRateLimit() — default "true" in wrangler.jsonc vars
  // but can be kill-switched via wrangler secret put USE_CF_RATE_LIMIT --text false
  USE_CF_RATE_LIMIT: string;

  // --- Added by Task 1 of the 2026-04-08 API hardening plan ---
  // Shared with agentCommunity_PAGE at the CF account level. namespace IDs
  // 4001/4005/4006/4007 map to RL_AUTH/RL_OTP_EMAIL/RL_OTP_IP/RL_OTP_IP_EMAIL
  // in PAGE's wrangler.jsonc. Same namespace = shared counter per key.
  RL_AUTH: RateLimit;
  RL_OTP_EMAIL: RateLimit;
  RL_OTP_IP: RateLimit;
  RL_OTP_IP_EMAIL: RateLimit;
  // Shared KV namespace (id c0e0d88fff1a4c59805ab85c7a03100f) with PAGE —
  // DMV uses the "dmv:rl:fp:*" key prefix for fingerprint cooldown.
  KV_RATE_LIMIT: KVNamespace;
  // Turnstile site key (public — rendered in browser HTML).
  TURNSTILE_SITE_KEY: string;
  // Turnstile secret key (encrypted — installed via CF dashboard 2026-04-08).
  TURNSTILE_SECRET_KEY: string;
}
```

### Step 2: Import the vendored helpers

Near the top of `worker/index.ts`:

```ts
import { tryCfRateLimit } from './rate-limit-cf';
import { incrementKvCooldown } from './rate-limit-kv';
import { normalizeEmail } from './normalize-email';
```

### Step 3: Add the `verifyTurnstile` helper

Near the other helper declarations in `worker/index.ts`:

```ts
// Verify a Turnstile token against Cloudflare's siteverify endpoint.
// Returns true on success, false on any failure. Never throws.
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
async function verifyTurnstile(
  token: string,
  secretKey: string,
  clientIp: string | null,
): Promise<boolean> {
  try {
    const formData = new URLSearchParams();
    formData.set('secret', secretKey);
    formData.set('response', token);
    if (clientIp) formData.set('remoteip', clientIp);

    const resp = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: formData.toString(),
      },
    );
    if (!resp.ok) {
      console.error('[turnstile] siteverify HTTP error', resp.status);
      return false;
    }
    const result = (await resp.json()) as { success?: boolean; 'error-codes'?: string[] };
    if (!result.success) {
      console.error('[turnstile] siteverify rejected', result['error-codes']);
      return false;
    }
    return true;
  } catch (err) {
    console.error('[turnstile] siteverify exception', err);
    return false;
  }
}

// Stable SHA-256 hex hash used for rate-limit keys. Matches the hashValue()
// helper in agentCommunity_PAGE/lib/auth/rate-limit.ts so DMV and PAGE
// compute identical keys for the shared namespace counters.
async function hashValue(value: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
```

### Step 4: Add the `handleRegister` handler

Place it near `handleBadge` in the file, matching its shape and use of `emitAnalytics` / `ctx.waitUntil`:

```ts
// Forwarded request headers for the /api/register → Supabase proxy.
const REGISTER_FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
] as const;

// 24h per-fingerprint cooldown: 3 registrations per fingerprint per day.
// Mirrors the CLI's local lockfile in packages/dmv-agent/src/rate-limit.ts.
// Enforced in the Worker via KV cooldown (PAGE pattern), replacing the
// Upstash limiter that the 2026-04-07 plan deferred and the 2026-04-08
// plan removes from the Supabase edge function in Task 3.
const FINGERPRINT_COOLDOWN_THRESHOLD = 3;
const FINGERPRINT_COOLDOWN_SECONDS = 24 * 60 * 60;

async function handleRegister(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const startedAt = Date.now();
  const path = '/api/register';

  if (request.method !== 'POST') {
    emitAnalytics(env, {
      category: 'error',
      tier: '405',
      path,
      key: '',
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  // Parse body first — we need email + fingerprint for the rate-limit keys.
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    emitAnalytics(env, {
      category: 'error',
      tier: 'bad_json',
      path,
      key: '',
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
    return new Response(
      JSON.stringify({ error: 'Invalid JSON body' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  // Minimal shape check before expensive work. Full validation happens
  // downstream in the Supabase edge function — this is just defense-in-depth.
  if (typeof body.agent_name !== 'string' || typeof body.email !== 'string') {
    emitAnalytics(env, {
      category: 'error',
      tier: 'validation',
      path,
      key: '',
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
    return new Response(
      JSON.stringify({ error: 'agent_name and email are required' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const clientIp = request.headers.get('cf-connecting-ip') ?? '';
  const normalizedEmail = normalizeEmail(body.email);

  // Hash each rate-limit key the same way PAGE does (SHA-256 hex) so the
  // shared-namespace counter lands on identical keys across both Workers.
  // See agentCommunity_PAGE/lib/auth/rate-limit.ts checkRateLimit() for the
  // reference implementation.
  const emailHash = await hashValue(normalizedEmail);
  const ipHash = clientIp ? await hashValue(clientIp) : 'noip';
  const ipEmailHash = await hashValue(`${ipHash}:${emailHash}`);

  // Tightest-first: per-IP+email combo → per-email → per-IP → per-IP auth.
  // Mirrors the ordering and key format in agentCommunity_PAGE/lib/auth/rate-limit.ts
  // so shared counters increment in the same order regardless of which Worker
  // handles the request.
  //
  // All four calls go through the same shim (`tryCfRateLimit`) and the same
  // Env.USE_CF_RATE_LIMIT feature flag. If the flag is off, all four return
  // null and the request is allowed — this matches the documented kill-switch
  // semantics. If ANY limiter returns false, the request is rejected with 429.
  const [ipEmailDecision, emailDecision, ipDecision, authDecision] = await Promise.all([
    tryCfRateLimit(env, 'RL_OTP_IP_EMAIL', `otp:ip-email:${ipEmailHash}`),
    tryCfRateLimit(env, 'RL_OTP_EMAIL', `otp:email:${emailHash}`),
    tryCfRateLimit(env, 'RL_OTP_IP', `otp:ip:${ipHash}`),
    tryCfRateLimit(env, 'RL_AUTH', clientIp || 'noip'),
  ]);

  const rateLimitBlock =
    ipEmailDecision === false
      ? 'ip_email'
      : emailDecision === false
        ? 'email'
        : ipDecision === false
          ? 'ip'
          : authDecision === false
            ? 'auth'
            : null;

  if (rateLimitBlock) {
    emitAnalytics(env, {
      category: 'error',
      tier: 'rate_limited',
      path,
      key: rateLimitBlock,
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'rate_limited',
        retry_after_seconds: 60,
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': '60',
          'X-RateLimit-Tier': rateLimitBlock,
        },
      },
    );
  }

  // Body-shape decision: browser (turnstile token) vs CLI/MCP (fingerprint).
  const turnstileToken =
    typeof body['cf-turnstile-response'] === 'string'
      ? (body['cf-turnstile-response'] as string)
      : null;
  const source = typeof body.signup_source === 'string' ? body.signup_source : 'unknown';
  const isBrowser = source === 'ui' || turnstileToken !== null;

  if (isBrowser) {
    // Browser path: require a Turnstile token and verify it.
    if (!turnstileToken) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'turnstile_missing',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'turnstile_required',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const ok = await verifyTurnstile(
      turnstileToken,
      env.TURNSTILE_SECRET_KEY,
      clientIp || null,
    );
    if (!ok) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'turnstile_failed',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'turnstile_failed',
        }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  } else {
    // CLI/MCP path: require machine_fingerprint and enforce a 24h KV cooldown.
    if (typeof body.machine_fingerprint !== 'string' || !body.machine_fingerprint) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'fingerprint_missing',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'fingerprint_required',
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const fingerprint = body.machine_fingerprint as string;
    const fpHash = await hashValue(fingerprint);
    const cooldownKey = `dmv:rl:fp:${fpHash}`;
    const cooldown = await incrementKvCooldown(
      env.KV_RATE_LIMIT,
      cooldownKey,
      FINGERPRINT_COOLDOWN_THRESHOLD,
      FINGERPRINT_COOLDOWN_SECONDS,
    );
    if (cooldown !== null) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'rate_limited',
        path,
        key: 'fingerprint',
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'rate_limited',
          retry_after_seconds: cooldown,
        }),
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(cooldown),
            'X-RateLimit-Tier': 'fingerprint',
          },
        },
      );
    }
  }

  // Strip the Turnstile token from the body before forwarding — the Supabase
  // function doesn't know about it and sending unknown fields could confuse
  // its validation.
  const upstreamBody = { ...body };
  delete upstreamBody['cf-turnstile-response'];

  // Build clean upstream headers.
  const upstreamHeaders = new Headers();
  for (const name of REGISTER_FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }
  if (clientIp) upstreamHeaders.set('x-forwarded-for', clientIp);
  upstreamHeaders.set('x-forwarded-host', new URL(request.url).host);
  upstreamHeaders.set('x-forwarded-proto', 'https');
  // Sentinel header so the Supabase function can eventually enforce
  // proxy-only access (Task 11, deferred).
  upstreamHeaders.set('x-dmv-proxy', 'v1');

  const upstream = await fetch(`${SUPABASE_FUNCTIONS_ORIGIN}/register-agent`, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  });

  const upstreamText = await upstream.text();

  emitAnalytics(env, {
    category: 'badge', // reuses the 'badge' category because it's a supabase-forward
    tier: upstream.ok ? 'supabase' : `supabase_${upstream.status}`,
    path,
    key: (body.agent_name as string)?.slice(0, 32) || '',
    latencyMs: Date.now() - startedAt,
    sizeBytes: upstreamText.length,
  });

  // Pass through the upstream status + body. Strip cookies and hop-by-hop
  // headers identical to handleBadge's hygiene.
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!BADGE_RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });
  responseHeaders.set('X-Register-Proxy', 'v1');

  return new Response(upstreamText, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
```

### Step 5: Dispatch `/api/register` in the main `fetch` handler

Find the dispatch table in the main `fetch` handler (around the existing `/api/card` / `/api/og` / `/badge` dispatches). Add:

```ts
// /api/register → worker-proxied Supabase register-agent with
// shared rate limits (RL_AUTH/RL_OTP_*), Invisible Turnstile for
// browser, and KV-backed fingerprint cooldown for CLI/MCP.
// See docs/plans/2026-04-08-dmv-api-hardening-plan.md Task 2.
if (url.pathname === '/api/register') return handleRegister(request, env, ctx);
```

Place it alongside `/api/card` and `/api/og` for logical grouping.

### Step 6: Confirm `/api/register` is already matched by `run_worker_first`

The existing `run_worker_first` array in `wrangler.jsonc` should have `"/api/*"` which already covers `/api/register`. No change needed. Confirm via dry-run.

### Step 7: Local smoke — handler error paths

```bash
pnpm cf:dev > /tmp/cf-dev-task2.log 2>&1 &
CFDEV_PID=$!
sleep 3
PORT=$(grep -oE 'Ready on http://[^ ]+' /tmp/cf-dev-task2.log | grep -oE ':[0-9]+' | head -1 | tr -d :)
BASE="http://localhost:$PORT"

echo "=== GET → 405 ==="
curl -sI "$BASE/api/register" | head -2

echo "=== POST invalid JSON → 400 bad_json ==="
curl -si -X POST -H 'content-type: application/json' --data-binary 'not json' "$BASE/api/register" | head -5

echo "=== POST missing fields → 400 validation ==="
curl -si -X POST -H 'content-type: application/json' --data-binary '{}' "$BASE/api/register" | head -5

echo "=== POST browser without token → 400 turnstile_required ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"test","email":"a@b.co","signup_source":"ui"}' \
  "$BASE/api/register" | head -5

echo "=== POST CLI without fingerprint → 400 fingerprint_required ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"test","email":"a@b.co","signup_source":"cli"}' \
  "$BASE/api/register" | head -5

echo "=== POST CLI with fingerprint → forwarded to Supabase ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"smoketest","email":"localsmoke@example.com","signup_source":"cli","machine_fingerprint":"dev-fake-fp","registration_type":"AGENT"}' \
  "$BASE/api/register" | head -10

kill $CFDEV_PID
```

Expected:
- GET → `HTTP/1.1 405`, `Allow: POST`
- Invalid JSON → `{"error":"Invalid JSON body"}`
- Missing fields → `{"error":"agent_name and email are required"}`
- Browser without token → `{"ok":false,"error":"turnstile_required"}`
- CLI without fingerprint → `{"ok":false,"error":"fingerprint_required"}`
- CLI with fingerprint → forwarded upstream. Response depends on Supabase state (may succeed, may fail on duplicate email). Either way, the outbound `fetch` to Supabase MUST fire — check `wrangler dev` logs.

### Step 8: Commit

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): add /api/register with shared rate limits + Invisible Turnstile

New handleRegister handler on the DMV Cloudflare Worker forwards POST
/api/register to the Supabase register-agent edge function with:

- Four-layer CF Rate Limiting check in tightest-first order
  (RL_OTP_IP_EMAIL → RL_OTP_EMAIL → RL_OTP_IP → RL_AUTH), all four
  using shared namespace IDs with agentCommunity_PAGE so the counters
  are identical at the CF account level. Matches the ordering and
  key format in PAGE's lib/auth/rate-limit.ts checkRateLimit().
- 24h per-fingerprint KV cooldown via the vendored worker/rate-limit-kv.ts
  incrementKvCooldown() for the CLI/MCP path. Replaces the Upstash
  perFingerprint limiter that the 2026-04-07 plan deferred; the
  equivalent Upstash layers in the Supabase edge function are deleted
  in Task 3 of this plan.
- Invisible Turnstile verify for browser requests (signup_source=ui or
  cf-turnstile-response present). Uses application/x-www-form-urlencoded
  POST matching the PAGE lib/auth/captcha.ts pattern.
- Clean upstream header hygiene (REGISTER_FORWARD_REQUEST_HEADERS
  allowlist + BADGE_RESPONSE_HEADERS_TO_STRIP reuse from Task 6 of
  the 2026-04-07 plan).
- Analytics events on every return path using snake_case tier vocabulary
  (rate_limited, turnstile_missing, turnstile_failed, fingerprint_missing,
  supabase, supabase_NNN, 405, bad_json, validation) aligned with
  agentCommunity_PAGE's blob2 convention.
- X-DMV-Proxy: v1 header to upstream so the Supabase function can
  eventually enforce proxy-only access (Task 11, deferred).

All rate-limit logic flows through the vendored worker/rate-limit-cf.ts
shim, which means the USE_CF_RATE_LIMIT feature flag acts as a unified
kill switch for the entire /api/register rate-limit layer.

Does NOT yet close the Supabase-direct bypass. Older CLI versions
continue to POST direct to Supabase. Task 11 closes the bypass 2+ weeks
after deploy when CLI adoption is confirmed.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2 dispatch briefing

- Worktree path, branch, prior commits.
- **Read the actual current state of `worker/index.ts`** before editing. The plan describes the expected structure but grep for `handleBadge`, `emitAnalytics`, `SUPABASE_FUNCTIONS_ORIGIN`, `BADGE_RESPONSE_HEADERS_TO_STRIP`, and `interface Env` first to find the exact insertion points.
- **Do NOT reintroduce `env.API_RATE_LIMITER`** — Task 0 renamed it to `env.RL_CARDS`. If the sub-agent sees any references to `API_RATE_LIMITER` in `worker/index.ts`, Task 0 was incomplete and the sub-agent should STOP.
- **Do NOT forget the import statements** at the top of the file — `tryCfRateLimit`, `incrementKvCooldown`, `normalizeEmail` all need imports.
- **The `hashValue()` helper** must match PAGE's `hashValue()` in `lib/auth/rate-limit.ts` (SHA-256 hex string via Web Crypto). DMV's Worker uses `crypto.subtle.digest`, PAGE's Next.js code uses `createHash('sha256')` from node:crypto — the outputs are identical byte strings, which is what matters for the shared-key semantics.
- **The rate-limit keys MUST use the `otp:` prefix** (e.g., `otp:email:<hash>`, `otp:ip:<hash>`, `otp:ip-email:<hash>`) to match PAGE's key format. Even though DMV doesn't do OTP, the key prefix is what lands in the shared counter bucket — if DMV uses `reg:email:<hash>` instead, the counters won't collide with PAGE's and the sharing benefit is lost.
- **Smoke test the error paths from Step 7** — don't skip this. The sub-agent should paste the full output of each curl command in the report.

---

## Task 3: Remove all Upstash from `register-agent` edge function

**Files:**
- Modify: `supabase/functions/register-agent/index.ts`

This task INVERTS the original Task 3. Instead of adding a 4th Upstash limiter, we DELETE all Upstash code from the edge function. The rate-limit protection moves entirely to the DMV Worker (Task 2), which proxies to this function. The SQL lifetime cap (3 unendorsed / 10 endorsed per email) stays as the Supabase-layer floor for abuse that still reaches the edge function (old CLI clients going direct until Task 11 closes the bypass).

**Why this is safe during the bypass window:**
- The Worker layer (Task 2) enforces rate limits on all new traffic through `/api/register`.
- Old CLI versions that still POST direct to Supabase lose 60-second-window protection but keep the SQL lifetime cap (3 successful registrations per email ever, unless endorsed).
- The SQL cap is a hard ceiling — an attacker using old CLIs cannot spam more than 3 registrations per email, ever.
- Email-spraying (many different emails, one registration each) bypasses any per-email rate limit regardless of Upstash or CF. That's a known limitation of email-based signup flows and is handled by Supabase's auth bounce-rate handling.

### Step 1: Read the current state

```bash
cd /Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening
cat supabase/functions/register-agent/index.ts | head -220
```

Note the exact locations of:
- Line 5-7: `@upstash/ratelimit` and `@upstash/redis` imports
- Lines 127-203: the "Rate limiting" section containing `createRateLimiters()`, `getLimiters()`, `hashString()`, `checkRateLimit()`, and the `_limiters` singleton
- Around line 252: the call site `const rateLimit = await checkRateLimit(email, ip)` and its 429 handling

### Step 2: Delete the Upstash imports

```diff
-import { Redis } from 'https://esm.sh/@upstash/redis@1.35.1'
-import { Ratelimit } from 'https://esm.sh/@upstash/ratelimit@2.0.6'
```

Leave the `createClient` Supabase import untouched.

### Step 3: Delete the rate-limiting section (approximately lines 127-203)

Delete the entire section from `// --- Rate limiting (Redis-backed via Upstash) ---` through the end of `checkRateLimit()` (inclusive). This removes:
- `_limiters` singleton
- `createRateLimiters()` factory
- `getLimiters()`
- `hashString()` helper
- `checkRateLimit(email, ip)`

The `hashString()` helper was only used by `checkRateLimit()` — nothing else references it. Verify with `grep hashString supabase/functions/register-agent/index.ts` before deleting to be sure.

### Step 4: Delete the call site in the handler

Around line 252 (pre-deletion), there's:

```ts
// Rate limit (Redis — no DB connection needed)
const rateLimit = await checkRateLimit(email, ip)
if (rateLimit.error) {
  return new Response(
    JSON.stringify({ error: rateLimit.error }),
    { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfter || 600) } },
  )
}
```

Delete this entire block. The SQL lifetime cap check below (`const { count: totalCerts } = await supabase.from('registrations').select(...)`) stays untouched — it's the new floor.

### Step 5: Verify no orphan references

```bash
grep -n 'upstash\|Ratelimit\|Redis\|checkRateLimit\|hashString\|_limiters\|createRateLimiters\|getLimiters' supabase/functions/register-agent/index.ts
```

Should return zero matches. If anything shows up, it's an orphan and needs to be removed.

### Step 6: Deploy the updated edge function

```bash
pnpm supabase functions deploy register-agent
```

(Verify the exact deploy command in `package.json` scripts or the project root. The command may be `supabase functions deploy register-agent` directly without the `pnpm` prefix if Supabase CLI is installed globally.)

This deploys to Supabase, NOT Cloudflare. Independent of `pnpm cf:deploy`.

### Step 7: Smoke test

Hit the edge function directly to confirm it still accepts valid requests and enforces the SQL lifetime cap:

```bash
# First attempt (should succeed or return a specific validation/cap error)
curl -si -X POST \
  -H 'content-type: application/json' \
  --data-binary '{"agent_name":"upsmoke1","email":"upsmoke@example.com","signup_source":"cli","machine_fingerprint":"upsmokefp","registration_type":"AGENT"}' \
  https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent | head -15

# Repeat the SAME request. Expected: 409 duplicate or 201 (if first run cleared the db)
# — but NOT a 429 rate-limit, because Upstash is gone.
```

If you see a `429` response, something is wrong — either the deploy didn't land or there's an orphan limiter. Verify via `grep` again.

### Step 8: Commit

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "$(cat <<'EOF'
refactor(edge): remove all Upstash from register-agent

Deletes @upstash/ratelimit and @upstash/redis imports, the
createRateLimiters() factory, _limiters singleton, hashString() helper,
checkRateLimit() function, and the checkRateLimit(email, ip) call in
the handler.

Rate limit protection moves entirely to the DMV Cloudflare Worker's
new /api/register proxy (Task 2 of the 2026-04-08 API hardening plan),
which enforces four shared CF Rate Limiting layers (RL_AUTH, RL_OTP_*
with namespace IDs shared across both DMV and agentCommunity_PAGE) plus
a KV-backed 24h per-fingerprint cooldown — all without Upstash.

The SQL lifetime cap (3 unendorsed / 10 endorsed per email) stays
untouched and becomes the Supabase-layer floor. Old CLI versions that
still POST direct to Supabase during the 2-week bypass window lose
60-second-window rate limiting but keep the SQL lifetime cap as an
absolute ceiling on registrations per email.

Completes the "fuck Upstash in all essence" directive from the
2026-04-08 plan's Option E alignment with agentCommunity_PAGE.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3 dispatch briefing

- Worktree path, branch, prior commits.
- **Read `supabase/functions/register-agent/index.ts` in full before touching it.** The 363-line file has several sections; the sub-agent must understand the full shape (certificate ID generation, validation, CORS, rate limiting, handler) before deleting anything.
- **Do NOT touch the certificate ID generation, validation, CORS, or handler sections** — only the "Rate limiting" block and its call site get deleted.
- **Do NOT deploy until the grep check in Step 5 returns zero matches.** If anything slips through, the deploy will fail at runtime.
- **Do NOT touch `packages/dmv-agent/src/rate-limit.ts`** — that's the CLI-side fingerprint generation + local lockfile. It stays. Only the server-side Upstash limiters are removed.
- Confirm the Supabase deploy command from `package.json` scripts before running it. The project may or may not have `pnpm supabase functions deploy` aliased.

---

## Task 4: Browser HTML — Turnstile script + CSP

**Files:**
- Modify: `index.html`
- Modify: `public/_headers`
- Modify: `worker/index.ts` (`PERMALINK_CSP` constant)

### Step 1: Add Turnstile script to `<head>`

In `index.html` head section, after the existing `<link rel="preconnect" href="https://cdn.jsdelivr.net">` line, add:

```html
<link rel="preconnect" href="https://challenges.cloudflare.com" crossorigin>
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>
<meta name="dmv-turnstile-site-key" content="0x4AAAAAAC2BwC5T9LSdndaK">
```

`?render=explicit` lets us control when the widget renders from JS. The meta tag exposes the public site key to `js/CRTTerminal.js` without a build-time injection step.

### Step 2: Add the Turnstile mount div

Because the widget is configured in **Invisible mode** in the Cloudflare dashboard, it never renders any UI. The mount div only needs to exist as a DOM anchor for `turnstile.render()`; its position doesn't matter visually. Use off-screen positioning rather than `display:none` because some browsers pause iframes inside `display:none` ancestors, which could interfere with Turnstile's silent background verification.

Add this near the end of `<body>` in `index.html`, after any existing overlay divs:

```html
<!-- Turnstile mount anchor. Widget is in Invisible mode (dashboard config)
     so it never renders any visible UI — this div is purely a DOM anchor
     for turnstile.render(). Positioned off-screen rather than display:none
     so iframe background work isn't paused. -->
<div id="turnstile-container"
     aria-hidden="true"
     style="position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0;pointer-events:none"></div>
```

### Step 2b: Add Cloudflare Turnstile attribution to the footer

Cloudflare's Turnstile ToS requires attribution. Inside the existing footer area (look for `<footer>` or the status strip), add:

```html
<span class="dmv-turnstile-attribution" style="font-size:1.1rem;opacity:0.6">
  Bot protection by
  <a href="https://www.cloudflare.com/products/turnstile/" target="_blank" rel="noopener noreferrer" style="color:inherit">Cloudflare Turnstile</a>
</span>
```

### Step 3: Update CSP to allow the Turnstile origin

**DRIFT NOTE (2026-04-08):** Commit `65b82e4 fix(cf): allow blob: in img-src and connect-src CSP for GLTF textures` landed on main and added `blob:` to `img-src` and `connect-src` in BOTH `public/_headers` and `worker/index.ts` `PERMALINK_CSP`. **Read both files first** and layer the Turnstile additions on top of the existing `blob:` tokens rather than replacing them.

Current `public/_headers` CSP as of commit `65b82e4`:
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Change to (added `https://challenges.cloudflare.com` in `script-src`, `connect-src`, and a new `frame-src` directive — keep the `blob:` tokens):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Turnstile's Invisible mode still creates a hidden iframe internally for the silent verification handshake, so `frame-src` is required even though the user never sees it.

**Also update `PERMALINK_CSP` in `worker/index.ts`** to the exact same string — the two strings MUST stay byte-identical. Search for the `PERMALINK_CSP` constant declaration (around line 153 in the pre-refactor file) and update in lockstep.

**Verification before commit:**
```bash
grep -c 'challenges.cloudflare.com' public/_headers  # → 3
grep -c 'challenges.cloudflare.com' worker/index.ts  # → 3
grep -c "'self' data: blob:" public/_headers         # → 1
grep -c "'self' blob: https://tcymqfwwphacnosnnzxl" public/_headers  # → 1
```

### Step 4: Browser verification via gstack browse skill

After deploying Task 4's changes to local `cf:dev`, load the page in headless Chrome via the `browse` skill and check the DevTools console for any CSP violations:

```
# (controller dispatches browse with instructions to load http://localhost:<port>/,
# screenshot, and filter console for CSP errors)
```

Any CSP violation → the sub-agent must fix the directive it's blocking and re-verify.

### Step 5: Commit

```bash
git add index.html public/_headers worker/index.ts
git commit -m "$(cat <<'EOF'
feat(web): add Invisible Turnstile mount + attribution + CSP updates

- Loads Turnstile API from challenges.cloudflare.com with ?render=explicit
- Adds off-screen #turnstile-container mount div OUTSIDE the CRT canvas.
  Widget is in Invisible mode (dashboard config) so no UI ever renders —
  the mount div is purely a DOM anchor for turnstile.render()
- Adds dmv-turnstile-site-key meta tag exposing the public site key to JS
- Adds the required "Bot protection by Cloudflare Turnstile" footer
  attribution (Turnstile ToS)
- Extends CSP script-src, connect-src, and new frame-src with
  https://challenges.cloudflare.com (frame-src because Turnstile still
  creates a hidden iframe internally even in Invisible mode)
- Preserves blob: tokens in img-src + connect-src from commit 65b82e4
- Keeps PERMALINK_CSP in worker/index.ts byte-identical to public/_headers
- preconnect hint to challenges.cloudflare.com for faster widget load

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4 dispatch briefing

- Worktree path, branch, prior commits.
- **CRITICAL DRIFT NOTE:** `blob:` MUST be preserved in `img-src` and `connect-src` (from commit `65b82e4`). The sub-agent's Edit must layer the Turnstile additions on top, not replace. Verify with the grep commands in Step 3.
- **The `PERMALINK_CSP` and `public/_headers` CSP strings MUST stay byte-identical.** If they drift, `/c/:cert/:name` permalink responses get a different CSP than the SPA root and the permalink path breaks. The 2026-04-07 plan's Task 8 hit exactly this bug.
- **After committing, dispatch the `browse` skill** to load `http://localhost:<port>/` in headless Chrome and check the DevTools console for CSP violations. Any violation → fix the directive and re-verify.

---

## Task 5: Browser JS — Invisible Turnstile + `/api/register`

**Files:**
- Modify: `js/supabase.js`
- Modify: `js/CRTTerminal.js`

### Step 1: Update `REGISTER_ENDPOINT` in `js/supabase.js`

```js
// OLD
const REGISTER_ENDPOINT = 'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent';

// NEW — route through DMV worker proxy (same-origin on dmv.agentcommunity.org)
const REGISTER_ENDPOINT = '/api/register';
```

### Step 2: Accept a Turnstile token in `insertRegistration`

Change the function signature:

```js
export async function insertRegistration(formData, signupSource = 'ui', turnstileToken = null) {
  // ... existing early returns ...

  const body = {
    agent_name: formData.agentName || '',
    email: formData.email || formData.orgEmail || formData.operatorEmail || '',
    operator_name: formData.userName || null,
    organization_name: formData.companyName || null,
    signup_source: signupSource,
    registration_type: registrationType,
  };
  if (turnstileToken) {
    body['cf-turnstile-response'] = turnstileToken;
  }

  // ... rest of function unchanged ...
}
```

### Step 3: Render the Turnstile widget in Invisible mode

In `js/CRTTerminal.js`, add the widget manager. The dashboard widget mode is **Invisible**, so no UI ever renders. The `execution: 'execute'` param defers the challenge until form submit. Promise-wrap `turnstile.execute()` using render-time callbacks + module-level pending-resolver state — the canonical pattern because `execute()` is single-argument (no per-call callback overrides in the public API).

```js
// Turnstile widget management — Invisible widget mode.
//
// The widget is configured in Invisible mode in the Cloudflare dashboard,
// so turnstile.render() never produces any visible UI — the #turnstile-container
// mount div stays off-screen and empty to the user. All verification happens
// silently in a background iframe.

let turnstileWidgetId = null;
let turnstileRenderAttempted = false;
let pendingTurnstileResolve = null;
let pendingTurnstileReject = null;
let pendingTurnstileTimer = null;

function _settleTurnstile(ok, value) {
  const resolve = pendingTurnstileResolve;
  const reject = pendingTurnstileReject;
  pendingTurnstileResolve = null;
  pendingTurnstileReject = null;
  if (pendingTurnstileTimer) {
    clearTimeout(pendingTurnstileTimer);
    pendingTurnstileTimer = null;
  }
  if (ok && resolve) resolve(value);
  else if (!ok && reject) reject(value);
}

function mountTurnstileWidget() {
  if (turnstileRenderAttempted && turnstileWidgetId !== null) return;
  if (typeof window.turnstile === 'undefined') {
    console.warn('[turnstile] script not loaded yet — will retry on first execute');
    return;
  }
  turnstileRenderAttempted = true;

  const container = document.getElementById('turnstile-container');
  if (!container) {
    console.warn('[turnstile] #turnstile-container missing');
    return;
  }

  const siteKey = document.querySelector('meta[name="dmv-turnstile-site-key"]')?.content;
  if (!siteKey) {
    console.error('[turnstile] dmv-turnstile-site-key meta tag missing');
    return;
  }

  try {
    turnstileWidgetId = window.turnstile.render(container, {
      sitekey: siteKey,
      execution: 'execute',  // don't run challenge until we call execute()
      callback: (token) => _settleTurnstile(true, token),
      'error-callback': (errorCode) => {
        console.error('[turnstile] challenge errored', errorCode);
        _settleTurnstile(false, new Error(`Turnstile error: ${errorCode || 'unknown'}`));
      },
      'expired-callback': () => {
        _settleTurnstile(false, new Error('Turnstile token expired — please retry'));
      },
    });
  } catch (err) {
    console.error('[turnstile] render failed', err);
    turnstileWidgetId = null;
  }
}

function executeTurnstile({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window.turnstile === 'undefined') {
      return reject(new Error('Turnstile script not loaded'));
    }
    if (turnstileWidgetId === null) {
      mountTurnstileWidget();
      if (turnstileWidgetId === null) {
        return reject(new Error('Turnstile widget failed to mount'));
      }
    }

    // Overwrite any stale pending slot (defends against rapid double-clicks).
    if (pendingTurnstileResolve || pendingTurnstileReject) {
      _settleTurnstile(false, new Error('Turnstile verification superseded'));
    }

    pendingTurnstileResolve = resolve;
    pendingTurnstileReject = reject;

    pendingTurnstileTimer = setTimeout(() => {
      if (turnstileWidgetId !== null) {
        try { window.turnstile.reset(turnstileWidgetId); } catch { /* ignore */ }
      }
      _settleTurnstile(false, new Error('Turnstile verification timed out'));
    }, timeoutMs);

    try {
      window.turnstile.execute(turnstileWidgetId);
    } catch (err) {
      _settleTurnstile(false, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function resetTurnstile() {
  if (turnstileWidgetId !== null && typeof window.turnstile !== 'undefined') {
    try { window.turnstile.reset(turnstileWidgetId); } catch { /* ignore */ }
  }
}
```

**Wire-up:**
- Call `mountTurnstileWidget()` when the CRT form transitions into the review/submit phase. Idempotent — repeated calls no-op once the widget is rendered.
- When the user clicks the CRT submit button, `await executeTurnstile()` **before** `insertRegistration()`. Pass the resolved token as the third argument: `await insertRegistration(formData, 'ui', token)`.
- The submit button MUST be disabled between click and promise settle, to prevent double-submits from colliding with the single-slot pending resolver.
- If `executeTurnstile()` rejects, surface a CRT-styled error matching the existing form-validation error pattern ("VERIFICATION FAILED — PLEASE RETRY"), reset the submit button, and call `resetTurnstile()`. Do NOT fall back to calling `insertRegistration()` without a token — the Worker will reject with `turnstile_required` or `turnstile_failed`.
- The error-handling path should also match the CRT's existing error surface — same text style, same reset delay, same reset-to-review-phase behavior.
- **Response handling:** when `insertRegistration()` returns a 429 with `error: 'rate_limited'` in the body, surface a CRT message like "TOO MANY ATTEMPTS — WAIT 60 SECONDS AND RETRY". Parse `retry_after_seconds` from the body for the exact wait time.

### Step 4: Local smoke test the browser flow

Cloudflare provides Turnstile test keys for local dev:
- `1x00000000000000000000AA` — always passes (happy-path)
- `2x00000000000000000000AB` — always fails

Matching test secret keys (only installable via dashboard due to the version-mismatch guard):
- `1x0000000000000000000000000000000AA` — always passes
- `2x0000000000000000000000000000000AA` — always fails

(The `3x00000000000000000000FF` always-interactive-challenge pair is NOT useful here because Invisible widget mode ignores interactive challenges.)

For local smoke, temporarily set three things to the happy-path test values:
1. `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY` → `1x00000000000000000000AA`
2. `index.html` `<meta name="dmv-turnstile-site-key">` → `1x00000000000000000000AA`
3. Install the matching test secret via the Cloudflare dashboard (Worker Settings → Variables and Secrets → edit `TURNSTILE_SECRET_KEY` to `1x0000000000000000000000000000000AA`). Do NOT use `wrangler secret put` — it's blocked by the version mismatch.

```bash
pnpm cf:build
pnpm cf:dev
# Open http://localhost:<port>/
# 1. Complete the CRT form flow to the review/submit screen
# 2. Verify in DevTools:
#    - #turnstile-container exists in the DOM, positioned off-screen
#    - No visible Cloudflare iframe anywhere on the page
#    - window.turnstile exists and window.turnstileWidgetId is set
# 3. Click submit. Network tab should show:
#    - POST /api/register (same-origin, NOT supabase.co)
#    - Request body includes "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX"
#    - Response is 200/201 or a specific Supabase-side error
#    - NOT a worker-side Turnstile rejection
```

Failure path:
1. Swap all three values to the always-fail keys
2. Rebuild + reload
3. Submit the form → CRT should surface "VERIFICATION FAILED" without POSTing

**CRITICAL:** Revert the test site key + secret back to real values in all three places before committing or deploying. Grep:
```bash
grep -n '1x00000000000000000000AA\|2x00000000000000000000AB' .
```

### Step 5: Commit

```bash
git add js/supabase.js js/CRTTerminal.js
git commit -m "$(cat <<'EOF'
feat(web): route registration through /api/register with Invisible Turnstile

Browser registration flow now:
1. Mounts the Turnstile widget lazily when the CRT form reaches the review
   phase, with execution=execute so the challenge is deferred until form
   submit. Widget is in Invisible mode (dashboard config) so no UI ever
   renders — visitors pass or fail silently.
2. On submit, turnstile.execute() is called and the render-time callback
   resolves a module-level pending promise via executeTurnstile().
   Zero visible UI, CRT aesthetic fully preserved.
3. Resolved token is sent as cf-turnstile-response in the /api/register
   POST body; the worker proxy verifies via Cloudflare siteverify and
   forwards to Supabase.
4. Failed/expired/timed-out verification surfaces a CRT-styled
   "VERIFICATION FAILED" error and calls turnstile.reset(). In Invisible
   mode, failure means the visitor tripped Cloudflare's silent heuristics
   — no interactive fallback path (by design; DMV has four other defense
   layers via the shared-namespace CF rate limits).
5. 15s hard timeout covers the rare hung case.
6. Rate-limit 429 responses from the worker are surfaced as "TOO MANY
   ATTEMPTS" with the retry_after_seconds value from the response body.

Turnstile site key is exposed via <meta name="dmv-turnstile-site-key">
(public, safe to commit). Secret key installed via CF dashboard.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5 dispatch briefing

- Worktree path, branch, prior commits.
- **Read `js/CRTTerminal.js` first** — grep for the review/submit phase transition hook so you know where to call `mountTurnstileWidget()`. The file is ~1000+ lines of state-machine; don't guess.
- **Do NOT leave test Turnstile keys committed.** Grep the full worktree for `1x00000000000000000000AA` and `2x00000000000000000000AB` before staging the commit.
- **Error path UX MUST match the existing form-validation error pattern** in `CRTTerminal.js`. Read the existing pattern first.

---

## Task 6: CLI — route through `/api/register`

**Files:**
- Modify: `packages/dmv-agent/src/register.ts`
- Modify: `packages/dmv-agent/package.json`
- Modify: `packages/dmv-agent-alias/package.json`

### Step 1: Update `REGISTER_ENDPOINT`

```ts
// OLD
const REGISTER_ENDPOINT = 'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent';

// NEW — route through DMV worker proxy with dev override
const REGISTER_ENDPOINT =
  process.env.DMV_API_ENDPOINT ??
  'https://dmv.agentcommunity.org/api/register';
```

### Step 2: Bump package versions

**Verified current state as of 2026-04-08:** `packages/dmv-agent/package.json` is at `0.1.0`. Bump to `0.2.0`.

Also bump `packages/dmv-agent-alias/package.json` from `0.1.0` to `0.2.0` AND update `dependencies["@agentcommunity/dmv-agent"]` from `">=0.1.0"` to `">=0.2.0"`.

### Step 3: Rebuild + smoke test locally

```bash
cd packages/dmv-agent
pnpm build

# Run the built CLI against local cf:dev
DMV_API_ENDPOINT="http://localhost:8787/api/register" node ./dist/cli.js register \
  --name clismoke-$(date +%s) \
  --email clismoke@example.com \
  --operator 'Smoke Test Operator' \
  --description 'smoke test'
```

Expected: the CLI hits the local worker, which enforces the rate limits + KV fingerprint cooldown + forwards to Supabase. Response depends on Supabase state (may succeed with cert ID, may fail on duplicate email). Either way the request MUST actually reach Supabase — verify via `wrangler dev` log.

### Step 4: Commit

```bash
git add packages/dmv-agent/src/register.ts packages/dmv-agent/package.json \
        packages/dmv-agent-alias/package.json
git commit -m "$(cat <<'EOF'
feat(cli): route registration through DMV worker /api/register

CLI and MCP now POST to https://dmv.agentcommunity.org/api/register by
default (overridable via DMV_API_ENDPOINT env var for dev/staging).
The worker proxy enforces the shared-namespace CF rate limits (RL_AUTH,
RL_OTP_EMAIL, RL_OTP_IP, RL_OTP_IP_EMAIL — all sharing counters with
agentCommunity_PAGE at the CF account level), the KV-backed 24h
per-fingerprint cooldown, and forwards to Supabase on success.

Old CLI versions that still POST direct to Supabase continue to work
for now — the bypass closure is Task 11 of the 2026-04-08 plan and
stays deferred for 2+ weeks after this release ships.

Bumps @agentcommunity/dmv-agent to 0.2.0 and the unscoped dmv-agent
alias to 0.2.0 (minor — routing change).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: MCP — inherit the CLI change

**Files:**
- Possibly: `packages/dmv-agent/src/mcp.ts` or `packages/dmv-agent/src/index.ts`

### Step 1: Verify MCP reuses `registerAgent`

```bash
grep -rn 'registerAgent\|register-agent\|REGISTER_ENDPOINT' packages/dmv-agent/src/
```

If MCP imports `registerAgent` from `./register.ts`, Task 6's endpoint change automatically applies — Task 7 is a no-op. Mark it "no-op — covered by Task 6" in the plan progress tracker.

If MCP has its own separate fetch call, update it the same way and commit with the same message shape as Task 6.

---

## Task 8: Local smoke — full end-to-end

**Files:** None (verification only)

### Step 1: Restore real Turnstile keys

If test keys are still in wrangler.jsonc/index.html/the dashboard secret from Task 5 Step 4, restore the real values:
1. `wrangler.jsonc` `TURNSTILE_SITE_KEY` → `0x4AAAAAAC2BwC5T9LSdndaK`
2. `index.html` meta tag → `0x4AAAAAAC2BwC5T9LSdndaK`
3. Dashboard `TURNSTILE_SECRET_KEY` → real production secret

### Step 2: Full local smoke

```bash
pnpm cf:dev

# Worker proxy responds on the register path
curl -sI http://localhost:8787/api/register | head -2
# Expected: 405 (GET not allowed)

# CLI path end-to-end
DMV_API_ENDPOINT="http://localhost:8787/api/register" \
  node packages/dmv-agent/dist/cli.js register \
    --name localsmoke-$(date +%s) \
    --email localsmoke@example.com \
    --operator 'Local Smoke' \
    --description 'local smoke'
# Expected: registration succeeds OR explicit Supabase validation error.
# Either way the outbound fetch to Supabase must fire (check wrangler dev log).

# Browser path
open http://localhost:8787/
# Complete the CRT form
# Verify:
# - No Turnstile iframe visible at any point
# - POST /api/register fires on submit (same-origin)
# - Registration completes successfully

# Rate-limit regression: hit /api/card 110 times
for i in $(seq 1 110); do
  curl -s -o /dev/null -w "%{http_code}\n" \
    "http://localhost:8787/api/card?name=rl$i&type=AGENT&id=NOVA-ABC-123F"
done | sort | uniq -c
# Expected: ~100 200s/304s + ~10 429s (RL_CARDS still enforcing at 100/60s)

# Verify /healthz + /badge/* + /c/:id/:name still work (regression check)
curl -s http://localhost:8787/healthz | python3 -m json.tool
curl -sI 'http://localhost:8787/badge?id=NOVA-ABC-123F' | head -3
curl -sI 'http://localhost:8787/c/NOVA-ABC-123F/testagent' | head -3
```

### Step 3: Run the full regression checklist from the 2026-04-07 plan

Verify `/api/card`, `/api/og`, `/badge/*`, `/c/:cert/:name`, `/healthz`, and the root `/` CSP all still work as before. Any regression → investigate before proceeding to deploy.

---

## Task 9: Deploy + prod smoke + staged rollout

**Files:** None (verification + deploy)

### Deploy order

1. **Worker first** (adds the new /api/register protection + shared rate limits + KV cooldown)
2. **Supabase edge function second** (removes Upstash — now the Worker is enforcing, so Supabase can retire the redundant layer)
3. **CLI npm publish third** (new version routes to the worker)

### Step 1: Dry-run verification

```bash
pnpm wrangler deploy --dry-run
```

Expect all 13 bindings (see Task 1 Step 4 list).

### Step 2: Deploy the Worker

```bash
pnpm cf:deploy
```

### Step 3: Deploy the Supabase edge function

```bash
pnpm supabase functions deploy register-agent
```

### Step 4: Publish the new CLI version

```bash
cd packages/dmv-agent
pnpm build
pnpm publish --access public

cd ../dmv-agent-alias
pnpm publish --access public
```

### Step 5: Post-deploy smoke

```bash
# Worker proxy
curl -sI https://dmv.agentcommunity.org/api/register | head -2
# Expected: 405

# Invalid body
curl -si -X POST -H 'content-type: application/json' --data-binary '{}' \
  https://dmv.agentcommunity.org/api/register | head -5
# Expected: 400 "agent_name and email are required"

# CLI end-to-end
bunx dmv-agent@latest register \
  --name prodsmoke-$(date +%s) \
  --email prodsmoke@example.com \
  --operator 'Prod Smoke' \
  --description 'prod deploy verification'
# Expected: registration succeeds through the worker proxy

# Browser end-to-end
open https://dmv.agentcommunity.org/
# - Complete the CRT form
# - Submit
# - Verify: no Turnstile iframe visible, POST to /api/register (not supabase.co), 200/201
```

### Step 6: Watch `wrangler tail` for ~5 minutes

```bash
pnpm cf:tail
```

Look for:
- No `[rate-limit-cf]` failures
- No `[rate-limit-kv]` failures
- No `[turnstile] siteverify` errors
- Analytics events under `path: /api/register` with the new snake_case vocabulary (`rate_limited`, `turnstile_failed`, `supabase`, etc.)

If anything looks unhealthy, rollback via `pnpm wrangler rollback`. Old worker versions don't know about `/api/register` and will 404 — clients will fall back to their own error handling.

### Step 7: Announce the new CLI version

Tell users to upgrade: `bunx dmv-agent@latest register`. Pin the CLI changelog entry to the top of the package README.

---

## Task 10: Docs update + drift-check script

**Files:**
- Modify: `CLOUDFLARE.md` — Operational notes + Known gaps
- Modify: `ARCHITECTURE.md` — Rate limiting section + data flow
- NEW: `scripts/check-ratelimit-drift.mjs` — tiny drift-check script

### Step 1: Add "API registration proxy + shared rate limits" bullet to `CLOUDFLARE.md` Operational notes

```markdown
- **API registration proxy + shared rate limits with agentCommunity_PAGE**
  (2026-04-08): `/api/register` is a worker-proxied route that forwards POSTs
  to the Supabase `register-agent` edge function. Rate limiting uses four
  CF Rate Limiting bindings whose `namespace_id` values (`4001`, `4005`,
  `4006`, `4007`) are **SHARED at the Cloudflare account level** with
  `agentCommunity_PAGE`'s `RL_AUTH`, `RL_OTP_EMAIL`, `RL_OTP_IP`, and
  `RL_OTP_IP_EMAIL` bindings. An attacker hitting PAGE's OTP endpoint
  decrements the same counter DMV's register endpoint reads from — one
  counter, two properties. Plus a KV-backed 24h per-fingerprint cooldown
  for the CLI/MCP path (`incrementKvCooldown` from `worker/rate-limit-kv.ts`,
  vendored from PAGE), using the shared `KV_RATE_LIMIT` namespace
  (`c0e0d88fff1a4c59805ab85c7a03100f`) with DMV keys prefixed `dmv:rl:fp:*`.
  Browser requests must include a Turnstile response token (Invisible widget
  mode — no visible UI); CLI/MCP requests skip Turnstile and rely on the
  KV fingerprint cooldown. All rate-limit code flows through the vendored
  `worker/rate-limit-cf.ts` shim (adapted from `agentCommunity_PAGE/lib/rate-limit-cf.ts`)
  and respects the `USE_CF_RATE_LIMIT` feature flag for instant kill-switch.
  Legacy CLI versions that still POST direct to Supabase continue to work
  until Task 11 of `docs/plans/2026-04-08-dmv-api-hardening-plan.md` closes
  the bypass (deferred).
```

### Step 2: Update `CLOUDFLARE.md` Known gaps

- DELETE the "API hardening" known gap bullet — this plan closed it.
- Add a new bullet about the shared-namespace coupling drift risk:

```markdown
- **Shared rate-limit namespace drift** — `RL_AUTH` (4001), `RL_OTP_EMAIL`
  (4005), `RL_OTP_IP` (4006), `RL_OTP_IP_EMAIL` (4007), and `KV_RATE_LIMIT`
  (`c0e0d88fff1a4c59805ab85c7a03100f`) are shared with `agentCommunity_PAGE`
  by design. If PAGE changes any of these IDs, DMV silently drifts out of
  the shared counter (no error, just split keyspaces). Guard: run
  `node scripts/check-ratelimit-drift.mjs` against the PAGE checkout
  whenever the two repos are co-edited; CI integration is a TODO.
```

### Step 3: Update `ARCHITECTURE.md` Layer 0

Rewrite the Layer 0 paragraph to describe the Option E design:

```markdown
**Layer 0 — Cloudflare Worker edge rate limit** (2026-04-08 rewrite). Five CF
Rate Limiting bindings enforced at the Worker edge before any cache lookup
or upstream forwarding:

- `RL_CARDS` (namespace 1001, 100 req/60s per `${ip}:${pathname}`) — guards
  `/api/card` and `/api/og`. DMV-only (PAGE doesn't render cards).
- `RL_AUTH` (namespace 4001, 5 req/60s per IP) — guards `/api/register`.
  **SHARED** with `agentCommunity_PAGE`.
- `RL_OTP_EMAIL` (namespace 4005, 5 req/60s per email hash) — guards
  `/api/register`. **SHARED**.
- `RL_OTP_IP` (namespace 4006, 20 req/60s per IP hash) — guards
  `/api/register`. **SHARED**.
- `RL_OTP_IP_EMAIL` (namespace 4007, 4 req/60s per IP+email hash) — guards
  `/api/register`, tightest layer. **SHARED**.

Plus a KV-backed 24h per-fingerprint cooldown for the CLI/MCP path via
`incrementKvCooldown()` in `worker/rate-limit-kv.ts`, sharing PAGE's
`KV_RATE_LIMIT` namespace.

Upstash is gone from DMV. The Supabase edge function `register-agent` no
longer has any Redis-backed rate limiters — the SQL lifetime cap (3/10 per
email) is the Supabase-layer floor. All 60-second-window protection lives
in the Worker.

Rate-limit rejections return HTTP 429 with body
`{ ok: false, error: 'rate_limited', retry_after_seconds: <n> }` and header
`X-RateLimit-Tier: <which layer blocked>`. Analytics events are emitted
with `tier: 'rate_limited'` (snake_case, aligned with PAGE's convention).

The entire rate-limit layer is gated behind `env.USE_CF_RATE_LIMIT === 'true'`.
Kill-switch:
  pnpm wrangler secret put USE_CF_RATE_LIMIT --text false
```

### Step 4: Create `scripts/check-ratelimit-drift.mjs`

A tiny script that asserts DMV's `wrangler.jsonc` references the same namespace IDs as PAGE's. Opt-in — not CI-wired yet, but documented as a checkpoint.

```js
#!/usr/bin/env node
// Checks that DMV's CF Rate Limiting namespace IDs for the SHARED bindings
// match agentCommunity_PAGE's. Run this after any edit to wrangler.jsonc
// in either repo, or when re-vendoring worker/rate-limit-cf.ts. If the
// script fails, the shared-namespace alignment from the 2026-04-08 plan
// has drifted and the "one counter, two properties" property is broken.

import fs from 'node:fs/promises';
import path from 'node:path';

const PAGE_PATH = process.env.PAGE_REPO
  || '/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE';

const SHARED_BINDINGS = {
  RL_AUTH:         { ns: '4001', limit: 5,  period: 60 },
  RL_OTP_EMAIL:    { ns: '4005', limit: 5,  period: 60 },
  RL_OTP_IP:       { ns: '4006', limit: 20, period: 60 },
  RL_OTP_IP_EMAIL: { ns: '4007', limit: 4,  period: 60 },
};
const SHARED_KV_ID = 'c0e0d88fff1a4c59805ab85c7a03100f';

async function readJsonc(p) {
  const text = await fs.readFile(p, 'utf8');
  // Strip line comments for a rough parse — JSONC isn't pure JSON but
  // wrangler.jsonc uses only // comments.
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, ''));
}

async function main() {
  const dmvPath = path.resolve('wrangler.jsonc');
  const pagePath = path.join(PAGE_PATH, 'wrangler.jsonc');

  const dmv = await readJsonc(dmvPath);
  const page = await readJsonc(pagePath);

  const errors = [];

  for (const [name, expected] of Object.entries(SHARED_BINDINGS)) {
    const dmvBinding = (dmv.ratelimits || []).find((b) => b.name === name);
    const pageBinding = (page.ratelimits || []).find((b) => b.name === name);

    if (!dmvBinding) errors.push(`DMV is missing binding ${name}`);
    if (!pageBinding) errors.push(`PAGE is missing binding ${name}`);
    if (dmvBinding && pageBinding) {
      if (dmvBinding.namespace_id !== pageBinding.namespace_id) {
        errors.push(
          `${name}: namespace_id drift — DMV=${dmvBinding.namespace_id}, PAGE=${pageBinding.namespace_id}`,
        );
      }
      if (dmvBinding.namespace_id !== expected.ns) {
        errors.push(
          `${name}: DMV namespace_id ${dmvBinding.namespace_id} !== pinned ${expected.ns}`,
        );
      }
    }
  }

  const dmvKv = (dmv.kv_namespaces || []).find((b) => b.binding === 'KV_RATE_LIMIT');
  const pageKv = (page.kv_namespaces || []).find((b) => b.binding === 'KV_RATE_LIMIT');
  if (!dmvKv) errors.push('DMV is missing KV_RATE_LIMIT binding');
  if (!pageKv) errors.push('PAGE is missing KV_RATE_LIMIT binding');
  if (dmvKv && pageKv && dmvKv.id !== pageKv.id) {
    errors.push(`KV_RATE_LIMIT: id drift — DMV=${dmvKv.id}, PAGE=${pageKv.id}`);
  }
  if (dmvKv && dmvKv.id !== SHARED_KV_ID) {
    errors.push(`KV_RATE_LIMIT: DMV id ${dmvKv.id} !== pinned ${SHARED_KV_ID}`);
  }

  if (errors.length) {
    console.error('❌ Rate-limit drift detected:');
    for (const e of errors) console.error('  -', e);
    process.exit(1);
  }

  console.log('✅ Shared rate-limit bindings aligned with agentCommunity_PAGE');
  console.log(`   DMV  path: ${dmvPath}`);
  console.log(`   PAGE path: ${pagePath}`);
}

main().catch((err) => {
  console.error('Drift check failed:', err);
  process.exit(2);
});
```

Add a `pnpm ratelimit:check` script to `package.json`:

```jsonc
"scripts": {
  // ... existing ...
  "ratelimit:check": "node scripts/check-ratelimit-drift.mjs"
}
```

### Step 5: Commit

```bash
git add CLOUDFLARE.md ARCHITECTURE.md scripts/check-ratelimit-drift.mjs package.json
git commit -m "$(cat <<'EOF'
docs: document /api/register proxy + shared rate limits with PAGE

Closes the "API hardening" known gap from the 2026-04-07 CF-native
hardening plan. Adds an Operational notes bullet describing the
Option E alignment (shared CF Rate Limiting namespace IDs and shared
KV_RATE_LIMIT namespace with agentCommunity_PAGE), the vendored
worker/rate-limit-cf.ts + worker/rate-limit-kv.ts shims, the
USE_CF_RATE_LIMIT feature flag kill-switch, and the Invisible
Turnstile + KV fingerprint cooldown split between the browser and
CLI/MCP paths. Rewrites the ARCHITECTURE.md Layer 0 section to
reflect the new five-binding design (RL_CARDS DMV-only, RL_AUTH +
RL_OTP_* shared) and to remove the now-deleted Upstash layers.

Adds scripts/check-ratelimit-drift.mjs — a tiny standalone checker
that asserts DMV's four shared bindings (RL_AUTH, RL_OTP_EMAIL,
RL_OTP_IP, RL_OTP_IP_EMAIL) have the exact namespace_ids PAGE uses
(4001/4005/4006/4007) and that KV_RATE_LIMIT binds the same namespace
id (c0e0d88fff1a4c59805ab85c7a03100f). Opt-in (pnpm ratelimit:check),
not CI-wired — that's a follow-up. Guards against the silent-drift
scenario where PAGE renumbers a namespace and DMV doesn't follow.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Supabase bypass closure — DEFERRED

**⚠ DO NOT RUN THIS TASK until at least 2 weeks after Task 9 deploys and CLI adoption is confirmed.**

The existing direct path (`https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent`) continues to accept requests from old CLI versions until enough users have upgraded. Closing the bypass prematurely breaks old installs.

**When to run:**
- 2+ weeks after Task 9 deploys
- AND telemetry shows direct-Supabase POSTs (without `x-dmv-proxy: v1` header) have dropped below 5% of total registrations
- AND the new CLI version (0.2.0) has been published and promoted

### Step 1: Add the `x-dmv-proxy` header check

In `supabase/functions/register-agent/index.ts`, at the top of the handler after the OPTIONS + method checks:

```ts
const proxyHeader = req.headers.get('x-dmv-proxy');
if (proxyHeader !== 'v1') {
  return new Response(
    JSON.stringify({
      error: 'Direct Supabase access is no longer supported. Please upgrade your DMV client: bunx dmv-agent@latest',
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...getCorsHeaders(req) },
    },
  );
}
```

### Step 2: Deploy

```bash
pnpm supabase functions deploy register-agent
```

### Step 3: Verify direct access is now blocked

```bash
curl -si -X POST \
  -H 'content-type: application/json' \
  --data-binary '{"agent_name":"bypassprobe","email":"a@b.co","signup_source":"cli","registration_type":"AGENT"}' \
  https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent | head -10
```
Expected: `HTTP/2 403` with the upgrade message.

### Step 4: Verify the worker proxy still works

```bash
bunx dmv-agent@latest register --name closetest --email closetest@example.com --operator 'Close Test' --description 'close test'
```
Expected: registration succeeds via the worker proxy.

### Step 5: Commit

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(edge): require X-DMV-Proxy header on register-agent

Closes the Supabase-direct bypass documented in the 2026-04-08 API
hardening plan. All registration traffic must now flow through the DMV
worker /api/register proxy which adds the x-dmv-proxy: v1 header before
forwarding upstream.

Direct POSTs from legacy CLI versions now receive 403 with an upgrade
message. Users must run `bunx dmv-agent@latest register` to continue.

This is the deferred Task 11 of the plan — only run after CLI adoption
telemetry shows <5% direct-Supabase traffic.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- **Spec coverage.** Closes the "API hardening" known gap from the 2026-04-07 plan. Adds Invisible Turnstile on browser flows, KV-backed 24h fingerprint cooldown on CLI/MCP flows, and a worker proxy layer that consolidates the registration path under the same rate-limiting + observability umbrella as the render path. ALIGNS rate limiting with `agentCommunity_PAGE` by sharing CF Rate Limiting namespace IDs and the `KV_RATE_LIMIT` namespace at the account level — one counter, two properties. REMOVES Upstash from DMV entirely.

- **Scope boundary.** This plan does NOT change the certificate ID generation, database schema, email flow, or the SQL lifetime cap. It ONLY touches rate limiting, the `/api/register` route, Turnstile, and the CSP. The card-render path is touched ONCE (Task 0) for a pure rename + shim substitution with no behavior change.

- **Staged rollout.** Task 11 (bypass closure) is explicitly deferred. Running it prematurely breaks old CLI installs. The `x-dmv-proxy: v1` sentinel header is added in Task 2 so the closure check in Task 11 has something to key on when the time comes.

- **Widget mode caveats (important for sub-agents).**
  - Widget visibility is controlled at TWO layers: the **dashboard widget mode** (`Managed` / `Non-interactive` / `Invisible`, chosen when the widget is created) and the **client-side render params** (`appearance`, `execution`, `size`, `theme`). DMV uses **Invisible** at the dashboard layer, which guarantees no UI is ever shown regardless of client-side params.
  - The `size: 'invisible'` render param does NOT exist — Context7 docs (queried 2026-04-08) show only `size: 'normal' | 'flexible' | 'compact'`. Visibility is a dashboard concern, not a client-side size concern.
  - Because the dashboard mode is Invisible, `appearance: 'interaction-only'` and `theme: 'dark'` are both moot. The plan's render config includes only `sitekey`, `execution: 'execute'`, and the three callbacks.
  - The `turnstile.execute()` API is documented as single-argument (`execute(widgetId | selector)`) — per-execute callback overrides are NOT part of the public API, so Task 5's Promise-wrap uses render-time callbacks + module-level pending-resolver state. Don't invent a two-arg signature.

- **Coupling with `agentCommunity_PAGE`.** This plan intentionally creates narrow, observable coupling points that sub-agents and future edits MUST respect:
  1. The four shared CF namespace IDs (`4001`, `4005`, `4006`, `4007`) MUST match PAGE's `wrangler.jsonc`. If PAGE changes them, DMV silently drifts out of the shared counter (no error, just split keyspaces). **Guard:** `pnpm ratelimit:check` (added in Task 10) asserts this — opt-in, run manually or in a pre-push hook.
  2. The shared KV namespace id (`c0e0d88fff1a4c59805ab85c7a03100f`) MUST match PAGE's. Same drift risk, same guard script.
  3. The email-hash keying function MUST produce the same bytes as PAGE's. The vendored `worker/normalize-email.ts` is a byte-identical copy and its header comment explicitly says "re-vendor on PAGE changes". If PAGE switches from `normalizeEmail` to `normalizeEmailDeep` (gmail dot removal), DMV's keys land in a different keyspace within the shared namespace and the sharing benefit is lost.
  4. The rate-limit key format MUST match PAGE's (`otp:email:<hash>`, `otp:ip:<hash>`, `otp:ip-email:<hash>`). The `otp:` prefix is counterintuitive for DMV (which does registration, not OTP) but it's the prefix PAGE uses and so it's what the shared counter bucket reads from. Do NOT invent a `reg:*` prefix.

- **When DMV does NOT need to update in response to PAGE changes.** These are invisible:
  - PAGE bumps a limit value (e.g., `RL_AUTH` from 5/60s to 10/60s) — each Worker declares its own limit; the namespace is the shared counter only.
  - PAGE renames a binding without changing the `namespace_id` — binding `name` is a local JS identifier.
  - PAGE adds new limiters DMV doesn't use.
  - PAGE refactors its internal shim — DMV has its own vendored copy.
  - PAGE changes its Analytics Engine schema — DMV has its own `dmv_worker_events` dataset.

- **CSP impact.** Adding `challenges.cloudflare.com` to `script-src`, `connect-src`, and new `frame-src` is required. `frame-src` is still required in Invisible mode because Turnstile creates a hidden iframe internally. Both `public/_headers` and `worker/index.ts` `PERMALINK_CSP` must stay byte-identical.

- **Attribution.** Cloudflare's Turnstile ToS requires visible attribution regardless of widget mode. Task 4 Step 2b adds a small "Bot protection by Cloudflare Turnstile" line to the page footer. Don't hide or remove it.

- **Feature flag.** `USE_CF_RATE_LIMIT` is the unified kill switch for the entire rate-limit layer. Setting it to anything other than `"true"` causes `tryCfRateLimit()` to return `null`, which DMV treats as "rate limiting disabled, allow the request". Use this as the emergency escape hatch if a shared namespace causes a production incident:
  ```
  pnpm wrangler secret put USE_CF_RATE_LIMIT --text false
  ```
  Secrets override vars, so this takes effect without a redeploy. Revert with:
  ```
  pnpm wrangler secret delete USE_CF_RATE_LIMIT
  ```
  (which falls back to the `"true"` value in wrangler.jsonc vars).

- **Deploy order matters.** Worker first (adds new protection), then Supabase edge function (removes Upstash — which is redundant only because the Worker is now enforcing), then CLI publish. Deploying in any other order creates windows where the registration path is either unprotected (bad) or blocked (breaks users).

### Research log

- Cloudflare Workers Rate Limiting API — [Configuration docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit) (queried 2026-04-08): "Two rate limiting bindings that share the same `namespace_id` — even across different Workers on the same account — share the same rate limit counters for a given key. This is intentional and allows you to enforce a single rate limit across multiple Workers."
- Cloudflare Turnstile — [Client-side rendering + widget configurations](https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/widget-configurations) (queried 2026-04-08): confirmed `execution: 'execute'`, `appearance` modes, single-arg `turnstile.execute()`, and Invisible widget mode behavior. `size: 'invisible'` does not exist — visibility is a dashboard widget-mode concern.
- `agentCommunity_PAGE` rate-limit architecture: investigated via Explore agent 2026-04-08. Direct file reads of `lib/rate-limit-cf.ts`, `lib/rate-limit-kv.ts`, `lib/utils/normalize-email.ts`, `lib/cf-analytics.ts`, `lib/auth/rate-limit.ts`, `lib/auth/captcha.ts`, and `wrangler.jsonc` confirmed the shared-namespace IDs, shim signatures, and keying format. DMV's vendored files match PAGE's as of this plan's write date.
- Turnstile test site keys: [Testing docs](https://developers.cloudflare.com/turnstile/troubleshooting/testing/). `1x00000000000000000000AA` (always-pass) + `2x00000000000000000000AB` (always-fail) are the two DMV uses for local smoke. The `3x00000000000000000000FF` always-challenge key is not useful with Invisible widget mode.
- Upstash Ratelimit (being removed from DMV in Task 3, and from PAGE in their Phase 6 post-2026-04-15): [`@upstash/ratelimit` README](https://github.com/upstash/ratelimit-js).
