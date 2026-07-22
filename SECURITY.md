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
- The Cloudflare Worker `dmv-agentcommunity` (`/api/register`, the staged
  certificate-verification route at `/api/lookup`, `/api/card`, `/api/og`, `/badge/*`,
  `/c/:id/:name`)
- Supabase Edge Functions (live secret-gated registration, the staged
  `lookup-agent` secret gate, and badge)
- The `@agentcommunity/dmv-agent` npm package
- Certificate ID generation and verification logic
- Cloudflare Turnstile integration on the browser registration flow

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
- Anti-abuse on `/api/register` is owned by the Cloudflare Worker, not the Supabase edge function. Browser path: validate → Turnstile siteverify (server-side hostname + `dmv_register` action check) → shared CF rate limits (`RL_OTP_EMAIL` 5/60s, `RL_OTP_IP_EMAIL` 4/60s — both `namespace_id` values shared at the CF account level with `agentCommunity_PAGE`) → forward to Supabase. CLI/MCP path: validate → require `machine_fingerprint` → same shared limits → DMV-local KV fingerprint cooldown (`REGISTER_COOLDOWN_KV`) → forward. CAPTCHA always runs before shared counters so invalid tokens cannot exhaust quota for real users. Upstash Redis was removed in the 2026-04-08 hardening pass.
- The staged public certificate verification boundary is
  `GET /api/lookup?id=CERT-ID` on the
  Worker. It accepts certificate IDs, enforces 30 valid requests per 60 seconds
  per IP with `RL_CERT_LOOKUP` plus the authoritative `REGISTER_COOLDOWN_KV`
  bucket, and returns a minimized six-field response. The staged Supabase
  `lookup-agent` change makes the Edge Function an internal upstream: it requires the
  Worker-set `x-dmv-proxy: DMV_PROXY_SECRET` value, compares it in constant
  time, fails closed when the secret is unset, and rejects direct callers before
  creating a Supabase client. Domain lookup is unsupported. These lookup
  changes are implementation-ready but unpublished as of 2026-07-22; they are
  not production claims until Task 7 records a deployed SHA and live smoke
  evidence.
- The Supabase edge function still runs validation, the lifetime cap, and the unique-cert-ID constraint as a defense-in-depth backstop.
