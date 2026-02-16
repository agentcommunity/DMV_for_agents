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
- Supabase Edge Functions (registration, lookup, badge)
- The `@agentcommunity/dmv-agent` npm package
- Certificate ID generation and verification logic

## What's out of scope

- Denial of service attacks
- Social engineering of project maintainers
- Issues in third-party dependencies (report those upstream)

## Architecture notes

- Zero secrets in client code — all database writes go through edge functions
- Service role keys are only in Supabase's runtime environment, never in source
- Certificate IDs are content-addressed hashes, not sequential — no enumeration risk
- Rate limiting: 3 registrations per email per hour, 10 per IP per hour
