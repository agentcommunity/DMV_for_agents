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
status              TEXT        -- 'pending_profile' (set by register-agent)
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
| `register-agent` | POST | Registration proxy (validates, rate limits, inserts) |
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

```bash
curl -X POST \
  https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' \
  -d '{"agent_name": "test-deploy", "email": "test@example.com"}'
```

Expected: `201` with `certificate_id`, `agent_name`, `domain`, `registration_type`, `permalink_url`, `badge_url`, `badge_card_url`, `message`.

### Test error cases

```bash
# Missing fields → 400
curl -X POST .../register-agent -H 'Content-Type: application/json' -d '{}'

# Invalid agent name → 400
curl -X POST .../register-agent -H 'Content-Type: application/json' \
  -d '{"agent_name": "AB", "email": "x@y.com"}'

# Duplicate certificate_id → 409 (same user + same agent name + same type)
# Returns: "Agent already registered" + certificate_id + permalink_url

# Rate limit → 429 (after 3 registrations with same email within an hour)
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

- **Supabase dashboard → Edge Functions → register-agent** — invocation count, error rate, latency
- **Supabase dashboard → Table Editor → registrations** — row count, any anomalies
- **Rate limiting** — check if 3/email/hr and 10/IP/hr are the right thresholds (adjust in edge function if needed)
- **Duplicate certs** — 409 responses mean same user tried to re-register the same agent (expected, they get their cert ID back)

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Network error: could not reach DMV registration service` | Edge function not deployed or Supabase down | `supabase functions deploy register-agent` |
| `Registration failed (HTTP 500)` | Service role key not set or DB schema mismatch | Check Supabase dashboard → Edge Functions → Logs |
| `Agent already registered` (409) | Same user re-registering same agent | Expected — returns cert ID + permalink for recovery |
| `Rate limited` (429) | Too many registrations from same email/IP | Wait an hour, or adjust thresholds |
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
User's machine                          Supabase cloud (shared agentcommunity project)
──────────────                          ──────────────────────────────────────────────

 ┌───────────────────┐                  ┌──────────────────────┐
 │ Claude Code        │   POST          │ register-agent (DMV)  │
 │  /dmv skill        │──────────────▶│ validate, rate limit  │
 │  MCP tool          │                │ generate cert, INSERT │
 └───────────────────┘                  └──────────┬───────────┘
                                                    │
 ┌───────────────────┐   POST                      │
 │ Web UI             │──────────────────────────┘  │
 │ js/supabase.js     │                              │
 └───────────────────┘                              │
                                                    ▼
                                      ┌────────────────────────┐
                                      │ Supabase DB             │
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

 ┌───────────────────┐   GET           ┌──────────────────────┐
 │ GitHub README      │──────────────▶│ badge (DMV)            │
 │ <img src=badge>    │                │ SVG by cert ID only    │
 └───────────────────┘                └──────────┬───────────┘
                                                    │ reads
 ┌───────────────────┐   GET                       │
 │ Any HTTP client    │──────────────▶┌────────────▼───────────┐
 │ curl, agents, etc  │               │ lookup-agent (DMV)      │
 └───────────────────┘               │ single (by cert ID) or  │
                                      │ array (by domain)       │
                                      └───────────────────────┘
```

**Zero secrets in client code. All database access goes through edge functions.**
**DMV INSERTs, agentcommunity.org reacts (trigger chain). Clean boundary.**
