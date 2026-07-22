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
status              ENUM        -- NOT set by register-agent; uses DB default 'pending_profile'
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
- Links the DMV registration row for new users, or preserves the existing-user DMV row as audit evidence with `user_id` left null

DMV does NOT create auth users, send emails, or write to `user_domains`.

### RLS policies

```sql
-- Anon users should NOT have direct access (all writes go through edge function)
-- The edge function uses the service role key, which bypasses RLS
ALTER TABLE registrations ENABLE ROW LEVEL SECURITY;
-- No policies = deny all for anon role
```

---

## 2. Public API and Edge Functions — Deploy

Three edge functions live in `supabase/functions/`:

| Function | Method | Purpose |
|----------|--------|---------|
| `register-agent` | POST | Worker upstream — validates, lifetime cap, generates cert, INSERTs. Anti-abuse lives in the worker. |
| `lookup-agent` | GET | Internal Worker upstream — secret-gated lookup by certificate ID only |
| `badge` | GET | SVG badge generator (flat for READMEs, card for websites) |

The certificate-lookup Worker and Edge changes are live as of 2026-07-22.
Merged `main` `fabafe6` (PR #20, including the manual-redirect runtime fix) is
deployed as Worker version `d9755e66-3883-4970-be84-a59307011f14`, created
`2026-07-22T12:01:52.501Z`. The rollout record below is retained as the required
order and recovery checklist for future changes.

`DMV_PROXY_SECRET` must be the same generated secret on the Cloudflare Worker
and the Supabase project. Never put its value in `.env.example`, documentation,
shell history, or client configuration. The Worker also requires
`RL_CERT_LOOKUP` (coarse 60/60), `CERT_LOOKUP_LIMITER` (exact SQLite DO 30/60),
and `BADGE_CACHE_KV` (lookup result cache) as configured in `wrangler.jsonc`.
`REGISTER_COOLDOWN_KV` remains registration-only.

Before merging, run these container gates on a Docker-capable machine:

```bash
docker info
pnpm cf:container:build
```

Any Docker CLI error text is a failed gate even if a wrapper later exits zero. The
2026-07-22 implementation host has no Docker/Podman runtime, so these gates and the
real Worker rollout must run in Cloudflare's build environment or another
Docker-capable environment.

### Completed rollout evidence

The completed rollout used the order below. Final production results were:

- `REEF-068-BD0Q` → `200 issued` (`masato`); `ZZZZ-FFF-FFFD` → `200 not_found`;
  `INVALID` → `400`.
- Exact limiter calls 1–30 were allowed; call 31 returned `429` with remaining
  `0`; a next-minute call returned `200` with remaining `29`.
- Secretless direct `lookup-agent` access returned `403 direct_access_deprecated`.
- `/healthz` returned JSON `200`; badge returned SVG `200`; permalink returned
  HTML `200`; card returned PNG `200`; validation-only `GET /api/register`
  returned `405`.
- No Supabase registration or member rows were deleted or mutated during
  verification. The limiter and result-cache smokes intentionally wrote Durable
  Object/KV operational state.

### Future rollout order

1. Before merging, record the target feature-branch SHA and the currently
   deployed production Worker SHA/version in the launch notes. In the
   Cloudflare account, confirm that native rate-limit namespace `1002` is
   allocated to `RL_CERT_LOOKUP` and does not collide with another account-wide
   binding. Confirm `BADGE_CACHE_KV`, `CERT_LOOKUP_LIMITER`, the v1/v2 Durable
   Object migrations, and the shared `DMV_PROXY_SECRET` are configured without
   printing the secret.
2. Merge to `main`, record the resulting merged `main` SHA, and use the Cloudflare
   Git integration's automatic build as the single authoritative Worker deploy
   path. Watch that build and capture its deployed commit SHA/version. If no
   automatic build starts, first confirm in the dashboard that an automatic
   build/deploy is neither active nor already started, then use `pnpm cf:deploy`
   once as the fallback. Never run the automatic and manual paths concurrently.
3. Before changing Supabase, smoke `/healthz`, an existing card and badge,
   validation-only registration, invalid lookup (`400`), and a known valid-format
   lookup. **Only on a first publication against a legacy Edge contract**, the
   valid-format lookup may briefly be fail-closed `503 unavailable` before Step
   4. On future changes to the already-live Edge contract, expect the current
   typed result instead; treat any unexpected `503` as a failure to investigate,
   not as an expected rollout state.
4. Deploy **only** the changed lookup function:

```bash
supabase functions deploy lookup-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt
```

Do not redeploy `register-agent` or `badge` during this rollout. Supabase must
bypass its platform JWT layer because the Worker authenticates with
`x-dmv-proxy`. Supabase automatically injects `SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY`.

5. Prove issued and generated-valid-but-absent results through the Worker, the
   invalid-format response, exact 30/60 limiting, and a secretless direct
   `lookup-agent` request returning `403`. Also re-run health, card, badge, and
   registration smokes. Keep `wrangler tail` or the Cloudflare Durable Object
   metrics open: capture first provisioning/storage, the 31st-request denial,
   an alarm event/metric after expiry, and a post-window request with 29
   remaining. This is the real deployed v2 storage/alarm smoke.
6. Only after those results pass, update every active status surface with the
   new evidence: `README.md`, `llms.txt`, `index.html`,
   `CLOUDFLARE.md`, `AUTH_DMV.md`, `packages/dmv-agent/DEPLOY.md`,
   `AGENT_HANDOFF.md`, `AGENTS.md`, `CLAUDE.md`, `ARCHITECTURE.md`,
   `SECURITY.md`, and `packages/dmv-agent/README.md`. Commit and push that
   evidence-backed status update. Do not declare launch complete yet.
7. Public docs/assets are included in the Worker bundle, so the live-status
   commit triggers a second automatic production deployment. Watch the build for
   that exact status commit start and finish. Capture its commit SHA, final Worker
   version/deployment ID, timestamps, and result. If no automatic build starts,
   first confirm that an automatic build/deploy is neither active nor already
   started. Only then use `pnpm cf:deploy` once as fallback; never run the two
   paths concurrently.
8. Against that final status-commit deployment, re-run at minimum one issued or
   typed-not-found lookup plus `/healthz`, an existing card, an existing badge,
   and validation-only registration. Record their statuses/results. Only after
   these final smokes pass may the rollout be handed off or declared live.

### v2-safe recovery

Cloudflare's v2 SQLite Durable Object migration is forward-only operational
state. Never use Cloudflare rollback to a pre-v2 Worker: such a version lacks
the `CertificateLookupRateLimiter` export/binding while the account retains the
v2 migration. Preserve both v1 and v2 migrations, the class export, and the
`CERT_LOOKUP_LIMITER` binding in every recovery version.

Cloudflare's runtime rejects `redirect: 'error'`. Keep the internal upstream
fetch at `redirect: 'manual'`; any 3xx remains fail-closed and must never be
followed with the shared secret.

- If the Worker fails before the Edge deploy, stop. Restore traffic by shipping
  a new compatible Worker version that retains the migration/export/bindings;
  prefer roll-forward. Do not deploy the Edge function yet.
- If the Edge deploy fails after its secret gate is active, the Worker safely
  returns uncached `503 unavailable`. Roll forward `lookup-agent`; do not restore
  the legacy Edge contract or direct public access.
- Record the prior/current deployed versions and the exact failed smoke state
  before remediation. Do not delete or reverse Durable Object migrations or
  storage.

### Verify it's running

The canonical path is the Cloudflare Worker, not the Supabase URL directly:

```bash
# Read-only public surface check: healthz, card PNG, badge SVG, validation-only register 400
dmv-agent doctor

# Machine-readable variant for launch automation; same checks and exit code
dmv-agent doctor --json
```

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
```

Expected: `201` with `certificate_id`, `agent_name`, `domain`, `registration_type`, `permalink_url`, `badge_url`, `badge_card_url`, `message`.

Direct-to-Supabase calls no longer work — they return 403 (see the post-deploy secret-gate check below).

### Post-deploy verification — secret gate

The `x-dmv-proxy` secret gate closes the direct-Supabase bypass. Unit tests cover
both internal upstreams. After a deployment, retain the registration negative
smoke below without ever sending the real secret; do not publish or copy the
internal lookup URL into client-facing instructions:

```bash
# No header → rejected
curl -i -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' -d '{}'
# Expect: 403 (direct_access_deprecated)

# Retired public constant → rejected
curl -i -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' -H 'x-dmv-proxy: v1' -d '{}'
# Expect: 403 (the `v1` constant was retired 2026-05-29; only the DMV_PROXY_SECRET shared secret is accepted)

```

A legit registration and lookup must still succeed through the Worker at
`/api/register` and `/api/lookup`. If either direct test above does not return 403,
the secret gate is misconfigured — do not consider the deploy complete.

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

# Duplicate certificate_id → 200 recovery (same user + same agent name + same type)
# Returns the existing certificate payload with already_recorded=true

# Rate limit → 429 with Retry-After: 60
# Triggers: 6+ registrations to the same email within 60s, OR
#           5+ registrations to the same (IP, email) combo within 60s
```

---

### Verify lookup & badge

```bash
BASE=https://dmv.agentcommunity.org

# After the Edge deploy: issued or not_found through the Worker → 200 JSON
curl "$BASE/api/lookup?id=MESA-DD6-660J"

# Direct secretless Edge access must be closed → 403
curl -i \
  "https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/lookup-agent?id=MESA-DD6-660J"

# Domain enumeration is removed; do not send requested names to this endpoint.

# Invalid cert → 400
curl "$BASE/api/lookup?id=FAKE-000-0000"

# Flat badge SVG (for GitHub READMEs)
curl "$BASE/badge?id=MESA-DD6-660J" -o badge.svg

# Card badge SVG (for websites)
curl "$BASE/badge?id=MESA-DD6-660J&style=card" -o badge-card.svg

# Badge lookup is also certificate-ID-only; do not send requested names.
```

The lookup Worker applies the permissive/eventually consistent native 60/60
filter first, then exact atomic 30 requests per 60 seconds per hashed IP through
`CERT_LOOKUP_LIMITER`. Issued results are
cached internally for 300 seconds and not-found results for 60 seconds, but client
responses are `private, no-store`. Results contain only `certificate_id`,
`status`, `valid_format`, `issued`, `agent_name`, and `certificate_url`.
`issued: true` means a matching registration row exists; it does not mean email
verification, name allocation, or DNS delegation completed. Only the internal
typed HTTP 200 `not_found` envelope is cached as absence; non-200 or malformed
upstream results are uncached `unavailable`.

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
# From repo root: run the full release gate first.
pnpm build

# Then publish the package.
cd packages/dmv-agent
npm publish --access public
```

Repo-root `pnpm build` runs text-surface checks, compiles
`@agentcommunity/dmv-agent`, runs `tests/dmv-agent-cli.test.mjs` against the
built CLI, and runs `tests/dmv-agent-packed-cli.test.mjs`, which packs the npm
tarball, installs it into a temporary consumer project, and exercises the
installed `dmv-agent` binary against a local capture server. Package-level
`pnpm build` from `packages/dmv-agent/` only runs `tsc`; use it for a quick
compile check, not as the pre-publish smoke gate.

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

Open Claude Code, ask it to run a DMV readiness check → should call `dmv_doctor` and report OK after the invalid-payload validation check. Then ask it to register an agent → should call `register_agent` tool → should succeed.

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
- **Cloudflare dashboard → Workers → dmv-agentcommunity → Analytics Engine → `dmv_worker_events`** — query events where `category = 'register'` and group by the tier blob. Actual tier values: `405`, `validation`, `invalid_json`, `turnstile_required`, `turnstile_failed`, `machine_fingerprint_required`, `rate_limited`, `fingerprint_cooldown`, `supabase` (successful forward, 2xx upstream), and `supabase_<status>` (forwarded but upstream returned a non-2xx, e.g., `supabase_403` for lifetime-cap, `supabase_500` for DB errors)
- **Supabase dashboard → Edge Functions → register-agent** — invocation count, error rate, latency (now strictly worker-forwarded — direct access returns 403 via the `x-dmv-proxy` gate)
- **Supabase dashboard → Table Editor → registrations** — row count, any anomalies
- **Rate limiting** — shared CF limits are 5/email/60s and 4/(IP+email)/60s. Adjust in `wrangler.jsonc` `ratelimits` array, but remember the namespace IDs are shared with `agentCommunity_PAGE` — coordinate with that repo before changing values.
- **Duplicate certs** — `already_recorded=true` means the same user tried to re-register the same agent (expected, they get their cert ID back). This is not a taken-name state; `domain_requested` remains non-unique.

### Common issues

| Symptom | Cause | Fix |
|---------|-------|-----|
| `Network error: could not reach DMV registration service` | Worker not deployed, Cloudflare DNS issue, or Supabase down | Check the authoritative Cloudflare Git build and `pnpm cf:tail`. Use `pnpm cf:deploy` only after confirming an automatic build/deploy is neither active nor already started; never run them concurrently. |
| `turnstile_failed` (400) on browser | Wrong `TURNSTILE_SECRET_KEY` on the worker, or stale token | Check Cloudflare dashboard → Workers → dmv-agentcommunity → Variables and Secrets → confirm `TURNSTILE_SECRET_KEY` is encrypted Secret type |
| `machine_fingerprint_required` (400) on CLI | CLI on old version not sending fingerprint | Bump CLI dependency to latest `@agentcommunity/dmv-agent` |
| `Registration failed (HTTP 500)` | Service role key not set or DB schema mismatch | Check Supabase dashboard → Edge Functions → Logs |
| `already_recorded=true` | Same user re-registering same agent | Expected — returns cert ID + permalink for recovery |
| `Rate limited` (429) | Too many registrations from same email or (IP, email) within 60s | Wait 60s. Check shared CF rate limit counters in Cloudflare dashboard. |
| `fingerprint_cooldown` (429) | CLI/MCP machine fingerprint exceeded local KV cooldown | Wait `retry_after_seconds`. Counter is in DMV-local `REGISTER_COOLDOWN_KV`. |
| CLI hangs on `bunx` | Package not published or npm registry cache | Try `npx @agentcommunity/dmv-agent` or `bunx --force` |

---

## 6. Future — Not Yet Implemented

These are noted for future work, not needed for go-live:

- [ ] **Link/visit tracking** — Track permalink visits (`/c/CERT-ID/agent-name`) to measure sharing virality. Needs: a `card_views` table (cert_id, viewer_ip_hash, referrer, user_agent, timestamp), a lightweight edge function or analytics endpoint, and client-side fire-and-forget POST on permalink load. This is critical for understanding card sharing conversion (view → "Get Yours" click → registration).
- [x] **Email verification flow** — Magic link sent by agentcommunity.org trigger (on_dmv_registration). New users get magic link + certificate email. Existing users get certificate email only.
- [ ] **Google/GitHub OAuth** — alternative to email verification
- **Live lookup hardening:** domain lookup is removed from `lookup-agent` to
  reduce enumeration exposure. Public verification is certificate-ID-only
  through Worker `/api/lookup`; the coarse 60/60
  filter plus exact Durable Object 30/60 limit mitigate rather than eliminate
  enumeration risk. The internal response is a typed HTTP 200
  `issued`/`not_found` union.
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
 ┌───────────────────┐    ┌─────────────────────┐           ┌──────────────────────┐
 │ Any HTTP client    │───▶│ /api/lookup Worker  │──secret──▶│ lookup-agent (DMV)   │
 │ curl, agents, etc  │    │ 30/min/IP + cache   │           │ cert ID only         │
 └───────────────────┘    │ six public fields   │           │ direct access 403    │
                          └─────────────────────┘           └──────────────────────┘
```

**Zero secrets in client code. The Cloudflare Worker holds the Turnstile secret;**
**Supabase holds the service role key. The worker is the public anti-abuse choke**
**point for `/api/register` and `/api/lookup`; the Edge Functions are**
**secret-gated internal upstreams.**
