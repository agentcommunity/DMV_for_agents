# Cross-Repo Hardening Handoff Prompt

Paste this entire prompt into a fresh coding session that has access to both repos.

## Context

You have access to two repos:

- DMV repo worktree: `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening`
- PAGE repo: `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE`

Your job is to ship a cross-repo registration/rate-limit design that works with Cloudflare as it exists today.

Do NOT execute the older DMV-only hardening plan as written. It is superseded by this prompt.

## Why The Older DMV-Only Plan Is Superseded

1. It spent shared Cloudflare counters before verifying Turnstile on browser traffic.
Reason: that lets invalid or missing CAPTCHA requests burn shared quota and lock out real users.

2. It coupled DMV to PAGE too aggressively by sharing `RL_AUTH`, `RL_OTP_IP`, and `KV_RATE_LIMIT`.
Reason: only some abuse surfaces are actually the same across both products; the rest should stay property-local.

3. It documented a rollback path based on `wrangler secret put`, but that path is operationally blocked on the DMV worker in the current account state.
Reason: a kill switch that cannot actually be flipped is not a real operational control.

4. It used incorrect Turnstile local test keys.
Reason: the official invisible/pass-fail test keys end in `BB`, not `AA`.

## Source-Of-Truth Design Decisions

Implement this design unless current code in either repo forces a clearly better variant.

### 1. Share only the counters that represent the same abuse surface

Shared across PAGE and DMV:

- `RL_OTP_EMAIL`
- `RL_OTP_IP_EMAIL`

Do NOT share across PAGE and DMV:

- `RL_AUTH`
- `RL_OTP_IP`
- KV cooldown state

Brief explainer:
Email and IP+email combo are the two signup surfaces that really should count across both properties. Plain IP is too blunt and hurts shared networks. `RL_AUTH` is a broader auth bucket and PAGE's live OTP path does not currently use it. KV cooldowns represent product-specific business rules, not shared burst protection.

### 2. Keep KV cooldowns local to each repo

PAGE:
- keep PAGE-local KV cooldown for OTP

DMV:
- add a DMV-local KV namespace for fingerprint cooldown

Brief explainer:
Cloudflare KV is eventually consistent and acceptable for coarse local cooldowns, but sharing KV across repos creates operational coupling without meaningful benefit.

### 3. Browser order must be CAPTCHA first, shared counters second

Browser flows must be:

1. parse + validate
2. verify Turnstile
3. apply shared Cloudflare rate limits
4. apply any product-local cooldown if applicable
5. continue upstream

Brief explainer:
If shared counters run first, an attacker can burn quota with invalid CAPTCHA requests.

### 4. CLI/MCP should never require Turnstile

CLI and MCP flows must use:

1. parse + validate
2. require machine fingerprint
3. shared short-window Cloudflare rate limits
4. DMV-local KV fingerprint cooldown
5. continue upstream

Brief explainer:
Headless clients cannot solve CAPTCHA. The anti-abuse story there is shared short-window counters plus the DMV machine-fingerprint cooldown.

### 5. Turnstile widgets and validation must be property-specific

PAGE:
- own site key
- own action, for example `page_otp_request`
- verify `hostname` and `action` server-side

DMV:
- own site key
- own action, for example `dmv_register`
- verify `hostname` and `action` server-side

Brief explainer:
A Turnstile token should be scoped to the property and route intent that generated it. Do not treat a generic `success: true` as sufficient.

### 6. Do not build the rollback story around blocked secret commands

If `wrangler secret put` is still blocked for the DMV worker, do not document it as the primary emergency control. Use deploy-time config or dashboard-managed controls that the team can actually operate.

### 7. Use one public site-key source per frontend

Do not duplicate a public Turnstile site key in multiple unrelated places if it can drift.

Preferred:
- PAGE uses its existing public env / frontend config path
- DMV uses a single frontend-consumed source, either a meta tag sourced from build config or a single JS config source

## Cloudflare Constraints To Respect

These are the key platform facts this design depends on:

- Shared `namespace_id` values on Workers Rate Limiting bindings share counters across workers on the same account.
- Worker rate-limit binding periods are still only `10` or `60` seconds.
- Cloudflare explicitly recommends not using IP as the main identifier for rate limiting.
- Turnstile Siteverify is mandatory.
- Turnstile tokens are single-use and short-lived.
- Siteverify returns fields like `hostname` and `action`; validate them.
- KV is eventually consistent and fine for coarse cooldowns, not precise cross-product coordination.

## Required Reading Before Editing

Read the actual current files first. Do not trust stale plan text over code.

### PAGE repo

- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/wrangler.jsonc`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/auth/rate-limit.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/rate-limit.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/rate-limit-cf.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/rate-limit-kv.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/auth/captcha.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/app/api/auth/otp/request/route.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/features/auth/components/turnstile-captcha.tsx`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/app/api/auth/otp/request/__tests__/route.test.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/agentCommunity_PAGE/lib/auth/__tests__/rate-limit.test.ts`

### DMV repo

- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/wrangler.jsonc`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/worker/index.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/supabase/functions/register-agent/index.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/js/supabase.js`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/js/CRTTerminal.js`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/index.html`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/public/_headers`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/packages/dmv-agent/src/register.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/packages/dmv-agent/src/rate-limit.ts`
- `/Users/user/dev/PROJECTS/AgentCommunity/AgentCommunity_DMV/.worktrees/api-hardening/packages/dmv-agent/src/mcp-server.ts`

## Concrete Target State

### PAGE target state

Keep PAGE's current OTP route architecture, but tighten it where needed:

- Turnstile verification stays before shared rate-limit counters.
- PAGE continues to own its local OTP cooldown behavior.
- PAGE continues to use `RL_OTP_EMAIL` and `RL_OTP_IP_EMAIL`.
- PAGE may keep `RL_AUTH` and `RL_OTP_IP` for PAGE-only use if they still serve other flows, but DMV should not adopt them as shared signup semantics.
- Server-side CAPTCHA validation should verify `hostname` and `action`, not just `success`.
- Add or update tests so the active CF+KV path and ordering are covered.

### DMV target state

Build `/api/register` in the DMV Cloudflare worker as the canonical path for new traffic.

Browser flow:

1. browser submits to DMV `/api/register`
2. worker validates JSON shape
3. worker verifies Turnstile
4. worker checks shared `RL_OTP_EMAIL`
5. worker checks shared `RL_OTP_IP_EMAIL`
6. worker forwards to Supabase `register-agent`

CLI/MCP flow:

1. CLI/MCP submits to DMV `/api/register`
2. worker validates JSON shape
3. worker requires `machine_fingerprint`
4. worker checks shared `RL_OTP_EMAIL`
5. worker checks shared `RL_OTP_IP_EMAIL`
6. worker checks DMV-local KV fingerprint cooldown
7. worker forwards to Supabase `register-agent`

Supabase edge function:

- delete all Upstash rate limiting from `register-agent`
- keep validation
- keep the SQL lifetime cap
- keep direct access temporarily for old clients
- later, after adoption, close the bypass with a proxy header check

Frontend:

- DMV browser JS must submit to same-origin `/api/register`
- Invisible Turnstile widget should be rendered explicitly and executed on submit
- verify failure should block submission cleanly
- do not send browser traffic directly to Supabase anymore

CLI and MCP:

- CLI endpoint must switch from direct Supabase function URL to `https://dmv.agentcommunity.org/api/register`
- MCP should inherit the same register path if it reuses the CLI registration function

## Shared Binding Strategy

Use the existing PAGE shared IDs only for the counters that should really be shared:

- `RL_OTP_EMAIL` -> namespace `4005`
- `RL_OTP_IP_EMAIL` -> namespace `4007`

Do not create DMV bindings that share PAGE's:

- `RL_AUTH` (`4001`)
- `RL_OTP_IP` (`4006`)

If DMV needs a coarse per-IP pre-filter to protect Siteverify volume, make it DMV-local with its own new namespace ID and document it as local-only.

## Turnstile Implementation Guidance

### PAGE

- keep current explicit-render pattern if it already works
- add `action` when rendering
- validate `hostname` and `action` on the server

### DMV

- use Invisible widget mode
- use explicit render
- use `execution: 'execute'`
- set an explicit action like `dmv_register`
- on the server, reject if Siteverify says:
  - `success !== true`
  - `hostname` is not the DMV host
  - `action` does not match `dmv_register`

### Local testing

Use the official Turnstile testing keys from Cloudflare docs. The always-pass and always-fail invisible keys end in `BB`.

Before commit or deploy:

- revert any testing keys
- confirm production keys are restored

## Suggested Execution Order

1. Read both repos and report any drift from this prompt before editing.
2. Update PAGE server-side Turnstile validation and tests first if needed.
3. Add DMV worker bindings and local KV wiring.
4. Implement DMV `/api/register` worker proxy with corrected ordering.
5. Remove Upstash from DMV Supabase `register-agent`.
6. Switch DMV browser to `/api/register` + Invisible Turnstile.
7. Switch DMV CLI/MCP to `/api/register`.
8. Run local smoke tests in both repos.
9. Do a final cross-repo review before any deploy.

## Non-Negotiable Do-Nots

- Do not ship a browser path that burns shared CF counters before Turnstile passes.
- Do not share DMV fingerprint cooldown state with PAGE.
- Do not describe `RL_AUTH` as part of shared signup semantics unless PAGE live traffic actually uses it for the same abuse surface.
- Do not assume secret-based rollback if secret writes are still blocked.
- Do not use stale Turnstile test keys from the older DMV-only plan.
- Do not change container code in DMV unless you discover a directly related blocker.
- Do not add new npm dependencies unless strictly necessary.

## Minimum Verification Checklist

### PAGE

- invalid Turnstile token fails before rate limiting
- valid Turnstile token continues to rate-limit logic
- server validates expected `hostname` and `action`
- existing OTP flow still works end-to-end

### DMV

- browser submit goes to `/api/register`, not Supabase direct
- browser request without valid Turnstile is rejected before shared counters are spent
- CLI request without `machine_fingerprint` is rejected
- CLI request with fingerprint hits DMV-local KV cooldown after shared short-window CF checks
- Supabase `register-agent` no longer contains Upstash logic
- old direct Supabase route still works until bypass closure is intentionally scheduled later

## Reporting Format

When you report back, use this structure:

1. What drift you found between this prompt and the live repos
2. What you changed in PAGE
3. What you changed in DMV
4. Any namespace IDs or local-only bindings you introduced
5. What you verified locally
6. What remains deferred

## Brief Decision Explainers To Preserve In Docs/PRs

- Shared email and IP+email counters:
  These represent the same signup abuse surface on both properties, so one counter is valuable.

- No shared IP-only counter:
  IP-only limits are too blunt for shared networks and are explicitly a poor primary key at the Cloudflare layer.

- No shared KV:
  KV cooldowns encode product-specific rules and are eventually consistent, so local ownership is safer.

- CAPTCHA before shared counters:
  Prevents invalid-token traffic from exhausting quota for real users.

- Separate Turnstile actions/hostnames:
  Prevents a token minted for one property or flow from being treated as valid for another.

- CLI/MCP uses fingerprint instead of CAPTCHA:
  Headless tooling cannot solve interactive bot checks.
