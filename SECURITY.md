# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in the DMV, please report it responsibly.

**Email:** security@agentcommunity.org

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

We'll acknowledge your report within 48 hours and work with you on a fix before any public disclosure.

## What's in scope

- The web application at dmv.agentcommunity.org
- The Cloudflare Worker `dmv-agentcommunity` (`/api/register`, the live
  certificate-verification route at `/api/lookup`, `/api/card`, `/api/og`, `/badge/*`,
  `/c/:id/:name`)
- Supabase Edge Functions (live secret-gated registration and `lookup-agent`, and badge)
- The `@agentcommunity/dmv-agent` npm package
- Certificate ID generation and verification logic
- Cloudflare Turnstile integration on the browser registration flow

## Package supply chain

- `@agentcommunity/dmv-agent` is the one canonical capability; `dmv-agent` is
  compatibility-only, and alias source `0.1.3` must use the exact approved
  dependency range `@agentcommunity/dmv-agent@^0.3.0`.
- The package verifier uses explicit archive allow-lists, exact license/docs
  bytes, exact dependency/lifecycle/publish configuration, secret scans,
  script-disabled clean installs, bounded registry requests, and SRI checks.
  Production operations are opt-in via `--production-smoke`; they never perform
  a registration or business-data write, but do consume quota and may populate
  caches.
- npm publication is restricted to the main-only GitHub-hosted OIDC workflow,
  canonical first. Candidate code never receives OIDC authority. Registry
  signatures are not provenance; post-publish evidence separately requires
  `npm audit signatures` cryptographic verification and exact SLSA source,
  workflow, ref, commit, builder, and artifact bindings. Trusted-publisher and
  protected-environment configuration remains an npm/GitHub owner action, and
  no long-lived npm release token belongs in this repository.

## What's out of scope

- Denial of service attacks
- Social engineering of project maintainers
- Issues in third-party dependencies (report those upstream)

## Architecture notes

- Zero secrets in client code — the Worker holds `TURNSTILE_SECRET_KEY` and
  `DMV_PROXY_SECRET`; the Edge Functions hold `DMV_PROXY_SECRET` and
  `SUPABASE_SERVICE_ROLE_KEY`
- Service role keys and the shared proxy secret are only in their server-side
  runtime environments, never in source
- Certificate IDs are content-addressed hashes rather than sequential values,
  which makes blind guessing harder. The lookup rate limit mitigates but does
  not eliminate enumeration risk.
- Anti-abuse on `/api/register` is owned by the Cloudflare Worker, not the Supabase edge function. Browser path: validate → Turnstile siteverify (server-side hostname + `dmv_register` action check) → shared CF rate limits (`RL_OTP_EMAIL` 5/60s, `RL_OTP_IP_EMAIL` 4/60s — both `namespace_id` values shared at the CF account level with `agentCommunity_PAGE`) → forward to Supabase. The live CLI/MCP path validates `machine_fingerprint`, applies the shared limits, then claims the exact `REGISTER_FINGERPRINT_LIMITER` SQLite Durable Object before upstream. One object per SHA-256 fingerprint hash transactionally caps the rolling budget at three. Only well-formed fresh 201 mints commit; only audited pre-INSERT 400/403/409 responses and exact 200 replays release. Every uncertain outcome stays pending for 600 seconds, then counts for 24 hours. The 600 seconds cover Supabase's documented 150-second request-idle timeout + 400-second Edge Function wall clock + a 50-second safety margin; the Worker's separate 45-second abort does not claim to cancel remote execution. Raw fingerprints and IPs never enter object storage. V3 is live as of 2026-08-02, and every recovery Worker must preserve v1/v2/v3 as forward-only production state. CAPTCHA always runs before shared counters so invalid tokens cannot exhaust quota for real users. Upstash Redis was removed from the Supabase edge function in the 2026-04-08 hardening pass.
- The live public certificate verification boundary is
  `GET /api/lookup?id=CERT-ID` on the
  Worker. It accepts certificate IDs, applies coarse/eventually consistent
  `RL_CERT_LOOKUP` at 60/60, then uses one `CERT_LOOKUP_LIMITER` SQLite Durable
  Object per SHA-256 hashed IP for exact transactional 30/60 accounting and
  remaining/reset values. Responses produced before an authoritative Durable
  Object decision omit guessed remaining/reset telemetry. Durable Object failure fails closed before cache or
  upstream; `BADGE_CACHE_KV` stores results only. The Supabase
  `lookup-agent` function is an internal upstream with exact
  typed HTTP 200 `issued`/`not_found` envelopes: it requires the
  Worker-set `x-dmv-proxy: DMV_PROXY_SECRET` value, compares it in constant
  time, fails closed when the secret is unset, and rejects direct callers before
  creating a Supabase client. Non-200 or malformed envelopes are unavailable
  and uncached. Domain lookup is unsupported. The boundary is live: merged
  `main` `fabafe6` (PR #20) is Worker version
  `d9755e66-3883-4970-be84-a59307011f14` created `2026-07-22T12:01:52.501Z`.
  Production checks recorded `200 issued` for `REEF-068-BD0Q`, `200 not_found`
  for `ZZZZ-FFF-FFFD`, `400` for `INVALID`, an exact 31st-call `429`, and
  secretless direct Edge `403 direct_access_deprecated`. The direct Edge URL is
  not a client API.
- The Supabase edge function still runs validation, the lifetime cap, and the unique-cert-ID constraint as a defense-in-depth backstop.
