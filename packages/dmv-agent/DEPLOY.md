# DMV Agent — Go Live Checklist

Step-by-step guide to take the DMV agent registration system from dev to production.

---

## Prerequisites

- [ ] Supabase CLI installed (`brew install supabase/tap/supabase`)
- [ ] Logged in to Supabase (`supabase login`)
- [ ] Linked to the agentcommunity project (`supabase link --project-ref tcymqfwwphacnosnnzxl`)
- [ ] npm account with publish access to `@agentcommunity` scope

---

## 1. Database — Supabase

The `registrations` table should already exist in the shared agentcommunity Supabase project. Verify it has the right schema:

```sql
-- Required columns (check in Supabase dashboard → Table Editor)
registration_type   TEXT        -- 'INDIVIDUAL' | 'ORGANIZATION' | 'AGENT'
full_name           TEXT        -- nullable (required for INDIVIDUAL/ORGANIZATION)
organization_name   TEXT        -- nullable (required for ORGANIZATION)
domain_requested    TEXT        -- e.g. 'my-agent.agent' (NOT unique — pre-registration model)
email               TEXT
certificate_id      TEXT        -- UNIQUE partial index (WHERE certificate_id IS NOT NULL)
signup_source       TEXT        -- 'ui' | 'cli' | 'mcp' | 'api'
status              TEXT        -- 'provisional_dmv' (set by register-agent)
user_id             UUID        -- nullable (set by trigger, NOT by register-agent)
metadata            JSONB       -- { agent_description, client_ip }
created_at          TIMESTAMPTZ -- default now()
```

### Key constraints

- `domain_requested` is NOT unique — multiple users can pre-register the same `.agent` domain
- `certificate_id` has a UNIQUE partial index — prevents same user re-registering the same agent
- `user_id` is nullable — register-agent INSERTs with NULL, the `on_dmv_registration` trigger fills it in
- CHECK constraints enforce `full_name` for INDIVIDUAL/ORGANIZATION and `organization_name` for ORGANIZATION

### Trigger chain (managed by agentcommunity.org)

On INSERT where `certificate_id IS NOT NULL`, the `on_dmv_registration` trigger fires asynchronously (pg_net) and calls the `handle-dmv-registration` edge function on the agentcommunity.org side. This:
- Creates or finds an auth user by email
- Sends a magic link (new users only)
- Upserts the domain into `user_domains`
- Sends a certificate email with badge embed codes
- Updates or deletes the temporary registration row

DMV does NOT create auth users, send emails, or write to `user_domains`.

### RLS policies

```sql
-- Anon users should NOT have direct access (all writes go through edge function)
-- The edge function uses the service role key, which bypasses RLS
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
-- No policies = deny all for anon role
```

---

## 2. Edge Function — Deploy

Three edge functions live in `supabase/functions/`:

| Function | Method | Purpose |
|----------|--------|---------|
| `register-agent` | POST | Worker upstream — validates, lifetime cap, generates cert, INSERTs. Anti-abuse lives in the worker. |
| `lookup-agent` | GET | Public read-only lookup by cert ID or domain |
| `badge` | GET | SVG badge generator (flat for READMEs, card for websites) |

```bash
# Deploy all three from project root
supabase functions deploy register-agent
supabase functions deploy lookup-agent
supabase functions deploy badge
```

This automatically injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` as environment variables — no manual config.

### Verify it's running

The canonical path is the Cloudflare Worker, not the Supabase URL directly:

```bash
# Worker (canonical) — requires machine_fingerprint for non-browser traffic
curl -X POST https://dmv.agentcommunity.org/api/register \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_name": "test-deploy",
    "email": "test@example.com",
    "operator_name": "Test",
    "registration_type": "AGENT",
    "signup_source": "cli",
    "machine_fingerprint": "test_fingerprint_64chars_long_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
  }'

# Legacy direct (still works for backwards compat, scheduled to close):
curl -X POST \
  https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' \
  -d '{"agent_name": "test-deploy", "email": "test@example.com"}'
```

Expected: `201` with `certificate_id`, `agent_name`, `domain`, `registration_type`, `permalink_url`, `badge_url`, `badge_card_url`, `message`.

### Test error cases

```bash
# Missing fields → 400
curl -X POST .../api/register -H 'Content-Type: application/json' -d '{}'

# Invalid agent name → 400
curl -X POST .../api/register -H 'Content-Type: application/json' \
  -d '{"agent_name": "AB", "email": "x@y.com"}'

# CLI/MCP missing machine_fingerprint → 400 machine_fingerprint_required
curl -X POST .../api/register -H 'Content-Type: application/json' \
  -d '{"agent_name": "x", "email": "x@y.com", "signup_source": "cli"}'

# Browser missing Turnstile token → 400 turnstile_required
curl -X POST .../api/register -H 'Content-Type: application/json' \
  -d '{"agent_name": "x", "email": "x@y.com", "signup_source": "ui"}'

# Duplicate certificate_id → 409 (same user + same agent name + same type)
# Returns: "Agent already registered" + certificate_id + permalink_url

# Rate limit → 429 with Retry-After: 60
# Triggers: 6+ registrations to the same email within 60s, OR
#           5+ registrations to the same (IP, email) combo within 60s
```

---

### Verify lookup & badge

```bash
BASE=https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1

# Lookup by cert ID → 200 JSON
curl "$BASE/lookup-agent?id=MESA-DD6-660J"

# Lookup by domain → 200 JSON (array — multiple pre-registrations possible)
curl "$BASE/lookup-agent?domain=my-assistant"

# Invalid cert → 400
curl "$BASE/lookup-agent?id=FAKE-000-0000"

# Flat badge SVG (for GitHub READMEs)
curl "$BASE/badge?id=MESA-DD6-660J" -o badge.svg

# Card badge SVG (for websites)
curl "$BASE/badge?id=MESA-DD6-660J&style=card" -o badge-card.svg

# Badge by domain → 400 (deprecated, ambiguous with multiple pre-registrations)
curl "$BASE/badge?domain=my-assistant&style=card"
```

### Badge embed codes

After registration, users get these snippets:

**GitHub README (Markdown):**
```markdown
[![my-assistant.agent](https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J)](https://dmv.agentcommunity.org/c/MESA-DD6-660J/my-assistant)
```

**Website (HTML):**
```html
<a href="https://dmv.agentcommunity.org/c/MESA-DD6-660J/my-assistant">
  <img src="https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J&style=card" alt="my-assistant.agent — DMV Certificate" />
</a>
```

---

## 3. Web UI — Enable Supabase

In `js/supabase.js`, flip the feature flag:

```js
export const SUPABASE_ENABLED = true;  // was false
```

Then bump the cache-busting version:
- `js/supabase.js` import in `app.js`: `?v=N` → `?v=N+1`
- `index.html` script tag: `?v=N` → `?v=N+1`

---

## 4. NPM Package — Publish

```bash
cd packages/dmv-agent
pnpm build
npm publish --access public
```

### Verify it works

```bash
# In a fresh directory
bunx @agentcommunity/dmv-agent verify MESA-DD6-660J
# Should print: ✓ Certificate MESA-DD6-660J has a valid check digit.

bunx @agentcommunity/dmv-agent register
# Should prompt for agent name, email, etc.
# Should succeed if edge function is deployed
```

### MCP server test

Add to a test project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "dmv": {
      "command": "bunx",
      "args": ["@agentcommunity/dmv-agent"]
    }
  }
}
```

Open Claude Code, ask it to register an agent → should call `register_agent` tool → should succeed.

### Skill test

```bash
mkdir -p .claude/skills
cp -r node_modules/@agentcommunity/dmv-agent/skills/dmv .claude/skills/
```

Type `/dmv` in Claude Code → should guide through registration via CLI.

---

## 5. Post-Launch Monitoring

### Things to watch

- **Cloudflare dashboard → Workers → dmv-agentcommunity → Logs** — `/api/register` invocation count, error rate, Turnstile siteverify failures
- **Cloudflare dashboard → Workers → dmv-agentcommunity → Analytics Engine → `dmv_worker_events`** — query `register_attempt` events by status (`2xx`, `4xx`, `5xx`, `rate_limited`, `fingerprint_cooldown`, `turnstile_required`, `turnstile_failed`, `validation`, `invalid_json`)
- **Supabase dashboard → Edge Functions → register-agent** — invocation count, error rate, latency (now strictly worker-forwarded plus the temporary direct bypass)
- **Supabase dashboard → Table Editor → registrations** — row count, any anomalies
- **Rate limiting** — shared CF limits are 5/email/60s and 4/(IP+email)/60s. Adjust in `wrangler.jsonc` `ratelimits` array, but remember the namespace IDs are shared with `agentCommunity_PAGE` — coordinate with that repo before changing values.
- **Duplicate certs** — 409 responses mean same user tried to re-register the same agent (expected, they get their cert ID back)

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Network error: could not reach DMV registration service` | Worker not deployed, Cloudflare DNS issue, or Supabase down | `pnpm cf:deploy` from repo root, then check `pnpm cf:tail` |
| `turnstile_failed` (400) on browser | Wrong `TURNSTILE_SECRET_KEY` on the worker, or stale token | Check Cloudflare dashboard → Workers → dmv-agentcommunity → Variables and Secrets → confirm `TURNSTILE_SECRET_KEY` is encrypted Secret type |
| `machine_fingerprint_required` (400) on CLI | CLI on old version not sending fingerprint | Bump CLI dependency to latest `@agentcommunity/dmv-agent` |
| `Registration failed (HTTP 500)` | Service role key not set or DB schema mismatch | Check Supabase dashboard → Edge Functions → Logs |
| `Agent already registered` (409) | Same user re-registering same agent | Expected — returns cert ID + permalink for recovery |
| `Rate limited` (429) | Too many registrations from same email or (IP, email) within 60s | Wait 60s. Check shared CF rate limit counters in Cloudflare dashboard. |
| `fingerprint_cooldown` (429) | CLI/MCP machine fingerprint exceeded local KV cooldown | Wait `retry_after_seconds`. Counter is in DMV-local `REGISTER_COOLDOWN_KV`. |
| CLI hangs on `bunx` | Package not published or npm registry cache | Try `npx @agentcommunity/dmv-agent` or `bunx --force` |

---

## 6. Future — Not Yet Implemented

These are noted for future work, not needed for go-live:

- [ ] **Link/visit tracking** — Track permalink visits (`/c/CERT-ID/agent-name`) to measure sharing virality. Needs: a `card_views` table (cert_id, viewer_ip_hash, referrer, user_agent, timestamp), a lightweight edge function or analytics endpoint, and client-side fire-and-forget POST on permalink load. This is critical for understanding card sharing conversion (view → "Get Yours" click → registration).
- [x] **Email verification flow** — Magic link sent by agentcommunity.org trigger (on_dmv_registration). New users get magic link + certificate email. Existing users get certificate email only.
- [ ] **Google/GitHub OAuth** — alternative to email verification
- [x] **Domain lookup endpoint** — `lookup-agent` edge function (built, deploy with others)
- [x] **Badge by cert ID** — `badge` edge function (domain lookup deprecated)
- [ ] **Real OG images** — server-side card rendering for social media previews (front face of HoloCard as static PNG)
- [ ] **Python SDK** — thin wrapper that shells out to `bunx` for cross-language support
- [ ] **Admin dashboard** — view registrations, manage verifications, handle disputes

---

## Architecture Reference

```
User's machine             Cloudflare Worker                  Supabase cloud
──────────────             ──────────────────────             ──────────────

 ┌───────────────────┐    ┌─────────────────────┐           ┌──────────────────────┐
 │ Claude Code        │   │ /api/register        │           │ register-agent (DMV)  │
 │  /dmv skill        │──▶│ validate JSON        │──forward─▶│ validate (again)      │
 │  MCP tool          │   │ require fingerprint │           │ lifetime cap (DB)     │
 └───────────────────┘    │ shared CF limits     │           │ generate cert, INSERT │
                          │ DMV-local KV         │           └──────────┬───────────┘
 ┌───────────────────┐    │ cooldown             │                       │
 │ Web UI             │──▶│                      │                       │
 │ js/supabase.js     │   │ (browser path:       │                       │
 └───────────────────┘    │  Turnstile siteverify│                       │
                          │  before counters)    │                       │
                          │                      │                       ▼
                          │ 🔑 TURNSTILE_SECRET  │           ┌────────────────────────┐
                          └──────────────────────┘           │ Supabase DB             │
                                                              │ registrations table     │
                                                              └──────────┬─────────────┘
                                                                          │ AFTER INSERT trigger
                                                                          │ (certificate_id IS NOT NULL)
                                                                          ▼
                                                              ┌────────────────────────┐
                                                              │ handle-dmv-registration │
                                                              │ (agentcommunity.org)    │
                                                              │ → create/find auth user │
                                                              │ → magic link (new user) │
                                                              │ → upsert user_domains   │
                                                              │ → certificate email      │
                                                              └────────────────────────┘

 ┌───────────────────┐    ┌─────────────────────┐           ┌──────────────────────┐
 │ GitHub README      │──▶│ /badge/* worker      │──proxy──▶│ badge (DMV)            │
 │ <img src=badge>    │   │ (KV cache + header   │           │ SVG by cert ID only    │
 └───────────────────┘    │  hygiene)            │           └──────────┬───────────┘
                          └─────────────────────┘                        │ reads
 ┌───────────────────┐                                                   │
 │ Any HTTP client    │──────────────────────▶┌────────────▼───────────┐
 │ curl, agents, etc  │                        │ lookup-agent (DMV)      │
 └───────────────────┘                        │ single (by cert ID) or  │
                                                │ array (by domain)       │
                                                └───────────────────────┘
```

**Zero secrets in client code. The Cloudflare Worker holds the Turnstile secret;**
**Supabase holds the service role key. The worker is the public anti-abuse choke**
**point for `/api/register`; the edge function is strictly an upstream that**
**validates, applies the lifetime cap, and INSERTs.**
