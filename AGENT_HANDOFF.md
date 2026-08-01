# Agent Handoff — DMV API Hardening (updated 2026-08-01)

Start here if you're a fresh agent picking up the DMV project after the cross-repo API hardening arc. This is the current production snapshot: both registration and certificate lookup are live. The rest of the repo's docs (`CLAUDE.md`, `AUTH_DMV.md`, `ARCHITECTURE.md`, `CLOUDFLARE.md`, `README.md`, `SECURITY.md`) record the production boundary and recovery rules. The cross-repo hardening work landed 2026-08-01 — see the four Task entries below.

## 2026-08-01 — Task 1: `register-agent` stores hashed client IP, never raw

`registrations.metadata.client_ip` was storing the raw client IP in the shared production DB that PAGE also reads, violating the hash-only invariant the Worker already follows everywhere via `sha256Hex`. Fixed in `supabase/functions/register-agent/index.ts`: the metadata key is now `client_ip_hash` (SHA-256 hex via Deno `crypto.subtle`), and the raw `client_ip` key is dropped entirely. Both repos were grepped for readers of `metadata->>'client_ip'` — none found, so dropping the raw value was safe; the hash keeps abuse-triage utility. `handleRegisterAgent(req, dependencies)` is now exported (mirroring `lookup-agent/index.ts`'s pattern) so the function is unit-testable; HTTP-boundary behavior is unchanged. New test coverage: `supabase/functions/register-agent/index.test.ts`, asserting inserted metadata contains `client_ip_hash` matching `/^[0-9a-f]{64}$/` and never a raw `client_ip` key, across `x-forwarded-for`, `cf-connecting-ip`, and no-IP cases. **Not deployed** — deploying the edge function is a separate human step (`supabase functions deploy register-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt`). Existing rows with raw IPs are untouched; backfill is a separate decision.

## 2026-08-01 — Task 2: endorsed-cap check reads the live signing column, not the dead one

The per-email lifetime cap upgrade (5 unendorsed → 12 endorsed) was reading `registrations.endorsement_status = 'signed'` to decide whether an email qualified for the higher cap. That column is dead on the shared PAGE DB — signing truth there is `registrations.status = 'complete'` (see PAGE's `docs/SUPABASE.md` and `CLAUDE.md`). Members who signed after `endorsement_status` stopped being written were silently stuck at the 5-cert cap. Fixed in `supabase/functions/register-agent/index.ts` to check `status = 'complete'`; the 5/12 cap values themselves are unchanged, and the query stays fail-closed on error. Deliberately does not also check `endorsement_requests` — that table has no reliable email column for this lookup (only `registration_id` and an unreliable `signer_email`), and this check is keyed by email with no `user_id`/`registration_id` available, so `status='complete'` on `registrations` already answers it in one query. New tests in `supabase/functions/register-agent/index.test.ts`.

## 2026-08-01 — Task 3: fingerprint cooldown reworked to count successful mints only, with an honest `Retry-After`

The fingerprint cooldown used to increment on every request *before* forwarding to `register-agent`, so an upstream 5xx (plus the npm client's automatic retries) or an `already_recorded` replay could exhaust a machine's 24h budget with zero successful registrations — directly contradicting its own "Allow 3 successful registrations" comment. Fixed across two commits:

- `worker/rate-limit-kv.ts`: `checkKvCooldown` now gates the request read-only (no write), and `incrementKvCooldown` only fires after `isNewCertificateMint` confirms a real 201 that isn't an `already_recorded` replay. KV now stores `{count, firstAt}` instead of a bare count, so `Retry-After` reports the actual remaining window instead of a flat 86400 seconds; legacy bare-count values are still parsed and carried forward without resetting.
- `worker/register-fingerprint-cooldown.ts` (new module, `runFingerprintGatedUpstream`): pulls the check-before/call-upstream/increment-after composition out of `handleRegister` into an injectable, unit-tested function with no `./container-instance` import, so it can be imported directly in tests without a build step. This exists because the composition itself was the exact bug — a review pass found that reverting the ordering, or dropping the `isNewCertificateMint` gate, left all prior tests green. `tests/worker-register-fingerprint-cooldown.test.ts` pins call order via a recording fake gate, verified by mutation (reverting the ordering locally failed 4 of 7 tests).
- **Follow-up fix in this pass:** `FINGERPRINT_COOLDOWN_THRESHOLD` had stayed `4` through both commits above, which — under the new success-only counting — let 4 successful mints through and only blocked the 5th, contradicting the "3/machine/24h" figure documented everywhere else (`CLAUDE.md`, `AUTH_DMV.md`, this file). The constant is now `3` (moved to `worker/register-fingerprint-cooldown.ts` so it's importable by tests), and `tests/worker-register-fingerprint-cooldown.test.ts` has an absolute-budget regression test (3 mints succeed, the 4th blocks) pinned against the real `rate-limit-kv.ts` implementation, not a mocked gate.

## 2026-08-01 — Task 4: `verify_certificate` MCP name collision resolved (npm package v0.3.0)

Code review across both `agentcommunity_PAGE` and this repo found that the
`@agentcommunity/dmv-agent` npm package's MCP server exposed a tool named
`verify_certificate` that only checked the Luhn mod-36 check digit
(`packages/dmv-agent/src/certificate.ts`), while `agentcommunity_PAGE`'s
`/mcp` endpoint exposes a tool of the **same name** that checks live issuance
via `GET /api/lookup` on this Worker. An agent with both MCP servers
configured could ask "is CERT-ID valid?" and get a "yes" from one server and
a "no, not found" from the other, for the same ID.

**Decision: Option A (wire the package to the real lookup), not Option B
(rename).** The package's `verify_certificate` (MCP) and `dmv-agent verify`
(CLI) now call `GET https://dmv.agentcommunity.org/api/lookup?id=<id>` by
default — the same public, rate-limited (~30/60s per IP) Worker route the
main site's tool uses — via the new `packages/dmv-agent/src/lookup.ts`. A
`format_only: true` MCP argument / `--format-only` CLI flag preserves the old
check-digit-only behavior with no network call. If the live call fails
(network error, timeout, malformed response, or the Worker itself reporting
`status: "unavailable"`), the tool automatically falls back to the offline
check digit and labels the result `(format-only ...)` in its text output; a
network failure is never reported as "not issued". Full detail in
`packages/dmv-agent/CHANGELOG.md` (0.3.0) and `packages/dmv-agent/README.md`.

**Update (2026-08-01, re-verified live):** `GET /api/lookup` now returns real
`not_found` (and, for issued certificates, real `issued`) results —
`{"certificate_id":"MESA-DD6-660J","status":"not_found","valid_format":true,"issued":false,...}`
against a real, unissued but valid-format ID; `status: "unavailable"` is no
longer what production returns for a normal request. The `lookup-agent`
Supabase upstream is live, not "implementation-ready but unpublished" as
earlier revisions of this doc said. `dmv-agent verify` / the MCP tool now
give a conclusive live-check result rather than the inconclusive
`unavailable` fallback described above when this section was first written
earlier the same day. Nothing was published to npm as part of the
`verify_certificate` wiring change itself; `packages/dmv-agent/package.json`
was bumped to `0.3.0`, still unpublished until someone explicitly runs
`npm publish --access public` from `packages/dmv-agent`. The `dmv-agent`
alias still declares `@agentcommunity/dmv-agent@^0.2.1` in-tree — a `^0.3.0`
range breaks `pnpm install --frozen-lockfile` (which the Cloudflare build
uses) because `0.3.0` is not yet on the registry. Publish order: publish
`@agentcommunity/dmv-agent@0.3.0` first, then bump the alias dependency to
`^0.3.0` and publish the alias. See `packages/dmv-agent/CHANGELOG.md`.

## Current production state — registration and lookup live

```
DMV worker         https://dmv.agentcommunity.org         /api/register live end-to-end
                                                           Turnstile + shared CF rate limits + KV cooldown
                                                           all verified with real browser signup 2026-04-09

DMV edge function  register-agent on tcymqfwwphacnosnnzxl  x-dmv-proxy gate active (DMV_PROXY_SECRET shared secret;
                                                           public v1 constant retired 2026-05-29, now 403)
                                                           Upstash removed
                                                           status NOT set on INSERT (DB default applies)
                                                           MUST be deployed with --no-verify-jwt

npm                @agentcommunity/dmv-agent@0.2.1         published, routes through /api/register
                   dmv-agent@0.1.1 alias                  depends on @agentcommunity/dmv-agent ^0.2.1

Lookup boundary    GET /api/lookup + lookup-agent          LIVE — deployed on main fabafe6 (PR #20), Worker
                                                           d9755e66-3883-4970-be84-a59307011f14 (2026-07-22),
                                                           direct Edge gate verified 403. Re-verified live
                                                           2026-08-01: real issued/not_found, not "unavailable".
                                                           Task 8 paperwork (deployed SHA + full smoke record)
                                                           still outstanding.

DMV main           latest as of this handoff               see `git log` for the current HEAD

PAGE main          shared Supabase project                 hardened independently via PR #82 (nembal/agentcommunity_page)
                                                           PAGE side is done; don't touch unless asked
```

## The hardening arc, in one paragraph

Browser / CLI / MCP / JS API registration all converge on `/api/register` on the `dmv-agentcommunity` Cloudflare Worker. Browser path: validate JSON → require `cf-turnstile-response` → Turnstile siteverify (hostname + `dmv_register` action checked server-side) → shared CF rate limiters (`RL_OTP_EMAIL` 5/60s and `RL_OTP_IP_EMAIL` 4/60s, both sharing `namespace_id` at the Cloudflare account level with `agentCommunity_PAGE`) → forward to Supabase `register-agent` edge function with the `x-dmv-proxy` header set to the `DMV_PROXY_SECRET` shared secret (the public `v1` constant was retired 2026-05-29). CLI/MCP path: validate JSON → require `machine_fingerprint` → same shared limiters → DMV-local KV cooldown (`REGISTER_COOLDOWN_KV`, key `dmv:register:fingerprint:<sha256>`) → forward. CAPTCHA always runs before shared counters so invalid tokens can't burn quota. Supabase edge function verifies the `x-dmv-proxy` header (rejecting direct-to-Supabase calls with 403 `direct_access_deprecated`), validates input again, enforces the DB lifetime cap (5 unendorsed / 12 endorsed per email), generates the certificate ID, and INSERTs with `certificate_id` set — **crucially, not setting `status`**, because the PAGE schema uses `certificate_id IS NOT NULL` as the DMV-row marker (see the quirks section below).

The live certificate-verification boundary follows the same model. Public
clients use only
`GET https://dmv.agentcommunity.org/api/lookup?id=CERT-ID`. The Worker validates
the check digit, applies coarse/eventually consistent `RL_CERT_LOOKUP` at 60/60,
then uses one `CERT_LOOKUP_LIMITER` SQLite Durable Object per hashed IP for exact
atomic 30/60 accounting and headers. It caches issued results for 300 seconds
and typed not-found results for 60 seconds in `BADGE_CACHE_KV`, and returns only `certificate_id`, `status`,
`valid_format`, `issued`, `agent_name`, and `certificate_url`. The `lookup-agent`
Edge Function change makes it an internal `DMV_PROXY_SECRET`-gated upstream with
exact typed HTTP 200 `issued`/`not_found` envelopes; non-200 or malformed
envelopes are unavailable and uncached. Direct calls and domain lookup are
unsupported.
`issued: true` means a matching registration row
exists, not that email verification, `.agent` allocation, or DNS delegation is done.

## Quirks — things that bit us, don't re-learn the hard way

### 1. `register-agent` MUST be deployed with `--no-verify-jwt`

```bash
supabase functions deploy register-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt
```

The DMV worker does **not** forward an `Authorization` header (the `REGISTER_FORWARD_REQUEST_HEADERS` allow-list in `worker/index.ts:934` only carries content-type, accept, accept-encoding, accept-language, user-agent, plus worker-set x-forwarded-* headers and `x-dmv-proxy` set to the `DMV_PROXY_SECRET` shared secret). If you deploy without `--no-verify-jwt`, Supabase's platform-level JWT verification layer fires first and the worker can't reach the function → every real registration gets `401 Missing authorization header`. The `x-dmv-proxy` gate inside the function is the actual anti-bypass defense; Supabase's JWT layer would just break the worker forwarding without adding real security.

### 2. DMV rows are marked by `certificate_id IS NOT NULL`, NOT by status

The PAGE `registration_status` enum has six values: `pending_profile | pending_signature | complete | failed | blocked | anonymized`. It has **never** had `provisional_dmv`. An earlier version of `AUTH_DMV.md` called for adding it via `ALTER TYPE`, but PAGE's team built a different design: PAGE identifies DMV rows by `certificate_id IS NOT NULL` (see `agentCommunity_PAGE/supabase/migrations/20260211000000_dmv_schema_and_trigger_guard.sql` — welcome/endorsement email triggers guard with `IF NEW.certificate_id IS NOT NULL THEN RETURN NEW;`).

**Do NOT run** `ALTER TYPE registration_status ADD VALUE 'provisional_dmv'`. It would add a value PAGE's TypeScript types, auth hub, and admin views don't know about, and it's unnecessary — `certificate_id` already does the job.

DMV's `register-agent/index.ts` INSERT **omits the `status` field entirely**. The DB default (`DEFAULT 'pending_profile'::registration_status NOT NULL`, baseline.sql:3345) applies. If a future change adds `status: '...'` back to the INSERT, the server will 500 with `22P02 invalid input value for enum`. Been there.

### 3. The Turnstile secret is dashboard-managed, not `wrangler secret put`

`wrangler secret put` is blocked on the `dmv-agentcommunity` worker by a version-mismatch guard (see `docs/plans/2026-04-08-handoff-prompt.md` §69 for the operational workaround). Install/rotate the `TURNSTILE_SECRET_KEY` via the Cloudflare dashboard: **Workers & Pages → `dmv-agentcommunity` → Settings → Variables and Secrets**. Make sure you paste it as **Secret** type (encrypted), not **Text** (plaintext). Whitespace paste errors are a gotcha — if a registration fails with `turnstile_failed`, re-copy from the Turnstile widget page (Cloudflare dashboard → Turnstile → the widget with site key `0x4AAAAAAC2BwC5T9LSdndaK`) and re-paste.

### 4. DMV has no auto-deploy from main pushes to the Supabase edge function

A push to DMV main triggers a **Cloudflare worker** redeploy (via CF git integration), but it does **not** trigger a Supabase functions deploy. If you change `supabase/functions/register-agent/index.ts` you have to run `supabase functions deploy register-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt` manually. The DMV repo has no GitHub Actions workflow for this.

### 5. Shared Cloudflare Rate Limiting namespaces with PAGE

`RL_OTP_EMAIL` namespace_id `4005` and `RL_OTP_IP_EMAIL` namespace_id `4007` are shared at the Cloudflare account level with `agentCommunity_PAGE`. A single attacker spending email-keyed quota on PAGE has less of it available on DMV. This is intentional. If PAGE ever bumps these values or changes the email-hash keying function, DMV silently drifts — watch for it in cross-repo coordination. PAGE's `RL_AUTH` (4001) and `RL_OTP_IP` (4006) are NOT shared; `RL_OTP_IP` (4006) was dropped entirely from PAGE's wrangler.jsonc in PR #82 and nothing references it anymore.

### 6. DMV-local `REGISTER_COOLDOWN_KV` is a separate KV namespace from PAGE's

ID: `ec0cdc55c2f94267af84f0218c961a00` (preview: `dc0c4a98b4764d448f35872de11984be`). DMV-only. Do NOT share it with PAGE. PAGE has its own `KV_RATE_LIMIT` namespace (`c0e0d88fff1a4c59805ab85c7a03100f`) for its OTP cooldown — different namespace, different key schema, fully separate.

### 7. The npm CLI auto-resolves the scoped package

`bunx dmv-agent register` installs `dmv-agent@0.1.1` (the unscoped alias), which depends on `@agentcommunity/dmv-agent^0.2.1`. The currently published scoped package is `0.2.1`. Publishing a compatible new scoped version can transparently update what alias users get, subject to that caret range. When publishing: `cd packages/dmv-agent && npm publish --access public`. Do NOT publish from the repo root — the root `package.json` has `"private": true` as a safety rail, but a missing private flag would ship 17 MB of everything. See `.gitignore` for `.worktrees/` exclusion that backstops this.

### 8. Lookup deployment record and future order

Set the same generated `DMV_PROXY_SECRET` on Cloudflare and Supabase without
writing it to source. Require Docker/container-build gates on a capable host,
confirm account-wide native namespace `1002`, the lookup bindings, and v1/v2
migrations, then merge `main`. Cloudflare Git automatic deploy is authoritative;
manual deploy is a non-concurrent fallback only if auto deploy never starts.

Worker first is intentional. The completed rollout recorded invalid `400`, then
deployed only `lookup-agent --no-verify-jwt` and proved `REEF-068-BD0Q` issued,
`ZZZZ-FFF-FFFD` not-found, direct secretless `403`, exact call-31 `429`, minute
rollover, and health/card/badge/permalink/registration smokes. Never roll back
to pre-v2: preserve migrations, DO export, and binding in a roll-forward. If a
future Worker change fails, stop before Edge; if Edge fails after gating, keep
the safe Worker `503` and roll Edge forward without reopening direct access.
Update all status surfaces in DEPLOY.md after any future evidence-backed rollout.

## Residual TODOs — prioritize here next time

### High (bug/incident risk)

1. **Close out Task 8's paperwork.** `GET /api/lookup` is confirmed live in
   production as of 2026-08-01 (real `issued`/`not_found`, not `unavailable`
   — see the 2026-08-01 section above). What's still outstanding is the
   record-keeping: capture the deployed DMV commit SHA and full smoke
   evidence for issued/not-found/invalid outcomes and the direct Edge 403
   boundary.
1. **Preserve the live lookup boundary.** Future changes must retain public
   certificate-ID-only lookup, exact 30/60 enforcement, the direct Edge 403
   gate, and the no-data-mutation verification discipline.

### Medium (debt / hygiene)

1. **PAGE test fixture fallout from `types/supabase.ts` regen** — branch `chore/regen-supabase-types` on `nembal/agentcommunity_page` is pushed but not merged because 58 test-file type errors surfaced when the generated types tightened. All errors are test fixtures out of sync with reality, not app code bugs. List is in the commit message of `f3cbd53`. Fix and merge as a focused PAGE PR.

2. **PAGE has 2 unpushed commits on local main** (as of session close 2026-04-09) that are the user's own work:
   - `a621634 fix(auth): unswallow stale-intent redirect at /auth + repo trust pass`
   - `fd694f7 fix(profile): move social og images off api path`
   These need a review pass and then `git push origin main`. Not touched by the hardening session — they appeared in the PAGE working tree during the session but were not ours.

### Low (cleanup, when convenient)

3. **Orphan `user_domains` rows** from the diagnostic loop — MIGHT exist for cert IDs `NEON-219-A55A` and `FLUX-79E-D61O`. Quick check:
   ```sql
   SELECT id, user_id, certificate_id, domain_name FROM public.user_domains
   WHERE certificate_id IN ('NEON-219-A55A', 'FLUX-79E-D61O');
   ```
   If rows exist, record the result and request explicit user approval before
   any cleanup. Do not delete Supabase data as part of a diagnostic; escalate
   the proposed target set and recovery plan instead.

4. **Historical `llms.txt` lookup gap (closed 2026-07-22)** — PR #8 removed a
   broken `/api/lookup` reference while no Worker route existed. The live route
   is now restored and documented. Do not restore direct Edge or domain-query
   examples.

5. **PAGE member count hygiene** — DMV rows land with `status = 'pending_profile'` (the DB default). If PAGE's admin stats or homepage counts treat all `pending_profile` rows as regular members, they'll inflate once DMV sees real traffic. Audit PAGE member count queries and decide whether to exclude unclaimed DMV rows (e.g., `WHERE certificate_id IS NULL OR (user_id IS NOT NULL AND auth_user_email_verified)`).

### Don't do

- Don't run `ALTER TYPE registration_status ADD VALUE 'provisional_dmv'` (see quirk #2)
- Don't deploy `register-agent` without `--no-verify-jwt` (see quirk #1)
- Don't `wrangler secret put` on `dmv-agentcommunity` (see quirk #3) — use the dashboard
- Don't `npm publish` from the DMV repo root (see quirk #7) — always `cd packages/dmv-agent` first
- Don't push PAGE changes to main without reviewing them — PAGE auto-deploys via CF git integration
- Don't remove the `x-dmv-proxy` gate or weaken it back to a public constant — it's now secret-backed (`DMV_PROXY_SECRET`, constant-time compared, fail-closed) and is the only thing closing the direct-Supabase bypass
- Don't call or document `lookup-agent` as a public API, restore domain lookup, or deploy the lookup Edge Function before the Worker replacement

## Reference anchors

**Key DMV commits from the hardening arc** (2026-04-08/09, all on main):

```
8d73924  fix(supabase): drop stale provisional_dmv status from register-agent INSERT
c94a592  docs: purge stale provisional_dmv references across all surfaces
05b2075  chore(dmv-agent): bump to 0.2.0 for worker-proxied registration
9559e9e  chore: ignore .worktrees/ in gitignore
570c30f  Merge PR #8 (fix bypass + llms.txt lookup)
fa22190  Merge PR #7 (the main hardening PR)
```

**Key files** (read these before touching the registration flow):

- `worker/index.ts` — worker entry, `/api/register` handler at `handleRegister()`, Turnstile verification at `verifyTurnstileToken()`, forward logic with `x-dmv-proxy` header set at `:1091`
- `worker/rate-limit-kv.ts` — DMV-local KV cooldown helper
- `supabase/functions/register-agent/index.ts` — Supabase upstream, the `x-dmv-proxy` gate, no status field on INSERT
- `packages/dmv-agent/src/register.ts` — CLI/MCP client, POSTs to `https://dmv.agentcommunity.org/api/register`
- `js/supabase.js` — browser client, same-origin `/api/register`
- `index.html` — Turnstile widget mount, `<meta name="dmv-turnstile-site-key">` carries the public site key
- `wrangler.jsonc` — all worker bindings (rate limiters, KV, R2, Durable Object)
- `public/_headers` — CSP for static assets (also mirrored in `PERMALINK_CSP` constant in `worker/index.ts` for `/c/*` routes — keep them in sync manually)
- `docs/plans/2026-04-08-cross-repo-hardening-handoff-prompt.md` — design spec, non-negotiable ordering rules (CAPTCHA before counters, etc.)

**PAGE files to be aware of** (read-only from DMV's perspective):

- `agentCommunity_PAGE/supabase/migrations/20260210999999_dmv_add_agent_enum.sql`
- `agentCommunity_PAGE/supabase/migrations/20260211000000_dmv_schema_and_trigger_guard.sql`
- `agentCommunity_PAGE/supabase/migrations/20260211000100_dmv_registration_trigger.sql`
- `agentCommunity_PAGE/supabase/migrations/20260203000000_baseline.sql` line 3308 for the `registrations` table definition
- `agentCommunity_PAGE/wrangler.jsonc` for PAGE's own rate-limit namespace bindings (shared with DMV)

## Operational how-to

**Tail the worker while debugging:**
```bash
pnpm cf:tail
# or
pnpm wrangler tail
```

**Smoke test the direct-access gate:**
```bash
curl -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' -d '{}'
# Expect: 403 direct_access_deprecated

curl -X POST https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent \
  -H 'Content-Type: application/json' -H 'x-dmv-proxy: v1' -d '{}'
# Expect: 403 direct_access_deprecated
# The live gate value is now the DMV_PROXY_SECRET shared secret (set on both the
# Cloudflare Worker and the Supabase project). The public `v1` constant was retired
# 2026-05-29, so this curl can no longer reach validation — only the worker, which
# forwards the real secret, gets through.
```

**Smoke test the worker proxy:**
```bash
curl -X POST https://dmv.agentcommunity.org/api/register \
  -H 'Content-Type: application/json' \
  -d '{"agent_name":"x","email":"x@y.com","signup_source":"ui"}'
# Expect: 400 turnstile_required (if agent_name ≥ 3 chars)
# or 400 agent_name must be at least 3 characters (at validation stage)
```

**Manual Worker fallback only if the Cloudflare Git build did not trigger:**

First prove in the Cloudflare dashboard that an automatic build/deployment is
neither active nor already started. Then use the canonical fallback exactly
once; never run it concurrently with an automatic build:

```bash
pnpm cf:deploy
```

For lookup changes, deploy this Worker step first. Then deploy the internal
upstream:

```bash
supabase functions deploy lookup-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt
```

Public lookup smoke:

```bash
curl "https://dmv.agentcommunity.org/api/lookup?id=MESA-DD6-660J"
# Expect: a six-field issued/not_found result plus RateLimit-* headers.
```

**Re-deploy the edge function** (after code change to `supabase/functions/register-agent/index.ts`):
```bash
supabase functions deploy register-agent --project-ref tcymqfwwphacnosnnzxl --no-verify-jwt
```
The `--no-verify-jwt` is not optional. See quirk #1.

## Closing thoughts from the 2026-04-08/09 session

This was a long arc: started with "add rate limiting and Turnstile to DMV registration" and ended with a cross-repo schema design discovery that revealed a latent bug in the DMV edge function that had been there since the Upstash days but never triggered because the function had never actually been exercised end-to-end in production. The hardening itself was straightforward; the debugging loop that followed the first production deploy was the interesting part. Read `AUTH_DMV.md` "Status Lifecycle" section for the full story.

If you pick this up and something is broken, the single highest-leverage thing is: tail the worker (`pnpm cf:tail`), reproduce the failure, and look at the analytics events in the `dmv_worker_events` Analytics Engine dataset. The worker emits events with `category: 'register'` and a tier blob that tells you exactly which gate a failing request hit. Actual tier vocabulary (from `worker/index.ts` `emitRegisterAnalytics` call sites):

  - `'405'` — non-POST method
  - `'validation'` — JSON shape / field validation failed
  - `'invalid_json'` — request body wasn't parseable JSON
  - `'turnstile_required'` — browser path missing `cf-turnstile-response`
  - `'turnstile_failed'` — Turnstile siteverify rejected the token
  - `'machine_fingerprint_required'` — CLI/MCP path missing `machine_fingerprint`
  - `'rate_limited'` — shared CF limiter (`RL_OTP_EMAIL` or `RL_OTP_IP_EMAIL`) fired
  - `'fingerprint_cooldown'` — DMV-local KV cooldown fired
  - `'supabase'` — request successfully forwarded and Supabase returned 2xx
  - `'supabase_<status>'` — request forwarded but Supabase returned a non-2xx (e.g., `supabase_403` for lifetime-cap hits, `supabase_400` for Supabase validation, `supabase_500` for DB errors)

So a query like `tier = 'supabase_500'` pinpoints upstream DB failures, `tier LIKE 'supabase_%'` shows all upstream errors, and `tier NOT LIKE 'supabase%'` shows everything the worker rejected before it ever hit Supabase.

Good luck.
