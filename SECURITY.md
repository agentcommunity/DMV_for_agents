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
- The Cloudflare Worker `dmv-agentcommunity` (`/api/register`, `/api/card`, `/api/og`, `/badge/*`, `/c/:id/:name`)
- Supabase Edge Functions (registration upstream, lookup, badge)
- The `@agentcommunity/dmv-agent` npm package
- Certificate ID generation and verification logic
- Cloudflare Turnstile integration on the browser registration flow

## What's out of scope

- Denial of service attacks
- Social engineering of project maintainers
- Issues in third-party dependencies (report those upstream)

## Architecture notes

- Zero secrets in client code — the worker holds `TURNSTILE_SECRET_KEY`, the edge function holds `SUPABASE_SERVICE_ROLE_KEY`
- Service role keys are only in Supabase's runtime environment, never in source
- Certificate IDs are content-addressed hashes, not sequential — no enumeration risk
- Anti-abuse on `/api/register` is owned by the Cloudflare Worker, not the Supabase edge function. Browser path: validate → Turnstile siteverify (server-side hostname + `dmv_register` action check) → shared CF rate limits (`RL_OTP_EMAIL` 5/60s, `RL_OTP_IP_EMAIL` 4/60s — both `namespace_id` values shared at the CF account level with `agentCommunity_PAGE`) → forward to Supabase. CLI/MCP path: validate → require `machine_fingerprint` → same shared limits → DMV-local KV fingerprint cooldown (`REGISTER_COOLDOWN_KV`) → forward. CAPTCHA always runs before shared counters so invalid tokens cannot exhaust quota for real users. Upstash Redis was removed in the 2026-04-08 hardening pass.
- The Supabase edge function still runs validation, the lifetime cap, and the unique-cert-ID constraint as a defense-in-depth backstop.
