# DMV API Hardening Plan — register-agent worker proxy

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the `register-agent` endpoint behind the DMV Cloudflare Worker so browser traffic gets Turnstile + rate limiting + origin-pinning protection, while preserving the existing direct-Supabase path for older CLI clients during a staged rollout.

**Architecture:** Adds a new `/api/register` handler to `worker/index.ts` that forwards to the existing Supabase `register-agent` edge function. New clients (browser + latest CLI) POST to `/api/register`; old clients keep hitting Supabase direct for a version window. After adoption, the Supabase-direct path gets an origin check that closes the bypass. Turnstile protects the browser path (friction-less for real users, breaks headless bots); `machine_fingerprint` server-side verification protects the CLI/MCP paths.

**Tech Stack:** Cloudflare Workers (existing stack), Cloudflare Turnstile (free CAPTCHA alternative), Upstash Redis (already used by register-agent for rate limiting), Workers Rate Limiting API (already used for /api/* render paths).

---

## Preamble — read before starting

**Required reading (in order):**
1. `CLAUDE.md` — project overview
2. `CLOUDFLARE.md` — updated 2026-04-07 post-hardening, describes the existing Worker topology
3. `docs/plans/archive/2026-04-07-cf-native-hardening.md` — the prior plan this builds on. Pay particular attention to Task 5 (Workers Rate Limiting) and Task 6 (KV badge cache) — this plan reuses their patterns
4. `supabase/functions/register-agent/index.ts` (363 lines) — the current Supabase edge function
5. `js/supabase.js` — the browser client (70 lines)
6. `packages/dmv-agent/src/register.ts` — the CLI client (97 lines)
7. `AUTH_DMV.md` — the broader auth integration flow

**What's NEW and what's PRESERVED:**
- **NEW:** `/api/register` worker route with Turnstile verification, rate limiting, upstream forwarding
- **NEW:** browser Turnstile widget embedded in the CRT terminal form
- **NEW:** server-side `machine_fingerprint` verification in the Supabase edge function (was sent by CLI but unverified)
- **NEW:** closed Supabase-direct bypass (final step, staged after client adoption)
- **PRESERVED:** existing Upstash Redis rate limits in `register-agent` (6 layers documented in ARCHITECTURE.md)
- **PRESERVED:** existing machine fingerprint generation in `packages/dmv-agent/src/rate-limit.ts`
- **PRESERVED:** certificate ID generation + database write flow (unchanged)

**Hard constraints:**
- **Do NOT break existing CLI users.** `bunx dmv-agent` installations in the wild hit Supabase direct. Support dual paths for at least 2 weeks before closing the bypass.
- **Do NOT require Turnstile for the CLI.** Headless environments can't solve CAPTCHAs. CLI uses `machine_fingerprint` as its proof-of-work.
- **Do NOT add any new runtime dependencies** to the worker or browser.
- **Supabase Edge Functions use Deno** — any server-side changes use Deno-compatible imports (`https://esm.sh/...`), not Node.
- **Verification is manual smoke + `wrangler tail`** (no automated worker tests by design).
- **Don't touch** the CF-native hardening work from the previous plan. This is additive.

**Execution order:**
- Task 1 (wrangler bindings + Turnstile secret) MUST ship first.
- Tasks 2-3 (worker handler + supabase edge function) are independent — can run in parallel, but they interact at deploy time (both must be live for end-to-end to work).
- Tasks 4-5 (browser HTML + JS) must follow Task 2 going live.
- Task 6 (CLI update) follows Task 2.
- Task 7 (MCP update) follows Task 6.
- Task 8 (local smoke) gates Task 9 (deploy).
- Task 10 (docs) runs after deploy.
- **Bypass closure (Task 11) is explicitly deferred** — do NOT run it until 2+ weeks after Task 9 deploys and CLI adoption is confirmed.

---

## File Structure

| File | Task(s) | Responsibility |
|---|---|---|
| `wrangler.jsonc` | 1 | New `REGISTER_RATE_LIMITER` binding (namespace_id 1002), `TURNSTILE_SITE_KEY` var |
| (wrangler secrets) | 1 | `TURNSTILE_SECRET_KEY` via `wrangler secret put` |
| `worker/index.ts` | 2 | `handleRegister` handler, `verifyTurnstile` helper, dispatch in `fetch`, Env interface |
| `supabase/functions/register-agent/index.ts` | 3 | Server-side `machine_fingerprint` verification via Upstash Redis |
| `index.html` | 4 | Turnstile widget inside the CRT form |
| `js/supabase.js` | 5 | `REGISTER_ENDPOINT` → `/api/register`, pass Turnstile token |
| `packages/dmv-agent/src/register.ts` | 6 | `REGISTER_ENDPOINT` → `https://dmv.agentcommunity.org/api/register`, bump package version |
| `packages/dmv-agent/package.json` | 6 | Version bump |
| `CLOUDFLARE.md` | 10 | Operational notes: `/api/register` proxy documentation |
| `ARCHITECTURE.md` | 10 | Rate limiting section: update Layer 0 scope to include `/api/register`; mention worker proxy in the registration data flow |

---

### Task 1: Wrangler bindings + Turnstile secret

**Files:**
- Modify: `wrangler.jsonc`
- Wrangler secret: `TURNSTILE_SECRET_KEY`
- Cloudflare dashboard: Turnstile widget creation (one-time, returns site key + secret key)

**Dashboard prereq (you, the user, do this once — sub-agent cannot):**
1. https://dash.cloudflare.com → Turnstile → Add Site
2. Site name: `dmv.agentcommunity.org`
3. Domain: `dmv.agentcommunity.org`
4. Widget mode: **Managed** (recommended — automatic challenge escalation based on risk score)
5. Copy the Site Key (public, looks like `0x4AAA...`) and Secret Key (private, looks like `0x4AAA...`)
6. Pass the site key to the sub-agent via the task dispatch. Install the secret key via `wrangler secret put TURNSTILE_SECRET_KEY` (do this interactively).

- [ ] **Step 1: Install `TURNSTILE_SECRET_KEY` as a wrangler secret**

```bash
cd /path/to/worktree
pnpm wrangler secret put TURNSTILE_SECRET_KEY
# Paste the secret key from the dashboard when prompted
```

Verify:
```bash
pnpm wrangler secret list
```
Expected: `TURNSTILE_SECRET_KEY` appears in the list.

- [ ] **Step 2: Add `REGISTER_RATE_LIMITER` and `TURNSTILE_SITE_KEY` to `wrangler.jsonc`**

Find the existing `ratelimits` array (added by Task 5 of the 2026-04-07 plan):

```jsonc
	"ratelimits": [
		{
			"name": "API_RATE_LIMITER",
			"namespace_id": "1001",
			"simple": {
				"limit": 100,
				"period": 60
			}
		}
	],
```

Add a second entry for the registration limiter:

```jsonc
	"ratelimits": [
		{
			"name": "API_RATE_LIMITER",
			"namespace_id": "1001",
			"simple": {
				"limit": 100,
				"period": 60
			}
		},
		{
			"name": "REGISTER_RATE_LIMITER",
			"namespace_id": "1002",
			"simple": {
				"limit": 5,
				"period": 60
			}
		}
	],
```

Then add the Turnstile site key to the existing `vars` block:

```jsonc
	"vars": {
		"PREWARM_ORIGIN": "https://dmv.agentcommunity.org",
		"TURNSTILE_SITE_KEY": "0x4AAA...<paste the site key from dashboard>"
	},
```

`TURNSTILE_SITE_KEY` is safe to commit — site keys are public by design (they go into browser HTML). Only the secret key stays in `wrangler secret`.

- [ ] **Step 3: Verify config via dry-run**

```bash
pnpm wrangler deploy --dry-run
```

Expected bindings block:
```
env.API_RATE_LIMITER (100 requests/60s)        Rate Limit
env.REGISTER_RATE_LIMITER (5 requests/60s)     Rate Limit
env.TURNSTILE_SITE_KEY ("0x4AAA...")           Environment Variable
env.TURNSTILE_SECRET_KEY                       Encrypted Environment Variable
```

- [ ] **Step 4: Commit**

```bash
git add wrangler.jsonc
git commit -m "$(cat <<'EOF'
feat(cf): add REGISTER_RATE_LIMITER binding + Turnstile site key var

Prep for the /api/register worker proxy (Task 2). New rate limiter
namespace_id 1002 is scoped to the registration endpoint only —
5 req/60s per IP because registration is inherently low-volume.
Turnstile site key is public (safe to commit); the secret key lives
in wrangler secrets and is installed separately via
`pnpm wrangler secret put TURNSTILE_SECRET_KEY`.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `/api/register` worker handler

**Files:**
- Modify: `worker/index.ts`

Mirrors the pattern of `handleBadge` (Task 6 of 2026-04-07 plan): Env interface field, handler function, dispatch site in `fetch`.

- [ ] **Step 1: Extend the `Env` interface**

Add three new fields alongside the existing ones:

```ts
interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  ASSETS: Fetcher;
  PREWARM_ORIGIN: string;
  ANALYTICS: AnalyticsEngineDataset;
  API_RATE_LIMITER: RateLimit;
  BADGE_CACHE_KV: KVNamespace;
  // Dedicated rate limiter for POST /api/register. Tighter limit
  // (5 req/60s per IP) because registration is inherently low-volume
  // and per-IP is a stronger signal for registration abuse than for
  // the card-render enumeration scenario.
  REGISTER_RATE_LIMITER: RateLimit;
  // Turnstile site key (public — rendered in the browser HTML).
  TURNSTILE_SITE_KEY: string;
  // Turnstile secret key (private — used for server-side siteverify).
  // Set via `pnpm wrangler secret put TURNSTILE_SECRET_KEY`.
  TURNSTILE_SECRET_KEY: string;
}
```

- [ ] **Step 2: Add the `verifyTurnstile` helper**

Near the other helpers in `worker/index.ts` (around where `stripBodyForHead` is declared), add:

```ts
// Verify a Turnstile token against Cloudflare's siteverify endpoint.
// Returns true on success, false on any failure (invalid token, network
// error, secret mismatch, timeout). Never throws — callers can rely on
// a boolean result.
//
// Docs: https://developers.cloudflare.com/turnstile/get-started/server-side-validation/
//
// Called from handleRegister for browser requests that include a
// cf-turnstile-response field. CLI requests do not include this field
// and use machine_fingerprint instead (verified server-side in the
// Supabase edge function).
async function verifyTurnstile(
  token: string,
  secretKey: string,
  clientIp: string | null,
): Promise<boolean> {
  try {
    const body = new FormData();
    body.append('secret', secretKey);
    body.append('response', token);
    if (clientIp) body.append('remoteip', clientIp);

    const resp = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      { method: 'POST', body },
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
```

- [ ] **Step 3: Add the `handleRegister` handler**

Place it near `handleBadge` in the file, matching its shape and use of `emitAnalytics` / `ctx.waitUntil`:

```ts
// Forwarded request headers for the /api/register → Supabase proxy.
// Only the minimum needed by the edge function — content-type is mandatory,
// accept/accept-language/user-agent are informational. No cookies, no auth
// headers, no cf-*.
const REGISTER_FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
] as const;

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

  // Rate limit BEFORE anything expensive. 5 req/60s per IP.
  const clientIp = request.headers.get('cf-connecting-ip') ?? '';
  if (clientIp) {
    try {
      const { success } = await env.REGISTER_RATE_LIMITER.limit({ key: clientIp });
      if (!success) {
        emitAnalytics(env, {
          category: 'error',
          tier: '429',
          path,
          key: clientIp,
          latencyMs: Date.now() - startedAt,
          sizeBytes: 0,
        });
        return new Response('Rate limit exceeded', {
          status: 429,
          headers: {
            'Retry-After': '60',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-RateLimit-Limit': '5',
            'X-RateLimit-Window': '60',
          },
        });
      }
    } catch (err) {
      console.error('[register] REGISTER_RATE_LIMITER.limit failed', { path, err });
      // Fall through — limiter failure must not break responses.
    }
  }

  // Parse body — must be JSON.
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    emitAnalytics(env, {
      category: 'error',
      tier: 'bad-json',
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

  // Sanity-check required fields before verifying Turnstile or calling
  // upstream. The Supabase edge function does its own deep validation;
  // this is just defense-in-depth so we don't waste a Turnstile quota on
  // obviously bad requests.
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

  // Browser path: verify Turnstile token. Body field is
  // `cf-turnstile-response` per the Turnstile client library convention.
  // CLI path: no token, relies on server-side machine_fingerprint check
  // in the Supabase edge function (Task 3).
  const turnstileToken = typeof body['cf-turnstile-response'] === 'string'
    ? body['cf-turnstile-response'] as string
    : null;
  const source = typeof body.signup_source === 'string' ? body.signup_source : 'unknown';
  const isBrowser = source === 'ui' || turnstileToken !== null;

  if (isBrowser) {
    if (!turnstileToken) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'turnstile-missing',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({ error: 'Turnstile token required for browser registrations' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
    const ok = await verifyTurnstile(turnstileToken, env.TURNSTILE_SECRET_KEY, clientIp || null);
    if (!ok) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'turnstile-failed',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({ error: 'Turnstile verification failed' }),
        { status: 403, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // CLI/MCP path: require machine_fingerprint. The Supabase function (Task 3)
  // enforces uniqueness server-side; here we just ensure it's present so a
  // request that's missing both Turnstile AND fingerprint is rejected early.
  if (!isBrowser) {
    if (typeof body.machine_fingerprint !== 'string' || !body.machine_fingerprint) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'fingerprint-missing',
        path,
        key: clientIp,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(
        JSON.stringify({ error: 'machine_fingerprint required for non-browser registrations' }),
        { status: 400, headers: { 'Content-Type': 'application/json' } },
      );
    }
  }

  // Strip the Turnstile token from the body before forwarding — the Supabase
  // function doesn't know about Turnstile, and sending an unknown field could
  // confuse its validation.
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
  // Signal to the Supabase function that this request came through the
  // DMV worker proxy. After Task 11 (bypass closure), the Supabase function
  // will reject requests without this header.
  upstreamHeaders.set('x-dmv-proxy', 'v1');

  const upstream = await fetch(`${SUPABASE_FUNCTIONS_ORIGIN}/register-agent`, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  });

  const upstreamText = await upstream.text();

  emitAnalytics(env, {
    category: 'badge', // reuses the 'badge' category because it's also a supabase-forward
    tier: upstream.ok ? 'SUPABASE' : `SUPABASE-${upstream.status}`,
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

- [ ] **Step 4: Dispatch `/api/register` in the main `fetch` handler**

Find the dispatch table in the main `fetch` handler (around the existing `/api/card` / `/api/og` / `/badge` dispatches). Add:

```ts
    // /api/register → worker-proxied Supabase register-agent with Turnstile
    // (browser) or machine_fingerprint (CLI/MCP) protection. See Task 2 of
    // docs/plans/2026-04-08-dmv-api-hardening-plan.md.
    if (url.pathname === '/api/register') return handleRegister(request, env, ctx);
```

Place it alongside `/api/card` and `/api/og` for logical grouping.

- [ ] **Step 5: Add `/api/register` to `run_worker_first` in `wrangler.jsonc`**

Find the existing `run_worker_first` array:
```jsonc
    "run_worker_first": [
      "/api/*",
      "/c/*",
      "/badge/*",
      "/healthz"
    ]
```

`/api/register` is already matched by `/api/*` — no change needed. Skip this step but confirm via dry-run that nothing's unexpected.

- [ ] **Step 6: Local smoke — handler compiles and responds**

Since we can't easily test Turnstile locally (no real site key at dev time) AND can't test Supabase forwarding without the register-agent function updated (Task 3), this smoke just verifies the code path compiles and returns sensible errors.

```bash
pnpm cf:dev > /tmp/cf-dev-task2reg.log 2>&1 &
CFDEV_PID=$!
# ... (wait for ready, get port, etc. — use the same pattern as 2026-04-07 plan's smoke tests)

PORT=$(grep -oE 'Ready on http://[^ ]+' /tmp/cf-dev-task2reg.log | grep -oE ':[0-9]+' | head -1 | tr -d :)
BASE="http://localhost:$PORT"

echo "=== GET (expect 405) ==="
curl -sI "$BASE/api/register" | head -2

echo "=== POST invalid JSON (expect 400) ==="
curl -si -X POST -H 'content-type: application/json' --data-binary 'not json' "$BASE/api/register" | head -5

echo "=== POST missing fields (expect 400) ==="
curl -si -X POST -H 'content-type: application/json' --data-binary '{}' "$BASE/api/register" | head -5

echo "=== POST browser-shape without Turnstile token (expect 400) ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"test","email":"a@b.co","signup_source":"ui"}' \
  "$BASE/api/register" | head -5

echo "=== POST cli-shape without fingerprint (expect 400) ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"test","email":"a@b.co","signup_source":"cli"}' \
  "$BASE/api/register" | head -5

echo "=== POST cli-shape with fingerprint (expect forwarded to Supabase — may error on Supabase side since function doesn't yet expect x-dmv-proxy) ==="
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{"agent_name":"smoketest","email":"test@example.com","signup_source":"cli","machine_fingerprint":"dev-fake-fp"}' \
  "$BASE/api/register" | head -10

kill $CFDEV_PID
```

Expected outcomes:
- GET → 405 with `Allow: POST`
- Invalid JSON → 400 `{"error":"Invalid JSON body"}`
- Missing fields → 400 `{"error":"agent_name and email are required"}`
- Browser without token → 400 `{"error":"Turnstile token required for browser registrations"}`
- CLI without fingerprint → 400 `{"error":"machine_fingerprint required for non-browser registrations"}`
- CLI with fingerprint → forwarded upstream. Response status depends on Supabase state (may 400 if the email/agent_name trips existing validation, or 200 if it creates a record). Either way, the request MUST actually reach Supabase — check `wrangler dev` logs for the outbound `fetch` call.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): add /api/register proxy with Turnstile + rate limiting

New handleRegister handler forwards POST /api/register to the Supabase
register-agent edge function with:
- REGISTER_RATE_LIMITER (5 req/60s per IP) applied before any
  upstream work
- Turnstile siteverify for browser requests (signup_source=ui or
  cf-turnstile-response present)
- machine_fingerprint required for non-browser requests (CLI/MCP)
- Clean upstream header hygiene (REGISTER_FORWARD_REQUEST_HEADERS
  allowlist + BADGE_RESPONSE_HEADERS_TO_STRIP reuse)
- Analytics events on every return path (405, 429, bad-json,
  validation, turnstile-missing, turnstile-failed, fingerprint-missing,
  SUPABASE forward result)
- X-DMV-Proxy: v1 header to upstream so the Supabase function can
  eventually enforce proxy-only access (Task 11, deferred).

Does NOT yet close the Supabase-direct bypass. Older CLI versions
continue to POST direct to Supabase. Bypass closure is Task 11,
deferred ~2 weeks after CLI adoption.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Server-side `machine_fingerprint` verification in `register-agent`

**Files:**
- Modify: `supabase/functions/register-agent/index.ts`

The existing edge function (363 lines) already uses `@upstash/ratelimit` with three rate limiters (per-IP, per-email, per-IP+email). It receives `machine_fingerprint` from the CLI but **does not verify it**. Add a fourth rate limiter keyed on fingerprint so a single CLI machine can't bypass per-IP limits by rotating IPs through a VPN.

- [ ] **Step 1: Read the current register-agent edge function**

```bash
cat supabase/functions/register-agent/index.ts
```

Find the Upstash `Ratelimit` declarations (probably 3 of them — per-IP, per-email, per-IP+email). Note their exact shapes because you'll be adding a fourth with the same style.

- [ ] **Step 2: Add a fingerprint rate limiter**

Where the existing rate limiters are declared, add:

```ts
// Per-machine-fingerprint limit for CLI/MCP registrations. The fingerprint
// is SHA-256(hostname + username + platform) computed client-side and
// sent in the request body. It's NOT a cryptographic identity — a
// determined adversary can spoof it — but it raises the cost of spraying
// registrations from a single machine beyond what the per-IP limiter
// already enforces.
//
// 3 registrations per fingerprint per 24 hours matches the CLI's local
// lockfile limit in packages/dmv-agent/src/rate-limit.ts — the server
// enforces what the client already claims.
const fingerprintRatelimit = new Ratelimit({
  redis,
  limiter: Ratelimit.slidingWindow(3, '24 h'),
  prefix: 'dmv_register_fp',
  analytics: true,
});
```

Then find where the existing limiters are checked (probably a sequence of `await perIpRatelimit.limit(...)` etc.). Add a check for the fingerprint limiter, but ONLY if the request actually has a fingerprint (browser requests don't):

```ts
const fingerprint = typeof body.machine_fingerprint === 'string'
  ? body.machine_fingerprint
  : null;

if (fingerprint) {
  const fpResult = await fingerprintRatelimit.limit(fingerprint);
  if (!fpResult.success) {
    return new Response(
      JSON.stringify({
        error: 'Machine fingerprint rate limit exceeded (3 per 24h)',
        retry_after: Math.ceil((fpResult.reset - Date.now()) / 1000),
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(Math.ceil((fpResult.reset - Date.now()) / 1000)),
          ...corsHeaders,
        },
      },
    );
  }
}
```

Place the fingerprint check AFTER the per-IP/per-email/per-IP+email checks — it's an additional gate, not a replacement.

- [ ] **Step 3: Deploy the updated edge function**

```bash
pnpm supabase functions deploy register-agent
```

(Or whatever the project's deploy command is — check `package.json` scripts.) This deploys to Supabase, NOT Cloudflare. It's independent of `pnpm cf:deploy`.

- [ ] **Step 4: Smoke test the fingerprint limit**

```bash
# Hit the Supabase function directly 4 times with the same fingerprint.
# First 3 should succeed (or fail on other validation); 4th should 429.
for i in 1 2 3 4; do
  curl -si -X POST \
    -H 'content-type: application/json' \
    --data-binary '{"agent_name":"fpsmoke'$i'","email":"fptest'$i'@example.com","signup_source":"cli","machine_fingerprint":"fpsmoketest-stable","registration_type":"AGENT"}' \
    https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent | head -1
  sleep 1
done
```

Expected: first 3 return 200 or 400 (depending on whether the email was already used), the 4th returns 429 with a `retry_after` body field.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(edge): verify machine_fingerprint server-side for register-agent

Adds a 4th Upstash rate limiter keyed on machine_fingerprint:
3 registrations per fingerprint per 24h. Mirrors the client-side
lockfile in packages/dmv-agent/src/rate-limit.ts — server enforces
what the CLI already claims. Only fires when fingerprint is present
in the request body (browser registrations through the new
/api/register proxy don't send it; they use Turnstile instead).

Closes a documented gap: the CLI was sending machine_fingerprint
but the server was accepting it without verification, so a single
adversarial machine could rotate IPs and bypass per-IP limits.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Browser HTML — Turnstile widget

**Files:**
- Modify: `index.html`

Add the Turnstile script tag and a hidden container that the CRT form code will mount the widget into.

- [ ] **Step 1: Add Turnstile script to `<head>`**

In `index.html` head section, after the existing `<link rel="preconnect" href="https://cdn.jsdelivr.net">` line, add:

```html
  <link rel="preconnect" href="https://challenges.cloudflare.com" crossorigin>
  <script src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit" defer></script>
```

`?render=explicit` means we control when the widget renders (not auto on page load) — important because the CRT form is inside a 3D scene and shouldn't trigger Turnstile until the user actually fills the form.

- [ ] **Step 2: Add Turnstile widget container inside the CRT form**

Find the review/submit screen of the CRT terminal flow in `index.html`. This is typically a `<div>` that holds the submit button. Add a Turnstile container right before the submit button:

```html
<div id="turnstile-container" style="display:none"></div>
```

The container starts hidden. `CRTTerminal.js` will un-hide it and explicitly render the widget when the form reaches the review/submit screen. See Task 5 for the JS glue.

- [ ] **Step 3: Update CSP to allow the Turnstile origin**

The CSP in `public/_headers` currently allows `https://cdn.jsdelivr.net` in `script-src` and `connect-src`. Add `https://challenges.cloudflare.com` to BOTH:

Find the CSP line in `public/_headers`:
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Change to (added `https://challenges.cloudflare.com` in `script-src`, `frame-src`, and `connect-src`):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Turnstile renders its challenge UI inside an iframe, so `frame-src` is required.

**Also update `PERMALINK_CSP` in `worker/index.ts`** to the exact same string (it's duplicated per the code comment at the constant declaration). Don't forget this — the permalink path will break under the old CSP if the SPA's importmap changes, and adding Turnstile doesn't affect the importmap, but consistency matters.

- [ ] **Step 4: Commit**

```bash
git add index.html public/_headers worker/index.ts
git commit -m "$(cat <<'EOF'
feat(web): add Turnstile script + container and update CSP

- Loads Turnstile API from challenges.cloudflare.com with ?render=explicit
  so the widget only renders when the CRT form reaches the submit screen
- Adds hidden #turnstile-container div inside the form flow (the CRT
  terminal JS un-hides and mounts on demand)
- Extends CSP script-src, connect-src, and new frame-src with
  https://challenges.cloudflare.com (frame-src because Turnstile renders
  its challenge UI in an iframe)
- Keeps PERMALINK_CSP in worker/index.ts byte-identical to public/_headers
- preconnect hint to challenges.cloudflare.com for faster widget load

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Browser JS — render Turnstile + update `js/supabase.js`

**Files:**
- Modify: `js/supabase.js`
- Modify: `js/CRTTerminal.js` (the form flow)

- [ ] **Step 1: Update `REGISTER_ENDPOINT` in `js/supabase.js`**

```ts
// OLD
const REGISTER_ENDPOINT =
  'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent';

// NEW — route through DMV worker proxy
const REGISTER_ENDPOINT = '/api/register';
```

Same-origin is fine because the page is served from `dmv.agentcommunity.org` and the worker handles `/api/register` via `run_worker_first: ["/api/*"]`.

- [ ] **Step 2: Accept a Turnstile token in `insertRegistration`**

Change the function signature to accept the token:

```ts
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
  // Attach the Turnstile response token for server-side siteverify.
  if (turnstileToken) {
    body['cf-turnstile-response'] = turnstileToken;
  }

  // ... rest of function unchanged ...
}
```

- [ ] **Step 3: Render the Turnstile widget in the CRT form flow**

In `js/CRTTerminal.js` (or wherever the form's review/submit phase transitions), find the point where the form reaches the submit screen. Add:

```js
// Turnstile widget management. Rendered lazily on form submit screen to
// avoid unnecessary network / compute during earlier phases. Uses the
// ?render=explicit API so we control when the iframe is created.
let turnstileWidgetId = null;
let turnstileToken = null;

function mountTurnstileWidget() {
  const container = document.getElementById('turnstile-container');
  if (!container) return;
  if (turnstileWidgetId !== null) return; // already mounted
  if (typeof window.turnstile === 'undefined') {
    console.warn('[turnstile] script not loaded yet');
    return;
  }

  container.style.display = 'block';
  turnstileWidgetId = window.turnstile.render(container, {
    sitekey: document.querySelector('meta[name="dmv-turnstile-site-key"]')?.content,
    theme: 'dark', // match CRT aesthetic
    callback: (token) => {
      turnstileToken = token;
      console.log('[turnstile] token received');
    },
    'error-callback': () => {
      console.error('[turnstile] challenge errored');
      turnstileToken = null;
    },
    'expired-callback': () => {
      console.warn('[turnstile] token expired');
      turnstileToken = null;
    },
  });
}

function getTurnstileToken() {
  return turnstileToken;
}
```

Call `mountTurnstileWidget()` when the form reaches the review/submit phase. Call `getTurnstileToken()` when submitting and pass the returned value as the third argument to `insertRegistration(formData, 'ui', token)`.

If `getTurnstileToken()` returns null at submit time, either block submission with a user-facing error ("Please complete the challenge") OR wait for the Turnstile callback to fire and retry. The UX depends on how the CRT terminal handles async state today — match the existing pattern.

- [ ] **Step 4: Expose the Turnstile site key to the browser JS**

The site key is in `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY`, but that's only visible server-side. The browser JS reads it from a meta tag that we add to `index.html` at build time.

Option A (simplest): add a static meta tag to `index.html`:
```html
<meta name="dmv-turnstile-site-key" content="0x4AAA...<paste site key>">
```

Option B (cleaner): modify `scripts/build-cf.mjs` to read `TURNSTILE_SITE_KEY` from `wrangler.jsonc` and inject it into the `dist/index.html` copy as a meta tag at build time. This keeps the site key in exactly one place (`wrangler.jsonc`).

**Recommendation: Option A for simplicity**, because the site key is a public value and committing it to `index.html` is fine. Option B is cleaner but adds build complexity.

Go with Option A: add the meta tag in `index.html` head section:
```html
<meta name="dmv-turnstile-site-key" content="0x4AAA...<paste your site key>">
```

- [ ] **Step 5: Local smoke test the browser flow**

This is the hardest part of the plan to smoke locally because Turnstile's test site keys are the only way to test without a real domain. Cloudflare provides test site keys that always pass or always fail:

- `1x00000000000000000000AA` — always passes (use for happy-path testing)
- `2x00000000000000000000AB` — always fails
- `3x00000000000000000000FF` — always challenges (interactive)

For local smoke, temporarily set the `TURNSTILE_SITE_KEY` in `wrangler.jsonc` to `1x00000000000000000000AA` AND set the `TURNSTILE_SECRET_KEY` via `wrangler secret put` to `1x0000000000000000000000000000000AA` (the matching test secret).

Then:
```bash
pnpm cf:build
pnpm cf:dev
# Open http://localhost:<port>/
# Complete the CRT form flow, submit, verify the form succeeds end-to-end
# (the POST should hit /api/register, Turnstile verify, and forward to Supabase)
```

**IMPORTANT: revert the test site key + secret back to the real values before committing or deploying.**

- [ ] **Step 6: Commit**

```bash
git add js/supabase.js js/CRTTerminal.js index.html
git commit -m "$(cat <<'EOF'
feat(web): route registration through /api/register with Turnstile

Browser registration flow now:
1. Loads Turnstile API from challenges.cloudflare.com (deferred, explicit render)
2. Mounts the widget when the CRT form reaches the submit screen
3. Captures the response token via callback
4. POSTs to /api/register (worker proxy) instead of Supabase direct
5. Sends the token in the cf-turnstile-response body field
6. Worker verifies with siteverify and forwards to Supabase on success

Turnstile site key is exposed via <meta name="dmv-turnstile-site-key">
(public, safe to commit). Secret key stays in wrangler secrets.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: CLI — route through `/api/register`

**Files:**
- Modify: `packages/dmv-agent/src/register.ts`
- Modify: `packages/dmv-agent/package.json` (version bump)

- [ ] **Step 1: Update `REGISTER_ENDPOINT` in `packages/dmv-agent/src/register.ts`**

```ts
// OLD
const REGISTER_ENDPOINT =
  'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent';

// NEW — route through DMV worker proxy, with env var override for dev/staging
const REGISTER_ENDPOINT =
  process.env.DMV_API_ENDPOINT ??
  'https://dmv.agentcommunity.org/api/register';
```

The env var override lets a developer or a CI pipeline point at a staging worker (`http://localhost:8787/api/register` during `pnpm cf:dev`) without code changes.

Everything else in the file stays the same. The CLI already sends `machine_fingerprint` in the body — the worker proxy passes it through to Supabase, which now enforces it (Task 3).

- [ ] **Step 2: Bump the package version**

Open `packages/dmv-agent/package.json`, find the `version` field, bump it according to the existing semver scheme. If the current version is `0.3.2`, bump to `0.4.0` (minor bump — routing change is a meaningful behavior shift, even though the user-visible API is unchanged).

Also check `packages/dmv-agent-alias/package.json` if it exists (alias package); keep versions in sync.

- [ ] **Step 3: Rebuild and smoke test the CLI locally**

```bash
cd packages/dmv-agent
pnpm build
# Run the built CLI against local cf:dev
DMV_API_ENDPOINT="http://localhost:8787/api/register" node ./dist/cli.js register \
  --name clismoke \
  --email clismoke@example.com \
  --operator 'Smoke Test Operator' \
  --description 'smoke test'
```

Expected: the CLI hits the local worker, which rate-limits + validates + forwards to Supabase, and the Supabase function either succeeds (200 with certificate_id) or fails with a specific validation error. The CLI should display the error from the worker's response body.

**If the CLI hits a rate limit or the Supabase function rejects because the smoketest email already exists, that's expected — the fix is to use a unique email per run or clear the Upstash limits.**

- [ ] **Step 4: Commit**

```bash
git add packages/dmv-agent/src/register.ts packages/dmv-agent/package.json \
        packages/dmv-agent-alias/package.json
git commit -m "$(cat <<'EOF'
feat(cli): route registration through DMV worker /api/register

CLI and MCP now POST to https://dmv.agentcommunity.org/api/register by
default (overridable via DMV_API_ENDPOINT env var for dev/staging).
The worker proxy applies REGISTER_RATE_LIMITER (5 req/60s per IP),
passes machine_fingerprint through to Supabase where it's now
enforced server-side (see edge function Task 3), and forwards the
result.

Old CLI versions that still POST direct to Supabase continue to work
for now — the bypass closure is staged for ~2 weeks after this release
ships to allow users time to upgrade.

Bumps version to X.Y.Z (minor — routing change).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Replace `X.Y.Z` with the actual bumped version.)

---

### Task 7: MCP — inherit the CLI change

**Files:**
- Modify: potentially `packages/dmv-agent/src/mcp.ts` or `packages/dmv-agent/src/index.ts` depending on how MCP shares code with the CLI

- [ ] **Step 1: Verify MCP reuses the same `registerAgent` function**

```bash
grep -rn 'registerAgent\|register-agent\|REGISTER_ENDPOINT' packages/dmv-agent/src/
```

If MCP imports `registerAgent` from `./register.ts`, Task 6's endpoint change automatically applies and there's nothing to do here. If MCP has its own separate fetch call, update it the same way.

- [ ] **Step 2: If MCP has a separate path, update it and commit**

Same endpoint change as Task 6. Otherwise skip to Task 8 and mark Task 7 as "no-op — covered by Task 6".

---

### Task 8: Local smoke — full end-to-end

**Files:** None (verification only)

- [ ] **Step 1: Restore real Turnstile keys**

If you used test keys during Task 5 Step 5, restore the real values now:
```bash
# Revert wrangler.jsonc TURNSTILE_SITE_KEY to the real site key
# Revert the TURNSTILE_SECRET_KEY wrangler secret to the real secret
pnpm wrangler secret put TURNSTILE_SECRET_KEY
# Paste real secret
```

- [ ] **Step 2: Full local smoke**

```bash
pnpm cf:dev
# In another terminal:

# Worker proxy responds
curl -sI http://localhost:8787/api/register | head -2
# Expected: HTTP/1.1 405 (GET not allowed)

# CLI path (with real fingerprint, test env)
DMV_API_ENDPOINT="http://localhost:8787/api/register" \
  node packages/dmv-agent/dist/cli.js register \
    --name localsmoke-$(date +%s) \
    --email localsmoke@example.com \
    --operator 'Local Smoke' \
    --description 'local smoke'
# Expected: either a successful registration with a cert ID, or an
# explicit Supabase-side validation error. Either way: the request MUST
# reach Supabase (verify via wrangler dev log showing the outbound fetch).

# Browser path: open the site in a real browser
open http://localhost:8787/
# - Complete the CRT form
# - Verify the Turnstile widget appears on the submit screen
# - Verify the form submits successfully
# - Check browser devtools → network tab → the POST to /api/register
#   should be a same-origin request (not cross-origin to Supabase)
```

- [ ] **Step 3: Run a regression smoke against the existing CF hardening**

Reuse the Task 10 Step 3 smoke checklist from the 2026-04-07 plan — verify that nothing in this new work broke `/api/card`, `/api/og`, `/badge/*`, `/c/:cert/:name`, `/healthz`, or the root `/` CSP.

---

### Task 9: Deploy + prod smoke + staged rollout

**Files:** None (verification + deploy)

- [ ] **Step 1: Verify bindings dry-run still passes**

```bash
pnpm wrangler deploy --dry-run
```

Expected: all previous bindings + `REGISTER_RATE_LIMITER (5 requests/60s)` + `TURNSTILE_SITE_KEY` + `TURNSTILE_SECRET_KEY`.

- [ ] **Step 2: Deploy the Supabase edge function FIRST**

The worker proxy assumes the Supabase function is aware of `x-dmv-proxy: v1` and the fingerprint rate limiter. Deploy the edge function first so it's ready when the worker starts forwarding:

```bash
pnpm supabase functions deploy register-agent
```

- [ ] **Step 3: Deploy the worker**

```bash
pnpm cf:deploy
```

- [ ] **Step 4: Publish the new CLI version to npm**

```bash
cd packages/dmv-agent
pnpm build
pnpm publish --access public
# If there's a separate alias package, publish it too
cd ../dmv-agent-alias && pnpm publish --access public
```

- [ ] **Step 5: Post-deploy smoke**

```bash
# GET → 405
curl -sI https://dmv.agentcommunity.org/api/register | head -2

# Missing fields → 400
curl -si -X POST -H 'content-type: application/json' \
  --data-binary '{}' \
  https://dmv.agentcommunity.org/api/register | head -5

# CLI fingerprint path end-to-end
bunx dmv-agent@latest register \
  --name prodsmoke-$(date +%s) \
  --email prodsmoke@example.com \
  --operator 'Prod Smoke' \
  --description 'prod deploy verification'
# Expected: registration succeeds through the worker proxy

# Browser path: open in a real browser
open https://dmv.agentcommunity.org/
# - Complete the CRT form
# - Verify Turnstile widget renders (invisible/managed mode)
# - Submit and verify success
```

- [ ] **Step 6: Watch `wrangler tail` for ~2 minutes**

Look for:
- No `[register] REGISTER_RATE_LIMITER.limit failed` errors
- No `[turnstile] siteverify` errors
- Analytics events appearing under `path: /api/register` in the `dmv_worker_events` dataset

If anything looks unhealthy, rollback via `pnpm wrangler rollback`. The previous worker version doesn't know about `/api/register` and won't serve it (will 404) — that's fine, clients will fall back to their own error handling.

- [ ] **Step 7: Announce the new CLI version**

Tell users to upgrade: `bunx dmv-agent@latest register`. Pin the CLI changelog entry to the top of the package README.

---

### Task 10: Docs update

**Files:**
- Modify: `CLOUDFLARE.md` (Operational notes + Files table)
- Modify: `ARCHITECTURE.md` (Rate limiting section + data flow)

- [ ] **Step 1: Add an "API registration proxy" bullet to `CLOUDFLARE.md` Operational notes**

Add a new bullet after the existing "Rate limiting" bullet:

```markdown
- **API registration proxy** (2026-04-08): `/api/register` is a worker-proxied
  route that forwards POSTs to the Supabase `register-agent` edge function
  with added protections. Browser requests must include a Turnstile response
  token (`cf-turnstile-response` body field) which the worker verifies via
  `https://challenges.cloudflare.com/turnstile/v0/siteverify` before
  forwarding. CLI/MCP requests skip Turnstile but must include a
  `machine_fingerprint` body field, which the Supabase function verifies
  via Upstash Redis (3/fingerprint/24h — mirrors the CLI's local lockfile).
  The proxy applies `REGISTER_RATE_LIMITER` (5 req/60s per IP) via the
  Workers Rate Limiting API (namespace_id 1002, separate from the
  `API_RATE_LIMITER` used by /api/card + /api/og). Legacy CLI versions that
  still POST direct to Supabase continue to work — the Supabase-direct
  bypass closure is staged and deferred.
```

- [ ] **Step 2: Update the `CLOUDFLARE.md` Files table**

Add a new row (or extend the existing `register-agent` mention) noting that `supabase/functions/register-agent/index.ts` now requires `machine_fingerprint` to be verified for non-browser requests.

- [ ] **Step 3: Update `CLOUDFLARE.md` Known gaps**

The previous plan's CLOUDFLARE.md had an "API hardening" known gap bullet. DELETE it — this plan closed the gap.

- [ ] **Step 4: Update `ARCHITECTURE.md` Layer 0**

The previous plan added Layer 0 (CF Worker edge rate limit on `/api/card` + `/api/og`). Update the Layer 0 scope note to add `/api/register` (with its separate limiter) and clarify that this also covers the registration path now:

Change the Layer 0 paragraph to:

> **Layer 0 — Cloudflare Worker edge rate limit.** 100 req/60s per `${ip}:${pathname}` on `/api/card` and `/api/og` (namespace_id 1001) + 5 req/60s per `${ip}` on `/api/register` (namespace_id 1002, added 2026-04-08). Runs BEFORE any cache lookups or upstream forwarding. Rejected requests return `429` with `Retry-After: 60`. Configured in `wrangler.jsonc` under the top-level `ratelimits` array. `/api/register` is additionally protected by Turnstile (browser) or machine_fingerprint verification (CLI/MCP), layered on top of the existing 6 Supabase-side layers for the registration path.

- [ ] **Step 5: Commit**

```bash
git add CLOUDFLARE.md ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs: document /api/register worker proxy in CLOUDFLARE + ARCHITECTURE

Closes the "API hardening" known gap from the 2026-04-07 plan. Adds
an Operational notes bullet describing the Turnstile + fingerprint
verification split, the separate REGISTER_RATE_LIMITER namespace,
and the staged bypass rollout. Updates Layer 0 in ARCHITECTURE.md to
reflect the expanded scope (now covers /api/register at 5 req/60s per
IP in addition to the card-render endpoints).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: Supabase bypass closure — DEFERRED

**⚠ DO NOT RUN THIS TASK until at least 2 weeks after Task 9 deploys and CLI adoption is confirmed.**

The existing direct path (`https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent`) must continue to accept requests from old CLI versions until enough users have upgraded to the new version. Closing the bypass breaks old installs.

**When to run:**
- 2+ weeks after Task 9 deploys
- AND telemetry shows that direct-Supabase POSTs (without the `x-dmv-proxy: v1` header) have dropped below an acceptable threshold (e.g., <5% of total registrations)
- AND the new CLI version has been published and promoted to users

**Files:**
- Modify: `supabase/functions/register-agent/index.ts`

- [ ] **Step 1: Check the `x-dmv-proxy` header in the edge function**

At the top of the handler, add:

```ts
const proxyHeader = req.headers.get('x-dmv-proxy');
if (proxyHeader !== 'v1') {
  return new Response(
    JSON.stringify({
      error: 'Direct Supabase access is no longer supported. Please upgrade your DMV client: bunx dmv-agent@latest',
    }),
    {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    },
  );
}
```

- [ ] **Step 2: Deploy the edge function**

```bash
pnpm supabase functions deploy register-agent
```

- [ ] **Step 3: Verify direct Supabase access is now blocked**

```bash
curl -si -X POST \
  -H 'content-type: application/json' \
  --data-binary '{"agent_name":"bypassprobe","email":"a@b.co","signup_source":"cli","registration_type":"AGENT"}' \
  https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent | head -10
```

Expected: `HTTP/2 403` with the upgrade message in the body.

- [ ] **Step 4: Verify the worker proxy still works**

```bash
bunx dmv-agent@latest register --name closetest --email ... ...
```

Expected: registration succeeds via the worker proxy.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/register-agent/index.ts
git commit -m "$(cat <<'EOF'
feat(edge): require X-DMV-Proxy header on register-agent

Closes the Supabase-direct bypass documented in the 2026-04-08 API
hardening plan. All registration traffic must now flow through the
DMV worker /api/register proxy which adds the x-dmv-proxy: v1 header
before forwarding upstream.

Direct POSTs from legacy CLI versions will now receive a 403 with an
upgrade message. Users must run `bunx dmv-agent@latest register` to
continue.

This is the deferred Task 11 of the plan — only run it after CLI
adoption telemetry shows <5% direct-Supabase traffic.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** Closes the "API hardening" known gap from the 2026-04-07 plan. Adds Turnstile to browser flows (the original audit's explicit recommendation), server-side fingerprint verification for CLI flows, and a worker proxy layer that consolidates the registration path under the same rate-limiting + observability umbrella as the render path.
- **Scope boundary:** This plan does NOT change the cert ID generation, database schema, email flow, or the 6 existing Upstash rate limiters on `register-agent`. It only ADDS layers.
- **Staged rollout:** Task 11 (bypass closure) is explicitly deferred. Running it prematurely breaks old CLI installs. The `x-dmv-proxy: v1` sentinel header is added in Task 2 so the closure check in Task 11 has something to key on when the time comes.
- **Dashboard prereq:** Turnstile widget creation requires one-time dashboard access. Sub-agents can't do it. Flagged in Task 1.
- **Secret management:** `TURNSTILE_SECRET_KEY` uses `wrangler secret put` (encrypted at rest, not in source). `TURNSTILE_SITE_KEY` is public and can live in `wrangler.jsonc vars`. The browser reads the site key from a `<meta>` tag in `index.html`.
- **Test site keys:** Turnstile provides test keys (`1x00000000000000000000AA` etc.) that always pass/fail — flagged in Task 5 Step 5 for local development. Remember to revert before deploy.
- **CLI env var override:** `DMV_API_ENDPOINT` lets developers point at staging or local without code changes. Defaults to the production worker URL.
- **CSP impact:** Adding `challenges.cloudflare.com` to `script-src`, `connect-src`, and new `frame-src` is required for the Turnstile widget. Both `public/_headers` and `worker/index.ts` `PERMALINK_CSP` must be updated in lockstep (per the existing CSP drift comment in the worker).

### Research log

- Turnstile documentation: https://developers.cloudflare.com/turnstile/
- Test site keys: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- Workers Rate Limiting API (already verified in the 2026-04-07 plan): supports multiple `ratelimits` entries with distinct `namespace_id` values.
- Upstash Ratelimit (already used by `register-agent`): supports multiple limiter instances in the same function, each with its own `prefix` key.
- The existing CLI `machine_fingerprint` is `SHA-256(hostname + username + platform)` per `packages/dmv-agent/src/rate-limit.ts`. Spoofable but raises the cost floor for adversaries compared to no check.
