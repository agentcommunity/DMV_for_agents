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
- **NEW:** browser Turnstile widget using **Invisible widget mode** (configured in the Cloudflare dashboard) so the CRT canvas aesthetic stays intact. Invisible widget mode guarantees the widget never shows any UI at all — no checkbox, no iframe, no challenge overlay — even for visitors who trip Cloudflare's heuristics. Those visitors pass silently or fail silently via error-callback. The render call uses `execution: 'execute'` so the challenge is deferred until form submit rather than running on page load, and on submit `turnstile.execute()` is called and the token is awaited before the `/api/register` POST. A "Protected by Cloudflare" attribution is added to the page footer (Cloudflare ToS requirement for Turnstile deployments).
- **NEW:** server-side `machine_fingerprint` verification in the Supabase edge function (was sent by CLI but unverified)
- **NEW:** closed Supabase-direct bypass (final step, staged after client adoption)
- **PRESERVED:** existing Upstash Redis rate limits in `register-agent` (6 layers documented in ARCHITECTURE.md)
- **PRESERVED:** existing machine fingerprint generation in `packages/dmv-agent/src/rate-limit.ts`
- **PRESERVED:** certificate ID generation + database write flow (unchanged)
- **PRESERVED:** the CRT terminal's pure-Canvas2D rendering — no DOM form fields are added; Turnstile's mount div sits outside the TV scene and is visually silent for the happy path.

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
| `index.html` | 4 | Turnstile script, `#turnstile-container` mount div (off-screen, never visibly renders because of Invisible widget mode), `dmv-turnstile-site-key` meta tag, and footer attribution line |
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
2. Widget name: `dmv_agentcommunity`
3. Hostname: `dmv.agentcommunity.org`
4. Widget mode: **Invisible** — fits the CRT's fully-canvas UI constraint. The widget never shows UI, even for suspicious visitors; they pass silently or fail silently (error-callback fires). The tradeoff is that visitors who trip Cloudflare's heuristics can't recover via an interactive challenge — they just get blocked. Acceptable for DMV because we have four additional defense layers (worker `REGISTER_RATE_LIMITER` + Upstash per-IP / per-email / per-IP+email / per-fingerprint) and pre-registration visitors can retry from a cleaner IP/session.
5. Pre-clearance ("Skip future security rule challenges for verified visitors"): **No**. DMV has no zone-level WAF rules or Bot Fight Mode that would benefit from the 30-min clearance cookie. Enable later if/when zone-level rules are added.
6. Copy the Site Key (public, looks like `0x4AAA...`) and Secret Key (private, looks like `0x4AAA...`)
7. Pass the site key to the sub-agent via the task dispatch. Install the secret key — see Step 1 below for the recommended path.

- [ ] **Step 1: Install `TURNSTILE_SECRET_KEY` on the Worker**

The Worker uses versioned-secrets semantics, which means `pnpm wrangler secret put` will refuse to add a secret if the latest uploaded Worker version isn't the currently deployed one (orphan-version guard). The cleanest install path that sidesteps the version state machine entirely is the Cloudflare dashboard:

1. https://dash.cloudflare.com → Workers & Pages → `dmv-agentcommunity`
2. Settings → Variables and Secrets → Add variable
3. Type: **Secret (encrypted)**
4. Name: `TURNSTILE_SECRET_KEY`
5. Value: paste the private key from the Turnstile dashboard
6. Save

If you prefer CLI and the Worker version state is clean (i.e., `wrangler versions list` shows the latest uploaded == latest deployed), this works:

```bash
pnpm wrangler secret put TURNSTILE_SECRET_KEY
# Paste the secret key from the Turnstile dashboard when prompted
```

If you hit the "latest version isn't currently deployed" error, use the dashboard path above, or use `pnpm wrangler versions secret put TURNSTILE_SECRET_KEY` (creates a pending version without deploying — the secret becomes active when Task 9 later runs `pnpm cf:deploy`).

Verify (read-only, works regardless of version state):
```bash
pnpm wrangler secret list --name dmv-agentcommunity
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

- [ ] **Step 2: Add the Turnstile mount div**

Because the widget is configured in **Invisible mode** in the Cloudflare dashboard, it never renders any UI — ever. No checkbox, no iframe overlay, no interactive challenge popup. So the mount div only needs to exist as a DOM anchor for the Turnstile script to attach to; its position and visibility are irrelevant. We use an off-screen absolutely-positioned div rather than `display:none` because some browsers pause iframes inside `display:none` ancestors, which could interfere with Turnstile's silent background verification.

Add this near the end of `<body>` in `index.html`, after any existing overlay divs:

```html
<!-- Turnstile mount anchor. The widget uses Invisible mode (dashboard config)
     so it never renders any visible UI — this div is purely a DOM anchor
     for turnstile.render(). Positioned off-screen rather than display:none
     because some browsers pause iframes inside display:none ancestors,
     which could break Turnstile's silent background verification. -->
<div id="turnstile-container"
     aria-hidden="true"
     style="position:absolute;left:-9999px;top:-9999px;width:0;height:0;opacity:0;pointer-events:none"></div>
```

That's it. No shell wrapper, no grace timer, no conditional un-hiding. The CRT canvas and Three.js scene are completely untouched by Turnstile.

- [ ] **Step 2b: Add Cloudflare Turnstile attribution to the footer**

Cloudflare's Turnstile ToS requires attribution when using the service, regardless of widget mode. Add a small attribution to the existing page footer (or create one if none exists). In `index.html`, inside the footer area (look for `<footer>` or the existing bottom status strip), add:

```html
<span class="dmv-turnstile-attribution" style="font-size:1.1rem;opacity:0.6">
  Bot protection by
  <a href="https://www.cloudflare.com/products/turnstile/" target="_blank" rel="noopener noreferrer" style="color:inherit">Cloudflare Turnstile</a>
</span>
```

Style to taste — the attribution is required but can be subtle. If the footer doesn't have a reasonable spot, add a minimal one-liner below the existing status strip.

- [ ] **Step 3: Update CSP to allow the Turnstile origin**

**DRIFT NOTE (2026-04-08):** Commit `65b82e4 fix(cf): allow blob: in img-src and connect-src CSP for GLTF textures` landed on main after this plan was originally written. That commit added `blob:` to `img-src` and `connect-src` in BOTH `public/_headers` and `worker/index.ts` `PERMALINK_CSP`. **Before editing, re-read both files and use the actual current strings** rather than the strings quoted below — the Turnstile additions must be layered on top of the blob: additions, not instead of them.

The CSP in `public/_headers` as of commit `65b82e4` reads:
```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Change to (added `https://challenges.cloudflare.com` in `script-src`, `connect-src`, and a new `frame-src` directive — keep the `blob:` tokens that were added in `65b82e4`):

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net https://challenges.cloudflare.com; frame-src https://challenges.cloudflare.com; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

Turnstile's Invisible mode still creates a hidden iframe internally for the silent verification handshake, so `frame-src` is required even though the user never sees the iframe.

**Also update `PERMALINK_CSP` in `worker/index.ts`** to the exact same string (it's duplicated per the code comment at the constant declaration, around line 153). The current `PERMALINK_CSP` as of commit `65b82e4` is byte-identical to the `public/_headers` CSP above (the `blob:` fix touched both in lockstep), so the same find-and-replace applies. Don't forget this — if the two drift, `/c/:cert/:name` permalink responses get a different CSP than the root SPA, which is how the 2026-04-07 plan's Task 8 hit a bug.

**Verification before commit:**
```bash
grep -c 'challenges.cloudflare.com' public/_headers       # → should be 3 (script-src, connect-src, frame-src)
grep -c 'challenges.cloudflare.com' worker/index.ts       # → should be 3 (same three directives inside PERMALINK_CSP)
grep -c "'self' data: blob:" public/_headers              # → should be 1 (img-src — preserved from 65b82e4)
grep -c "'self' blob: https://tcymqfwwphacnosnnzxl" public/_headers  # → should be 1 (connect-src start — preserved from 65b82e4)
```

- [ ] **Step 4: Commit**

```bash
git add index.html public/_headers worker/index.ts
git commit -m "$(cat <<'EOF'
feat(web): add Invisible Turnstile mount + attribution + CSP updates

- Loads Turnstile API from challenges.cloudflare.com with ?render=explicit
  so we control the render lifecycle from CRTTerminal.js
- Adds #turnstile-container mount div OUTSIDE the CRT canvas, positioned
  off-screen (position:absolute, left:-9999px). Widget is configured in
  Invisible mode in the Cloudflare dashboard so it never produces any
  visible UI — the mount div exists purely as a DOM anchor for the
  Turnstile script, and the 3D TV scene stays completely untouched
- Adds the required "Bot protection by Cloudflare Turnstile" attribution
  in the page footer (Turnstile ToS)
- Adds dmv-turnstile-site-key meta tag so the JS can read the public key
  without a build-time injection step
- Extends CSP script-src, connect-src, and new frame-src with
  https://challenges.cloudflare.com (frame-src because Turnstile still
  creates a hidden iframe internally even in Invisible mode)
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

- [ ] **Step 3: Render the Turnstile widget (Invisible mode)**

In `js/CRTTerminal.js` (or wherever the form's review/submit phase transitions), add the following widget manager. Because the Turnstile widget is configured in **Invisible mode** in the Cloudflare dashboard, no visible UI ever renders — we don't need the shell-unhide dance, grace timers, or interactive-challenge handling. We just need:

1. **`execution: 'execute'`** in the render call so the challenge is deferred until form submit (don't burn Turnstile quota on visitors who abandon the form before submit).
2. A Promise-wrap around the single-arg `turnstile.execute(widgetId)` API, using render-time callbacks + a module-level pending-resolver slot. Cloudflare's documented `execute()` signature is single-argument (`execute(widgetId | selector)`) — per-execute callback overrides are NOT part of the public API, so the render-time callbacks + pending slot pattern is the canonical way to Promise-wrap.
3. A hard timeout (15s) in case the silent verification hangs.
4. `turnstile.reset(widgetId)` on failure so the next attempt starts clean.

```js
// Turnstile widget management — Invisible widget mode.
//
// The widget is configured in Invisible mode in the Cloudflare dashboard,
// so turnstile.render() never produces any visible UI — the #turnstile-container
// mount div stays off-screen and empty-looking to the user. All verification
// happens silently in a background iframe.
//
// Lifecycle:
//   1. mountTurnstileWidget() is called once when the CRT form reaches the
//      review/submit phase. It calls turnstile.render() with execution='execute',
//      which creates the widget but does NOT run the challenge.
//   2. On submit, executeTurnstile() stores fresh resolve/reject handlers in
//      the pending slot, then calls turnstile.execute(widgetId). The render-
//      time callback fires (silently, no UI), consumes the pending slot, and
//      the promise settles with the token.
//   3. On error/expiry/timeout the promise rejects with a descriptive Error,
//      and we reset the widget via turnstile.reset(widgetId) so the next
//      submit attempt starts fresh.

let turnstileWidgetId = null;
let turnstileRenderAttempted = false;

// Single-slot pending resolver. Overwritten on each executeTurnstile() call.
// Only one verification-in-flight is possible at a time, which matches the
// CRT submit button's single-click-then-disable UX.
let pendingTurnstileResolve = null;
let pendingTurnstileReject = null;
let pendingTurnstileTimer = null;

function _settleTurnstile(ok, value) {
  const resolve = pendingTurnstileResolve;
  const reject = pendingTurnstileReject;
  pendingTurnstileResolve = null;
  pendingTurnstileReject = null;
  if (pendingTurnstileTimer) {
    clearTimeout(pendingTurnstileTimer);
    pendingTurnstileTimer = null;
  }
  if (ok && resolve) resolve(value);
  else if (!ok && reject) reject(value);
}

function mountTurnstileWidget() {
  if (turnstileRenderAttempted && turnstileWidgetId !== null) return;
  if (typeof window.turnstile === 'undefined') {
    console.warn('[turnstile] script not loaded yet — will retry on first execute');
    return;
  }
  turnstileRenderAttempted = true;

  const container = document.getElementById('turnstile-container');
  if (!container) {
    console.warn('[turnstile] #turnstile-container missing');
    return;
  }

  const siteKey = document.querySelector('meta[name="dmv-turnstile-site-key"]')?.content;
  if (!siteKey) {
    console.error('[turnstile] dmv-turnstile-site-key meta tag missing');
    return;
  }

  try {
    turnstileWidgetId = window.turnstile.render(container, {
      sitekey: siteKey,
      execution: 'execute',  // don't run challenge until we call execute()
      callback: (token) => _settleTurnstile(true, token),
      'error-callback': (errorCode) => {
        console.error('[turnstile] challenge errored', errorCode);
        _settleTurnstile(false, new Error(`Turnstile error: ${errorCode || 'unknown'}`));
      },
      'expired-callback': () => {
        _settleTurnstile(false, new Error('Turnstile token expired — please retry'));
      },
    });
  } catch (err) {
    console.error('[turnstile] render failed', err);
    turnstileWidgetId = null;
  }
}

function executeTurnstile({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof window.turnstile === 'undefined') {
      return reject(new Error('Turnstile script not loaded'));
    }
    if (turnstileWidgetId === null) {
      mountTurnstileWidget();
      if (turnstileWidgetId === null) {
        return reject(new Error('Turnstile widget failed to mount'));
      }
    }

    // Overwrite any stale pending slot (shouldn't happen in normal flow, but
    // defend against rapid double-clicks that somehow bypass the submit
    // button's disabled state).
    if (pendingTurnstileResolve || pendingTurnstileReject) {
      _settleTurnstile(false, new Error('Turnstile verification superseded'));
    }

    pendingTurnstileResolve = resolve;
    pendingTurnstileReject = reject;

    pendingTurnstileTimer = setTimeout(() => {
      if (turnstileWidgetId !== null) {
        try { window.turnstile.reset(turnstileWidgetId); } catch { /* ignore */ }
      }
      _settleTurnstile(false, new Error('Turnstile verification timed out'));
    }, timeoutMs);

    try {
      window.turnstile.execute(turnstileWidgetId);
    } catch (err) {
      _settleTurnstile(false, err instanceof Error ? err : new Error(String(err)));
    }
  });
}

function resetTurnstile() {
  if (turnstileWidgetId !== null && typeof window.turnstile !== 'undefined') {
    try { window.turnstile.reset(turnstileWidgetId); } catch { /* ignore */ }
  }
}
```

**Wire-up:**
- Call `mountTurnstileWidget()` when the CRT form transitions into the review/submit phase. Idempotent — repeated calls are no-ops once the widget is rendered.
- When the user clicks the CRT submit button, `await executeTurnstile()` **before** calling `insertRegistration()`. Pass the resolved token as the third argument: `await insertRegistration(formData, 'ui', token)`.
- If `executeTurnstile()` rejects, surface a CRT-styled error matching the existing form-validation error pattern ("VERIFICATION FAILED — PLEASE RETRY"), reset the submit button, and call `resetTurnstile()` so the widget is ready for the next attempt. Do NOT fall back to calling `insertRegistration()` without a token — the worker will reject it (400 turnstile-missing or 403 turnstile-failed).
- The submit button MUST be disabled between click and the promise settling, so a double-click doesn't create two `pendingTurnstileResolve` slots (the second would supersede the first via the safety check inside `executeTurnstile`).

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

Matching test secret keys:
- `1x0000000000000000000000000000000AA` — always passes
- `2x0000000000000000000000000000000AA` — always fails

(There's also a `3x00000000000000000000FF` / `3x000...AA` always-interactive-challenge pair, but it's not useful here — **Invisible widget mode will ignore the interactive-challenge request** and fail via the error-callback path instead. Don't smoke test with it; the result would be the same as the always-fail test keys and would just confuse the interpretation.)

For local smoke, temporarily set three things to the test values:
1. `wrangler.jsonc` `vars.TURNSTILE_SITE_KEY` → `1x00000000000000000000AA`
2. `index.html` `<meta name="dmv-turnstile-site-key">` → `1x00000000000000000000AA`
3. Install the matching test secret: use the Cloudflare dashboard (Worker Settings → Variables and Secrets) to edit `TURNSTILE_SECRET_KEY` to `1x0000000000000000000000000000000AA`. Dashboard path avoids the `wrangler secret put` version-mismatch issue.

Then:
```bash
pnpm cf:build
pnpm cf:dev
# Open http://localhost:<port>/
# 1. Complete the CRT form flow to the review/submit screen.
# 2. Verify in devtools:
#    - #turnstile-container exists in the DOM and is positioned off-screen
#      (position:absolute, left:-9999px)
#    - No Cloudflare iframe visibly overlays the page at any point
#    - window.turnstile exists and turnstileWidgetId was assigned
# 3. Click submit. Open the Network tab and confirm:
#    - A POST to /api/register (same-origin, NOT supabase.co)
#    - Request body includes `cf-turnstile-response: <test token>` (the test
#      key always returns the string "XXXX.DUMMY.TOKEN.XXXX" or similar)
#    - Response is 200/201, or a specific Supabase-side error (e.g. duplicate
#      email, agent name taken) — anything EXCEPT a worker-side Turnstile
#      rejection. If you see `{"error":"Turnstile token required..."}` or
#      `{"error":"Turnstile verification failed"}`, token capture or
#      siteverify is broken.
# 4. Failure path: swap all three values to the always-fail test keys
#    (`2x00000000000000000000AB` in wrangler.jsonc + meta tag,
#    `2x0000000000000000000000000000000AA` in dashboard secret). Rebuild
#    and reload. Submit the form and verify the CRT surfaces a
#    "VERIFICATION FAILED" error without POSTing to /api/register — the
#    error surfaces from executeTurnstile() via error-callback, NOT from
#    the worker (the POST never fires).
```

**IMPORTANT: revert the test site key + secret back to the real values in all three places (wrangler.jsonc, index.html meta tag, dashboard secret) before committing or deploying.** Grep for `1x00000000000000000000AA` and `2x00000000000000000000AB` before committing to catch any leftover test keys.

- [ ] **Step 6: Commit**

```bash
git add js/supabase.js js/CRTTerminal.js index.html
git commit -m "$(cat <<'EOF'
feat(web): route registration through /api/register with Invisible Turnstile

Browser registration flow now:
1. Mounts the Turnstile widget lazily when the CRT form reaches the review
   phase, with execution=execute so the challenge is deferred until form
   submit. Widget is configured in Invisible mode in the Cloudflare
   dashboard so no UI ever renders — visitors pass or fail silently.
2. On submit, turnstile.execute() is called and the render-time callback
   resolves a module-level pending promise via executeTurnstile().
   Zero visible UI, CRT aesthetic fully preserved.
3. Resolved token is sent as cf-turnstile-response in the /api/register
   POST body; the worker proxy verifies and forwards to Supabase.
4. Failed/expired/timed-out verification surfaces a CRT-styled
   "VERIFICATION FAILED" error and calls turnstile.reset() so the next
   attempt starts fresh. In Invisible mode, failure means the visitor
   tripped Cloudflare's silent heuristics — no interactive fallback path
   is available (by design; DMV has four other defense layers).
5. 15s hard timeout in case silent verification hangs.

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

Open `packages/dmv-agent/package.json`, find the `version` field, bump it according to the existing semver scheme.

**Current state (verified 2026-04-08):** `packages/dmv-agent/package.json` is at `0.1.0`. Bump to `0.2.0` (minor — routing change is a meaningful behavior shift even though the user-visible API is unchanged).

Also bump `packages/dmv-agent-alias/package.json` (the unscoped `dmv-agent` alias wrapper committed in `e3d5d0d`). Current: `0.1.0`. Bump to `0.2.0` AND update the `dependencies["@agentcommunity/dmv-agent"]` field from `">=0.1.0"` to `">=0.2.0"` so users installing the unscoped alias automatically pull the newer scoped package.

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

Bumps @agentcommunity/dmv-agent to 0.2.0 and the unscoped
dmv-agent alias to 0.2.0 (minor — routing change).

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

(Version already pinned above at 0.2.0 based on the 2026-04-08 current-state check.)

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

- **Spec coverage:** Closes the "API hardening" known gap from the 2026-04-07 plan. Adds Turnstile to browser flows (the original audit's explicit recommendation) in **Invisible widget mode** (configured in the Cloudflare dashboard) so the CRT aesthetic is fully preserved — zero visitors see any Turnstile UI, ever. The tradeoff (visitors who fail the silent heuristic can't recover via an interactive challenge) is acceptable because DMV has four additional defense layers on the registration path (worker `REGISTER_RATE_LIMITER` + three Upstash limiters + new per-fingerprint limiter) and pre-registration visitors can retry from a cleaner IP/session. Adds server-side fingerprint verification for CLI flows and a worker proxy layer that consolidates the registration path under the same rate-limiting + observability umbrella as the render path.
- **Scope boundary:** This plan does NOT change the cert ID generation, database schema, email flow, or the 6 existing Upstash rate limiters on `register-agent`. It only ADDS layers.
- **Staged rollout:** Task 11 (bypass closure) is explicitly deferred. Running it prematurely breaks old CLI installs. The `x-dmv-proxy: v1` sentinel header is added in Task 2 so the closure check in Task 11 has something to key on when the time comes.
- **Dashboard prereq:** Turnstile widget creation requires one-time dashboard access. Sub-agents can't do it. Flagged in Task 1.
- **Secret management:** `TURNSTILE_SECRET_KEY` uses `wrangler secret put` (encrypted at rest, not in source). `TURNSTILE_SITE_KEY` is public and can live in `wrangler.jsonc vars`. The browser reads the site key from a `<meta>` tag in `index.html`.
- **Test site keys:** Turnstile provides test keys (`1x00000000000000000000AA` etc.) that always pass/fail — flagged in Task 5 Step 5 for local development. Remember to revert before deploy.
- **CLI env var override:** `DMV_API_ENDPOINT` lets developers point at staging or local without code changes. Defaults to the production worker URL.
- **CSP impact:** Adding `challenges.cloudflare.com` to `script-src`, `connect-src`, and new `frame-src` is required for the Turnstile widget. `frame-src` is still required in Invisible mode because Turnstile creates a hidden internal iframe for the silent verification — even though no UI is shown to the user, the iframe still exists in the DOM and CSP must allow it. Both `public/_headers` and `worker/index.ts` `PERMALINK_CSP` must be updated in lockstep (per the existing CSP drift comment in the worker).
- **Widget mode caveats (important for sub-agents):**
  - Widget visibility is controlled at TWO layers: the **dashboard widget mode** (`Managed` / `Non-interactive` / `Invisible`, chosen when the widget is created) and the **client-side render params** (`appearance`, `execution`, `size`, `theme`). DMV uses **Invisible** at the dashboard layer, which guarantees no UI is ever shown regardless of client-side params.
  - The `size: 'invisible'` render param does NOT exist — Context7 docs (queried 2026-04-08) show only `size: 'normal' | 'flexible' | 'compact'`. Visibility is a dashboard-widget-mode concern, not a client-side size concern.
  - Because the dashboard mode is Invisible, `appearance: 'interaction-only'` is moot (there's no UI to conditionally show) and `theme: 'dark'` is moot (there's no UI to theme). The plan's render config includes only `sitekey`, `execution: 'execute'`, and the three callbacks.
  - The `turnstile.execute()` API is documented as single-argument (`execute(widgetId | selector)`) — per-execute callback overrides are NOT part of the public API, so Task 5's Promise-wrap uses render-time callbacks + module-level pending-resolver state. Don't invent a two-arg signature.
- **Attribution:** Cloudflare's Turnstile ToS requires visible attribution regardless of widget mode. Task 4 Step 2b adds a small "Bot protection by Cloudflare Turnstile" line to the page footer. Don't hide or remove it.

### Research log

- Turnstile documentation: https://developers.cloudflare.com/turnstile/
- Test site keys: https://developers.cloudflare.com/turnstile/troubleshooting/testing/
- Workers Rate Limiting API (already verified in the 2026-04-07 plan): supports multiple `ratelimits` entries with distinct `namespace_id` values.
- Upstash Ratelimit (already used by `register-agent`): supports multiple limiter instances in the same function, each with its own `prefix` key.
- The existing CLI `machine_fingerprint` is `SHA-256(hostname + username + platform)` per `packages/dmv-agent/src/rate-limit.ts`. Spoofable but raises the cost floor for adversaries compared to no check.
