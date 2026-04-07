# CF-Native Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land eight focused Cloudflare-native improvements surfaced by the 2026-04-07 audit — cache hygiene, coalescing, telemetry, rate limiting, KV badge cache, CSP/Early Hints, and container health metadata — ahead of the Brave takeover.

**Architecture:** All worker-side changes land in `worker/index.ts` and `wrangler.jsonc`. Static asset changes land in `public/_headers`. One container-side change lands in `container/server.mjs`. No new modules, no new dependencies. Verification is manual smoke tests + `wrangler tail` — per `CLOUDFLARE.md` there are no automated worker tests by design.

**Tech Stack:** Cloudflare Workers, Workers Static Assets, Workers Containers (Durable Objects), R2, `caches.default`, Analytics Engine, Workers Rate Limiting API, KV, HTMLRewriter, Hono (container), `@napi-rs/canvas` (container).

---

## Preamble — read before starting

Read these first (in order):
1. `CLAUDE.md` — project overview, constraints.
2. `CLOUDFLARE.md` — architecture, cache hierarchy, drift invariants, known gaps.
3. `worker/index.ts` — you'll be editing lots of this; skim the whole file once.
4. `docs/plans/archive/2026-04-01-dmv-hardening-plan.md` — existing hardening work. **Do not duplicate** anything from this plan.

**Hard constraints:**
- No new runtime dependencies in the worker or container.
- No automated worker tests (CLOUDFLARE.md "No automated worker tests by design"). Verify via `pnpm cf:dev` + curl + `wrangler tail`.
- Do not touch the browser renderer (`js/card-draw.js`) or the container renderer (`container/src/card-renderer.js`) — this plan is cache/transport/telemetry, not render logic.
- Any change to container sources changes `CONTAINER_INSTANCE_ID` and invalidates the entire R2+L1 cache namespace on next deploy. That is fine (deterministic, expected) but *know it*.
- Preserve existing `X-Cache` / `X-Cache-Key` headers — they are load-bearing for `wrangler tail` diagnostics.

**Verification pattern (reused throughout):**
```bash
# In one terminal:
pnpm cf:dev
# In another:
curl -i -H 'user-agent: curl' http://localhost:8787/api/og?name=dmv
curl -i -H 'user-agent: curl' http://localhost:8787/api/og?name=dmv   # 2nd hit should be L1-HIT
pnpm cf:tail   # for deployed tail
```

**Execution order:**
- Task 1 MUST ship first — every later task depends on new wrangler bindings.
- Tasks 2 → 7 all edit `worker/index.ts` and must run sequentially to avoid merge conflicts.
- Task 8 (`public/_headers`) touches a file no other task touches — it can run in parallel with tasks 2-7.
- Task 9 primarily edits `container/server.mjs` but ALSO makes a small `handleHealthz` tweak to `worker/index.ts`, so it must run AFTER Task 7. (Originally planned as parallel; demoted after code review revealed the worker's `/healthz` strips the container JSON and Task 9 is unverifiable without forwarding the payload.)
- Task 10 is the final code verification gate + deploy.
- Task 11 lands documentation updates (`CLOUDFLARE.md`, `ARCHITECTURE.md`) AFTER the code is live in production. Docs describe reality, not intent.

**Pre-flight verification (performed 2026-04-07, before dispatch):**
- `pnpm wrangler --version` → `4.80.0` ✓ (well above the 4.36.0 floor required by Task 1)
- `pnpm wrangler deploy --dry-run` on the current config → **succeeds**, container Dockerfile builds cleanly ✓
- Dry-run with a throwaway config copy containing the proposed Task 1 bindings (`kv_namespaces` + `analytics_engine_datasets` + top-level `ratelimits`) → **succeeds**, wrangler prints the expected bindings at the expected shapes:
  ```
  env.BADGE_CACHE_KV    KV Namespace
  env.ANALYTICS         Analytics Engine Dataset
  env.API_RATE_LIMITER  Rate Limit (100 requests/60s)
  ```
  This empirically confirms the plan's wrangler syntax is accepted by the installed wrangler version — no syntax surprises at Task 1 execution time.
- `grep CARD_VERSION container/src/card-renderer.js` → exported at lines 30 (`const CARD_VERSION = 2`) and 784 (named re-export) ✓ — Task 9's `import { CARD_VERSION }` will resolve.
- SHA-256 hash of the inline importmap in `index.html` → `sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=` (reproducible across runs) ✓ — matches the value hard-coded in Task 8 Step 2.
- `js/TV.js:144` → DRACOLoader decoder path is `https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/` ✓ — jsdelivr already covered by Task 8's CSP.

These pre-flight checks do NOT replace the per-task smoke tests and the post-deploy verification in Task 10. They DO validate the load-bearing assumptions of the plan (config syntax, symbol exports, content hashes) so sub-agents don't hit surprise breakage at dispatch time.

---

## File Structure

| File | Task(s) | Responsibility |
|---|---|---|
| `wrangler.jsonc` | 1 | New bindings: Analytics Engine, Rate Limiter, KV namespace |
| `worker/index.ts` | 2,3,4,5,6,7,9 | HEAD/304, Vary, analytics events, rate limiting, KV badge cache, L3 coalescing, healthz forward |
| `public/_headers` | 8 | CSP + Early Hints (`Link: rel=preload`) |
| `container/server.mjs` | 9 | Rich `/healthz` response |
| `CLOUDFLARE.md` | 11 | Docs: close "coalescing" gap, add Analytics Engine / rate limiting / KV / CSP sections |
| `ARCHITECTURE.md` | 11 | Docs: note the new CF edge rate limit as an additional rate-limiting layer |
| `docs/plans/archive/2026-04-07-cf-native-hardening.md` | — | This plan |

---

### Task 1: Add Cloudflare bindings (Analytics Engine, Rate Limiter, KV)

**Files:**
- Modify: `wrangler.jsonc`

This task creates the KV namespace, picks an Analytics Engine dataset name, and reserves a Rate Limiter namespace ID. Every later task will refer to these bindings by name.

- [ ] **Step 1: Verify current wrangler version supports the bindings**

Run:
```bash
pnpm wrangler --version
```
Expected: **wrangler ≥ 4.36.0**. Below that, the top-level `ratelimits` array in the next step is not recognized and you'll need to upgrade wrangler first (`pnpm add -D wrangler@latest -w`). Source: [Workers Rate Limiting binding docs](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/).

- [ ] **Step 2: Create the KV namespace for the badge cache**

Run:
```bash
pnpm wrangler kv namespace create BADGE_CACHE_KV
pnpm wrangler kv namespace create BADGE_CACHE_KV --preview
```
Expected output: two lines of JSON, one with `id = "<prod-id>"`, one with `preview_id = "<preview-id>"`. Copy both values — you'll paste them into `wrangler.jsonc` in the next step.

- [ ] **Step 3: Add bindings to `wrangler.jsonc`**

Locate the existing `"r2_buckets"` block in `wrangler.jsonc` (around line 101). Add these three new top-level keys **after** the `r2_buckets` array and **before** the `triggers` key:

```jsonc
	// ──────────────────────────────────────────────────────────────────────────
	//  KV: short-TTL edge cache for /badge/* responses
	// ──────────────────────────────────────────────────────────────────────────
	// Badge SVGs are deterministic per cert ID and cheap to regenerate on cache
	// miss. 10-minute TTL is invisible to users (badges aren't real-time) and
	// cuts Supabase edge function invocations by ~10x during the Brave window.
	"kv_namespaces": [
		{
			"binding": "BADGE_CACHE_KV",
			"id": "<PASTE-PROD-ID-FROM-STEP-2>",
			"preview_id": "<PASTE-PREVIEW-ID-FROM-STEP-2>"
		}
	],
	// ──────────────────────────────────────────────────────────────────────────
	//  Analytics Engine: structured metrics for cache tiers + container latency
	// ──────────────────────────────────────────────────────────────────────────
	// Free at DMV's volume. Replaces ad-hoc console.log observability with a
	// queryable dataset. Schema documented in worker/index.ts near the first
	// writeDataPoint call.
	"analytics_engine_datasets": [
		{
			"binding": "ANALYTICS",
			"dataset": "dmv_worker_events"
		}
	],
	// ──────────────────────────────────────────────────────────────────────────
	//  Workers Rate Limiting API: guard /api/card and /api/og from enumeration
	// ──────────────────────────────────────────────────────────────────────────
	// 100 req/min per IP is generous for real traffic but cuts naive enumeration
	// attacks before they hit L1. `namespace_id` is any arbitrary integer unique
	// to this worker — not the name of the KV namespace.
	//
	// NOTE: this is the stable top-level `ratelimits` array, not the old
	// `unsafe.bindings` form. Requires wrangler ≥ 4.36.0.
	// `period` MUST be 10 or 60 (seconds) — no other values are accepted.
	// Docs: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
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

Replace `<PASTE-PROD-ID-FROM-STEP-2>` and `<PASTE-PREVIEW-ID-FROM-STEP-2>` with the actual values from Step 2.

- [ ] **Step 4: Verify wrangler accepts the config**

Run:
```bash
pnpm wrangler deploy --dry-run
```
Expected: `Total Upload: ...`, exits 0, **no** warnings about unknown bindings. If it errors on `ratelimits` with "unknown key", you're on an older wrangler that still uses `unsafe.bindings` — upgrade wrangler to ≥ 4.36.0.

- [ ] **Step 5: Commit**

```bash
git add wrangler.jsonc
git commit -m "$(cat <<'EOF'
feat(cf): add Analytics Engine, Rate Limiter, and KV bindings

Prep for CF-native hardening: telemetry via Analytics Engine, per-IP
enumeration guard via Workers Rate Limiting, and a KV cache layer in
front of the /badge/* Supabase proxy. Bindings only — no handler
changes yet.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: HEAD method support + 304 conditional responses on /api/card and /api/og

**Files:**
- Modify: `worker/index.ts` (around the `handleRender` function, lines ~225-376, and `handleCard`/`handleOg` wrappers around line 408)

Current behavior: `handleRender` accepts any method (no explicit allow-list) and sets `ETag` on L2 hits and L1 promotions but never honors `If-None-Match`. Fix both.

- [ ] **Step 1: Add a method guard and HEAD-aware body stripping helper**

In `worker/index.ts`, find the block just above `handleRender` (around line 216, right after `renderViaContainer`). Add this helper:

```ts
// Strip the response body for HEAD requests while preserving status and
// headers. Used by handleRender so the HEAD path exercises the same cache
// lookups + headers as GET without shipping the PNG bytes.
function stripBodyForHead(response: Response, method: string): Response {
  if (method !== 'HEAD') return response;
  return new Response(null, {
    status: response.status,
    headers: response.headers,
  });
}
```

- [ ] **Step 2: Add a method guard at the top of `handleRender`**

In `handleRender` (starts around line 225), immediately after the opening brace and before `const url = new URL(request.url);`, insert:

```ts
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
  const ifNoneMatch = request.headers.get('if-none-match');
```

- [ ] **Step 3: Honor `If-None-Match` on the L1 hit path**

Replace the current L1 hit block in `handleRender` (roughly lines 283-297) with:

```ts
  // 1. L1 lookup — the hot path. Serves from in-region edge cache when warm.
  try {
    const l1Hit = await caches.default.match(l1Key);
    if (l1Hit) {
      const l1Etag = l1Hit.headers.get('etag');
      // Conditional request: if the client's If-None-Match matches the cached
      // ETag, return 304 with no body (saves egress on repeat visits).
      if (l1Etag && ifNoneMatch === l1Etag) {
        return new Response(null, {
          status: 304,
          headers: {
            'X-Cache': 'L1-HIT',
            'X-Cache-Key': key,
            ETag: l1Etag,
            // Fallback to the canonical cache profile rather than an empty
            // string — some intermediaries reject or treat empty
            // Cache-Control as no-cache.
            'Cache-Control':
              l1Hit.headers.get('cache-control') ??
              'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
          },
        });
      }
      const headers = new Headers(l1Hit.headers);
      headers.set('X-Cache', 'L1-HIT');
      headers.set('X-Cache-Key', key);
      return stripBodyForHead(
        new Response(l1Hit.body, { status: l1Hit.status, headers }),
        method,
      );
    }
  } catch (err) {
    console.error('[L1] caches.default.match failed', { key, err });
  }
```

- [ ] **Step 4: Honor `If-None-Match` on the L2 hit path**

Replace the L2 hit block (roughly lines 299-325) with:

```ts
  // 2. L2 lookup — R2 cross-region cache.
  const cached = await env.CARD_CACHE.get(key);
  if (cached) {
    // Conditional request short-circuit: no need to materialise the body if
    // the client already has this ETag. Note: we do NOT promote this entry
    // into L1 on the 304 path because we skipped arrayBuffer() and don't
    // have the bytes to store. The next full-body miss will promote.
    if (ifNoneMatch && ifNoneMatch === cached.httpEtag) {
      return new Response(null, {
        status: 304,
        headers: {
          'X-Cache': 'L2-HIT',
          'X-Cache-Key': key,
          ETag: cached.httpEtag,
          'Cache-Control':
            'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        },
      });
    }
    const bodyBuffer = await cached.arrayBuffer();
    const responseHeaders = {
      'Content-Type': 'image/png',
      'Cache-Control':
        'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
      'X-Cache': 'L2-HIT',
      'X-Cache-Key': key,
      ETag: cached.httpEtag,
      'Content-Length': String(cached.size),
    } as const;
    ctx.waitUntil(putL1(l1Key, bodyBuffer, cached.httpEtag, key));
    return stripBodyForHead(
      new Response(bodyBuffer, { status: 200, headers: responseHeaders }),
      method,
    );
  }
```

- [ ] **Step 5: Wrap the miss-path response with `stripBodyForHead` and generate a synthetic ETag**

At the end of `handleRender`, find the final `return new Response(buffer, ...)` (around line 367-375). Change it to:

```ts
  // Synthetic ETag so the L1-HIT-after-this-miss path can honor
  // If-None-Match. Cards are deterministic from (key, CACHE_VERSION), so
  // the key itself is a stable identifier. We wrap it in quotes per
  // RFC 7232 §2.3 strong-etag format.
  const missEtag = `"${key}"`;
  return stripBodyForHead(
    new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control':
          'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'X-Cache': 'MISS',
        'X-Cache-Key': key,
        'Content-Length': String(buffer.byteLength),
        ETag: missEtag,
      },
    }),
    method,
  );
```

Note the added `Content-Length` header AND `ETag` on the miss path — both were missing (flagged by the audit). The synthetic ETag makes the L1 304 path actually fire on subsequent conditional requests against freshly-rendered cards.

**Also update the two `ctx.waitUntil(putL1(...))` calls** in `handleRender` (the L2-hit path and the miss path) so L1 stores the ETag. On the L2-hit path, `putL1` is already called with `cached.httpEtag` — leave it alone. On the miss path, change:

```ts
  ctx.waitUntil(putL1(l1Key, buffer, undefined, key));
```

to:

```ts
  ctx.waitUntil(putL1(l1Key, buffer, missEtag, key));
```

- [ ] **Step 6: Smoke test**

Run in one terminal:
```bash
pnpm cf:dev
```
In another:
```bash
# GET — should return 200 with body, X-Cache: MISS on first, L1-HIT on second
curl -i http://localhost:8787/api/og?name=smoketest
curl -i http://localhost:8787/api/og?name=smoketest

# HEAD — should return 200 with headers only (empty body)
curl -I http://localhost:8787/api/og?name=smoketest

# 304 — capture ETag from the GET, resend with If-None-Match
ETAG=$(curl -sI http://localhost:8787/api/og?name=smoketest | awk -F': ' '/^etag/i {print $2}' | tr -d '\r')
curl -i -H "If-None-Match: $ETAG" http://localhost:8787/api/og?name=smoketest

# Method not allowed — POST should return 405 with Allow header
curl -i -X POST http://localhost:8787/api/og?name=smoketest
```
Expected:
- First GET: `HTTP/1.1 200`, `X-Cache: MISS`, `Content-Length: <nonzero>`.
- Second GET: `HTTP/1.1 200`, `X-Cache: L1-HIT`.
- HEAD: `HTTP/1.1 200`, headers present, empty body.
- Conditional GET: `HTTP/1.1 304 Not Modified`, `X-Cache: L1-HIT`, no body.
- POST: `HTTP/1.1 405 Method Not Allowed`, `Allow: GET, HEAD`.

If anything is off, fix before committing.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): support HEAD and 304 on /api/card + /api/og

L1 and L2 hit paths now honor If-None-Match and return 304 when the
client already has the cached ETag. HEAD method flows through the same
cache lookups but strips the PNG body. Adds explicit 405 on other
methods. Miss path now emits Content-Length.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: `Vary: User-Agent` on the `/c/:id/:name` crawler permalink

**Files:**
- Modify: `worker/index.ts` (`handlePermalink`, around lines 428-549)

The permalink handler branches on `User-Agent` to return different HTML (crawler gets meta-injected HTML; human gets the unchanged SPA shell). Cache-Control is set but without `Vary: User-Agent`, the edge cache could cross-contaminate the two variants.

- [ ] **Step 1: Add `Vary: User-Agent` to the human branch**

Find the human-UA return in `handlePermalink` (around lines 466-478):

```ts
  if (!CRAWLER_UA.test(ua)) {
    return new Response(indexResp.body, {
      status: indexResp.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
      },
    });
  }
```

Replace it with:

```ts
  if (!CRAWLER_UA.test(ua)) {
    return new Response(indexResp.body, {
      status: indexResp.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
        // Prevents the edge from serving a cached crawler variant to a human
        // (or vice versa) since the two branches return different bodies.
        Vary: 'User-Agent',
      },
    });
  }
```

- [ ] **Step 2: Add `Vary: User-Agent` to the crawler branch**

Find the crawler return at the end of `handlePermalink` (around lines 540-548):

```ts
  const transformed = rewriter.transform(indexResp);
  return new Response(transformed.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'X-Permalink-Mode': 'crawler',
    },
  });
```

Replace with:

```ts
  const transformed = rewriter.transform(indexResp);
  return new Response(transformed.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'X-Permalink-Mode': 'crawler',
      Vary: 'User-Agent',
    },
  });
```

- [ ] **Step 3: Smoke test**

```bash
pnpm cf:dev
# Human UA — should return SPA shell, Vary: User-Agent header present
curl -is http://localhost:8787/c/CERT-TEST/alice | grep -iE '^(vary|x-permalink-mode)'
# Crawler UA — should return modified HTML with injected meta
curl -is -A 'Twitterbot/1.0' http://localhost:8787/c/CERT-TEST/alice | grep -iE '^(vary|x-permalink-mode)'
```
Expected:
- Human: `Vary: User-Agent` present, no `X-Permalink-Mode`.
- Crawler: `Vary: User-Agent` present, `X-Permalink-Mode: crawler`.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
fix(worker): add Vary: User-Agent on /c/:id/:name permalink branches

The handler returns different HTML depending on whether the UA is a
crawler. Without Vary, the edge cache could serve a cached crawler
variant to a human (or vice versa). One header line, closes the gap.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Emit Analytics Engine events for cache tiers, badge proxy, and prewarm

**Files:**
- Modify: `worker/index.ts` (Env interface, `handleRender`, `handleBadge`, `scheduled`)

Replaces ad-hoc `console.log` diagnostics with structured events queryable via the Analytics Engine dashboard. Schema is one dataset (`dmv_worker_events`) with a `category` blob that separates cache / badge / prewarm events. Analytics Engine is GA; the dataset is auto-created on first write.

**Verified limits** (source: [Analytics Engine limits](https://developers.cloudflare.com/analytics/analytics-engine/limits/)):
- `indexes`: **exactly 1 entry** (array form is forward-looking, but only 1 is allowed today)
- Each index value: max **96 bytes**
- `blobs`: max **20 entries**, total payload max **16 KB**
- `doubles`: max **20 entries**
- Max **250 `writeDataPoint` calls per Worker invocation**
- Retention: **3 months**

Event schema (documented inline at the first writeDataPoint call):
- `indexes[0]`: shard key — use `category` so per-category queries are fast (ONE entry only)
- `blobs[0]`: category (`"render"`, `"badge"`, `"prewarm"`, `"error"`)
- `blobs[1]`: tier (`"L1-HIT"`, `"L2-HIT"`, `"MISS"`, `"304"`, `"KV-HIT"`, `"SUPABASE"`, `"ERROR"`)
- `blobs[2]`: path (`"/api/card"`, `"/api/og"`, `"/badge/..."`)
- `blobs[3]`: cache_key or upstream_path
- `doubles[0]`: latency_ms (full handler time)
- `doubles[1]`: body_size_bytes (0 on 304)

- [ ] **Step 1: Add `ANALYTICS` to the `Env` interface**

Find the `Env` interface (around line 46-60) and add one field:

```ts
interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  ASSETS: Fetcher;
  PREWARM_ORIGIN: string;
  // Analytics Engine dataset for structured cache/render/proxy metrics.
  // Schema: see emitAnalytics() below. Bound in wrangler.jsonc as
  // analytics_engine_datasets.
  ANALYTICS: AnalyticsEngineDataset;
}
```

- [ ] **Step 2: Add the `emitAnalytics` helper**

Just below the `Env` interface (around line 61), add:

```ts
// Structured telemetry for cache tiers, badge proxy, and prewarm runs.
// Emitting is fire-and-forget — writeDataPoint does not need await and
// failures must never break the user-facing response. See wrangler.jsonc
// `analytics_engine_datasets` for the dataset binding.
//
// Schema:
//   indexes[0] = category (render | badge | prewarm | error)
//   blobs[0]   = category
//   blobs[1]   = tier/status (L1-HIT, L2-HIT, MISS, 304, KV-HIT, SUPABASE, ERROR)
//   blobs[2]   = path (/api/card, /api/og, /badge/*)
//   blobs[3]   = cache_key or upstream_path (for debugging outliers)
//   doubles[0] = latency_ms
//   doubles[1] = body_size_bytes (0 on 304 / HEAD)
interface AnalyticsEvent {
  category: 'render' | 'badge' | 'prewarm' | 'error';
  tier: string;
  path: string;
  key: string;
  latencyMs: number;
  sizeBytes: number;
}

function emitAnalytics(env: Env, ev: AnalyticsEvent): void {
  try {
    env.ANALYTICS.writeDataPoint({
      indexes: [ev.category],
      blobs: [ev.category, ev.tier, ev.path, ev.key],
      doubles: [ev.latencyMs, ev.sizeBytes],
    });
  } catch (err) {
    console.error('[analytics] writeDataPoint failed', err);
  }
}
```

- [ ] **Step 3: Instrument `handleRender` with timing + analytics**

At the top of `handleRender` (just after the method guard you added in Task 2), capture the start time:

```ts
  const startedAt = Date.now();
  const path = url.pathname; // captured for analytics
```

Then add an `emitAnalytics` call on each return path. For the **L1 304** return:

```ts
      if (l1Etag && ifNoneMatch === l1Etag) {
        emitAnalytics(env, {
          category: 'render',
          tier: '304',
          path,
          key,
          latencyMs: Date.now() - startedAt,
          sizeBytes: 0,
        });
        return new Response(null, { /* ... */ });
      }
```

For the **L1 hit** (200) return, add just before the `return stripBodyForHead(...)`:

```ts
      emitAnalytics(env, {
        category: 'render',
        tier: 'L1-HIT',
        path,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: Number(l1Hit.headers.get('content-length') ?? 0),
      });
```

For the **L2 304** return, similarly add before the `return new Response(null, ...)`:

```ts
      emitAnalytics(env, {
        category: 'render',
        tier: '304',
        path,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
```

For the **L2 hit** (200) return, add before the final `return stripBodyForHead(...)`:

```ts
    emitAnalytics(env, {
      category: 'render',
      tier: 'L2-HIT',
      path,
      key,
      latencyMs: Date.now() - startedAt,
      sizeBytes: cached.size,
    });
```

For the **miss** path (after the container render succeeds), add before the final `return stripBodyForHead(new Response(buffer, ...))`:

```ts
  emitAnalytics(env, {
    category: 'render',
    tier: 'MISS',
    path,
    key,
    latencyMs: Date.now() - startedAt,
    sizeBytes: buffer.byteLength,
  });
```

For the **container error** path (`if (!containerResponse.ok)`), add before the error `return`:

```ts
    emitAnalytics(env, {
      category: 'error',
      tier: `container-${containerResponse.status}`,
      path,
      key,
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
```

- [ ] **Step 4: Leave `handleBadge` alone for this task**

`handleBadge` is being fully rewritten in Task 6 (KV cache). Instrumenting it here and then overwriting it in Task 6 would create a confusing intermediate commit that bisects poorly. The badge analytics emission is folded into the Task 6 rewrite instead. Skip any edits to `handleBadge` in this task.

- [ ] **Step 5: Instrument the cron prewarm**

In the `scheduled()` handler (around line 718), inside the `for (const path of PREWARM_PATHS)` loop, after the existing `console.log` line (~line 749), add:

```ts
            emitAnalytics(env, {
              category: 'prewarm',
              tier: response.headers.get('x-cache') ?? 'UNKNOWN',
              path,
              key: response.headers.get('x-cache-key') ?? '',
              latencyMs: 0, // prewarm latency isn't meaningful (background)
              sizeBytes: 0,
            });
```

- [ ] **Step 6: Smoke test**

```bash
pnpm cf:dev
curl -s http://localhost:8787/api/og?name=smoketest > /dev/null
curl -s http://localhost:8787/api/og?name=smoketest > /dev/null
curl -s http://localhost:8787/api/og?name=smoketest > /dev/null
```
Expected: `wrangler dev` console shows no errors from `emitAnalytics`. In local dev, `env.ANALYTICS.writeDataPoint` is a no-op shim but it must not throw. On a deployed worker, `pnpm cf:tail` and the CF dashboard's "Analytics Engine" tab will show `dmv_worker_events` populating after ~60s.

- [ ] **Step 7: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): emit Analytics Engine events for render/badge/prewarm

Replaces ad-hoc console.log observability with structured events in a
single dataset (dmv_worker_events). Schema is documented at the
emitAnalytics helper. Instrumented: all handleRender return paths,
handleBadge upstream result, scheduled prewarm tier per path.
Fire-and-forget — write failures never break the response.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: Workers Rate Limiting on /api/card and /api/og

**Files:**
- Modify: `worker/index.ts` (`Env`, `handleRender`)

100 req/min per IP is generous for real visitors but stops enumeration and accidental thundering herds at the worker boundary — *before* the container gets invoked.

**Why Workers Rate Limiting API over WAF Rate Limiting Rules:** WAF rules on the Workers Paid plan (not Pro) are capped at 1 rule, IP-only counting, 10-second max period — cannot express "100 req/60s per IP". The Workers binding is GA, free, runs inside the worker, and lets us key by `${ip}:${pathname}`. If the zone ever upgrades to Pro, layering a WAF rule on top is complementary — WAF runs in an earlier phase and blocked requests don't even count as Worker invocations. (Source: [WAF rate limiting plan comparison](https://developers.cloudflare.com/waf/rate-limiting-rules/).)

- [ ] **Step 1: Add `API_RATE_LIMITER` to the `Env` interface**

Update the `Env` interface:

```ts
interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  ASSETS: Fetcher;
  PREWARM_ORIGIN: string;
  ANALYTICS: AnalyticsEngineDataset;
  // Workers Rate Limiting API binding. Configured in wrangler.jsonc under
  // the top-level `ratelimits` array. 100 req/60s per IP+path across /api/*.
  API_RATE_LIMITER: RateLimit;
}
```

If TypeScript complains about the `RateLimit` type, add this near the top of the file (after the import block, before `Env`):

```ts
// Ambient type for the Workers Rate Limiting API binding. Not exported by
// @cloudflare/workers-types at all versions; define locally.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
```

- [ ] **Step 2: Apply the rate limit at the top of `handleRender`**

In `handleRender`, immediately after the method guard and the `ifNoneMatch` line you added in Task 2, insert:

```ts
  // Rate limit BEFORE cache lookup: a flood of unique-key requests would
  // otherwise each do an L1 lookup + R2 GET + container fetch before we
  // noticed. Key is `${ip}:${pathname}` so /api/card and /api/og have
  // independent budgets per IP. Prewarm cron hits have no client IP (CF
  // doesn't set cf-connecting-ip on worker-internal fetches) and skip via
  // UA check anyway.
  const prewarmUa = 'dmv-cf-prewarm/1.0';
  const userAgent = request.headers.get('user-agent') ?? '';
  const clientIp = request.headers.get('cf-connecting-ip') ?? '';
  if (clientIp && userAgent !== prewarmUa) {
    try {
      const rlKey = `${clientIp}:${url.pathname}`;
      const { success } = await env.API_RATE_LIMITER.limit({ key: rlKey });
      if (!success) {
        emitAnalytics(env, {
          category: 'error',
          tier: 'RATE-LIMITED',
          path: url.pathname,
          key: rlKey,
          latencyMs: Date.now() - startedAt,
          sizeBytes: 0,
        });
        return new Response('Rate limit exceeded', {
          status: 429,
          headers: {
            'Retry-After': '60',
            'Content-Type': 'text/plain; charset=utf-8',
            'X-RateLimit-Limit': '100',
            'X-RateLimit-Window': '60',
          },
        });
      }
    } catch (err) {
      // Rate limiter failure should NEVER break responses — log and continue.
      console.error('[ratelimit] API_RATE_LIMITER.limit failed', err);
    }
  }
```

**Note:** this block must come AFTER `const startedAt = Date.now()` and `const path = url.pathname` from Task 4. Place it right after those two lines.

- [ ] **Step 3: Smoke test (local limits verify code-doesn't-throw ONLY)**

**Honesty check:** in local `wrangler dev`, `cf-connecting-ip` is NOT set on incoming requests (CF only sets it at the edge). Our gate `if (clientIp && userAgent !== prewarmUa)` SHORT-CIRCUITS before the limiter is even called when `clientIp` is empty. On top of that, the rate limiter itself runs in simulated mode locally. So the local smoke test exercises the block for syntax/type errors only — it does NOT verify real throttling behavior.

```bash
pnpm cf:dev
for i in 1 2 3; do curl -sI http://localhost:8787/api/og?name=rltest | head -1; done
```
Expected: three `HTTP/1.1 200 OK`. No errors in the `wrangler dev` console.

**Real throttling verification happens in Task 10 Step 6** (post-deploy), where `cf-connecting-ip` is populated and the limiter actually enforces. Do NOT consider this task "verified" until Task 10 Step 6 shows the expected 200/429 distribution in prod.

- [ ] **Step 4: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): rate-limit /api/card and /api/og at 100 req/min per IP

Uses the Workers Rate Limiting API binding added in the wrangler config
task. Check runs before cache lookups so enumeration attacks don't get
to eat L1/R2/container work. Prewarm cron bypasses via UA check.
429s emit an analytics error event. Limiter errors are swallowed so a
transient CF infra issue never breaks responses.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: KV cache in front of `/badge/*`

**Files:**
- Modify: `worker/index.ts` (`Env`, `handleBadge`)

Badge lookups currently round-trip to Supabase (~100ms) on every request. Add a 10-minute KV cache for identical paths/queries. Stale badges are fine (they're cosmetic status indicators).

- [ ] **Step 1: Add `BADGE_CACHE_KV` to the `Env` interface**

Update `Env`:

```ts
interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  ASSETS: Fetcher;
  PREWARM_ORIGIN: string;
  ANALYTICS: AnalyticsEngineDataset;
  API_RATE_LIMITER: RateLimit;
  // KV cache for /badge/* responses. 10 min TTL. Keyed by
  // `badge:${pathname}${search}`. Values are raw bytes with content-type
  // stored in the KV metadata.
  BADGE_CACHE_KV: KVNamespace;
}
```

- [ ] **Step 2: Add KV read-through + write-back to `handleBadge`**

Replace the body of `handleBadge` (around lines 586-641) with:

```ts
async function handleBadge(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const tail = url.pathname.slice('/badge'.length); // '' or '/...'

  // I-3: path traversal defense.
  if (tail.includes('..') || tail.includes('//')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const targetUrl = new URL(`${SUPABASE_FUNCTIONS_ORIGIN}/badge${tail}${url.search}`);
  if (!targetUrl.pathname.startsWith('/functions/v1/badge')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // KV cache key: pathname + search. GET only — non-GET (HEAD, etc.) bypass
  // so we don't serve a cached GET body to a HEAD request or similar.
  const kvKey = `badge:${url.pathname}${url.search}`;
  const cacheable = request.method === 'GET';

  if (cacheable) {
    try {
      const hit = await env.BADGE_CACHE_KV.getWithMetadata<{
        contentType: string;
        status: number;
      }>(kvKey, 'arrayBuffer');
      if (hit.value && hit.metadata) {
        emitAnalytics(env, {
          category: 'badge',
          tier: 'KV-HIT',
          path: url.pathname,
          key: tail || '/',
          latencyMs: Date.now() - startedAt,
          sizeBytes: hit.value.byteLength,
        });
        return new Response(hit.value, {
          status: hit.metadata.status,
          headers: {
            'Content-Type': hit.metadata.contentType,
            'X-Badge-Cache': 'KV-HIT',
            'Cache-Control': 'public, max-age=300, s-maxage=600',
          },
        });
      }
    } catch (err) {
      console.error('[badge] KV get failed', { kvKey, err });
    }
  }

  // MISS — forward to Supabase as before.
  const upstreamHeaders = new Headers();
  for (const name of BADGE_FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) upstreamHeaders.set('x-forwarded-for', clientIp);
  upstreamHeaders.set('x-forwarded-host', url.host);
  upstreamHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const upstream = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: request.body,
  });

  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!BADGE_RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });
  responseHeaders.set('X-Badge-Cache', 'MISS');

  // Buffer the body so we can both return it AND store it in KV. Badges are
  // small (~1-5 KB SVGs) so buffering is cheap.
  const buffer = cacheable && upstream.ok ? await upstream.arrayBuffer() : null;

  if (buffer && cacheable && upstream.ok) {
    // Fire-and-forget KV put. Failures log but never break the response.
    const contentType = upstream.headers.get('content-type') ?? 'image/svg+xml';
    const status = upstream.status;
    (async () => {
      try {
        await env.BADGE_CACHE_KV.put(kvKey, buffer, {
          expirationTtl: 600, // 10 minutes
          metadata: { contentType, status },
        });
      } catch (err) {
        console.error('[badge] KV put failed', { kvKey, err });
      }
    })();
  }

  emitAnalytics(env, {
    category: 'badge',
    tier: upstream.ok ? 'SUPABASE' : `SUPABASE-${upstream.status}`,
    path: url.pathname,
    key: tail || '/',
    latencyMs: Date.now() - startedAt,
    sizeBytes: buffer ? buffer.byteLength : 0,
  });

  return new Response(buffer ?? upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}
```

*(Note: this fully replaces the previous `handleBadge`. Task 4 deliberately did NOT instrument `handleBadge` — the badge analytics emission is part of this rewrite. The dispatch site update is in the next step.)*

- [ ] **Step 3: Update the dispatch site in `fetch` to pass `env`**

Find the dispatch site in the main `fetch` handler (around line 678):

```ts
    if (url.pathname.startsWith('/badge/') || url.pathname === '/badge') {
      return handleBadge(request);
    }
```

Change to:

```ts
    if (url.pathname.startsWith('/badge/') || url.pathname === '/badge') {
      return handleBadge(request, env);
    }
```

- [ ] **Step 4: Smoke test**

```bash
pnpm cf:dev
# First hit — MISS, talks to Supabase
curl -sI 'http://localhost:8787/badge/v1/by-cert/NONEXISTENT.svg' | grep -i 'x-badge-cache'
# Second hit — KV-HIT
curl -sI 'http://localhost:8787/badge/v1/by-cert/NONEXISTENT.svg' | grep -i 'x-badge-cache'
# Path traversal — 404
curl -sI 'http://localhost:8787/badge/..%2Fadmin' | head -1
```
Expected:
- First: `x-badge-cache: MISS`
- Second: `x-badge-cache: KV-HIT`
- Traversal: `HTTP/1.1 404 Not Found`

In local dev KV is simulated in `.wrangler/state` — the second hit should work without internet.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): add 10min KV cache in front of /badge/* proxy

Badge SVGs are deterministic per cert ID. A 10-minute KV layer cuts
Supabase edge function invocations ~10x during peak, trades a few
minutes of badge staleness for edge-local reads. Only GETs are
cacheable. KV failures fall through to the Supabase path. Content-type
and HTTP status are stored in KV metadata. Analytics KV-HIT events
added for observability.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: In-process L3 request coalescing

**Files:**
- Modify: `worker/index.ts` (module scope + `handleRender` miss path)

The "known gap" in CLOUDFLARE.md. When a viral card hits an already-cold edge, concurrent first-misses each call the container independently and eat its latency in parallel. Fix by maintaining a module-level `Map<cacheKey, Promise<ArrayBuffer>>`: the first miss creates the promise; concurrent requests within the same isolate await it; everyone gets the same bytes; cache writes happen once.

**Is this task needed — can't CF just do this for us?** No. CF's cache-lock / request-collapsing only applies to the standard CDN path via `fetch()` with `cf.cacheEverything`, **not** to explicit `caches.default.match` / `caches.default.put` from a Worker. The Workers Cache API docs make no mention of coalescing, and the expensive work here (R2 + container render) happens inside the Worker downstream of the Cache API miss, where CDN-level collapsing cannot reach. (Sources: [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), [Default cache behavior](https://developers.cloudflare.com/cache/concepts/default-cache-behavior/).) The in-isolate Map is the correct dedupe layer for this topology.

**Scope honesty:** this coalesces within a single Worker isolate only. A PoP may have multiple isolates, and CF may run multiple PoPs for DMV. This is not a global semaphore. But it cuts the worst-case thundering-herd factor from "N concurrent container calls" to "at most one per isolate", which in practice is a ~10x improvement for the Brave takeover shape.

- [ ] **Step 1: Add the in-flight map at module scope**

Near the top of `worker/index.ts`, after the `CRAWLER_UA` regex (around line 90), add:

```ts
// In-flight request coalescing for the container render path.
//
// Module-level Map keyed by the same cacheKey() used for L1/R2. When a
// thundering herd of concurrent first-misses arrives on a fresh URL, the
// first request kicks off the container render and stores the in-flight
// promise here; concurrent requests within the same Worker isolate await
// that promise instead of each calling the container independently. On
// settle (success or error) the entry is removed so a later miss can
// re-render if needed.
//
// Scope: single isolate only. CF may run multiple isolates per PoP and
// multiple PoPs globally, so this is NOT a global semaphore — it's a
// per-isolate dedupe that bounds the worst-case N-way container fan-out
// to "at most one per isolate" instead of "one per request". For the
// Brave takeover shape (small hot set, high RPS) this is a measurable
// win. A global coordinator would live in a Durable Object; see
// CLOUDFLARE.md known-gaps for the tradeoff discussion.
//
// Important: the Map holds Promises of the raw PNG ArrayBuffer, not
// Response objects. Responses are single-use (body stream consumed on
// first read), so multiple awaiters cannot share a Response. ArrayBuffer
// is structurally shareable.
const inflightRenders = new Map<string, Promise<ArrayBuffer>>();
```

- [ ] **Step 2: Route the miss path through the in-flight map**

In `handleRender`, find the miss path — the block starting with `// 3. Both caches miss — invoke container.` (around line 327). Replace the block from there through the final `return stripBodyForHead(...)` (the miss return) with:

```ts
  // 3. Both caches miss — invoke container, coalescing concurrent first-misses.
  let buffer: ArrayBuffer;
  const existing = inflightRenders.get(key);
  if (existing) {
    // Another request in this isolate is already rendering this card —
    // await its result. Saves a duplicate container call.
    try {
      buffer = await existing;
    } catch (err) {
      // The in-flight promise rejected (container was broken, OOM, etc.).
      // FAIL FAST: do NOT re-render. If the container just failed, kicking
      // off a second render against the same broken container amplifies the
      // thundering herd that coalescing was supposed to prevent. Let all
      // awaiters of this rejected batch return 502; the next fresh request
      // AFTER this Map entry has been cleared (by the primary owner's
      // finally block below) will create a new inflight entry and may
      // succeed — but we don't race it from inside the awaiter branch.
      emitAnalytics(env, {
        category: 'error',
        tier: 'inflight-rejected',
        path: url.pathname,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Render failed (coalesced): ${msg}`, {
        status: 502,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Source': 'container-coalesced',
        },
      });
    }
  } else {
    // We are the primary owner of this render. Set the promise on the Map
    // BEFORE awaiting so concurrent requests in this isolate can find it.
    // Use try/finally to guarantee the Map entry is removed on both success
    // and failure — otherwise a permanent "stuck" entry could poison the
    // slot for the rest of the isolate's lifetime.
    const freshPromise = renderAndBuffer(env, params);
    inflightRenders.set(key, freshPromise);
    try {
      buffer = await freshPromise;
    } catch (err) {
      emitAnalytics(env, {
        category: 'error',
        tier: 'container-render-failed',
        path: url.pathname,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      const msg = err instanceof Error ? err.message : String(err);
      return new Response(`Render failed: ${msg}`, {
        status: 502,
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'X-Source': 'container',
        },
      });
    } finally {
      inflightRenders.delete(key);
    }
  }

  // 4. Write to BOTH cache tiers in the background. Multiple awaiters of the
  // same in-flight promise each hit this block — that's fine: caches.default
  // and R2 both tolerate redundant puts for the same key. We could dedupe
  // with another flag but the cost of the redundant puts is far less than
  // the code complexity.
  ctx.waitUntil(
    (async () => {
      try {
        await env.CARD_CACHE.put(key, buffer, {
          httpMetadata: { contentType: 'image/png' },
        });
      } catch (err) {
        console.error('[CARD_CACHE] R2 put failed', { key, err });
      }
    })(),
  );
  ctx.waitUntil(putL1(l1Key, buffer, undefined, key));

  emitAnalytics(env, {
    category: 'render',
    tier: 'MISS',
    path: url.pathname,
    key,
    latencyMs: Date.now() - startedAt,
    sizeBytes: buffer.byteLength,
  });

  return stripBodyForHead(
    new Response(buffer, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control':
          'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'X-Cache': 'MISS',
        'X-Cache-Key': key,
        'Content-Length': String(buffer.byteLength),
      },
    }),
    method,
  );
```

- [ ] **Step 3: Add the `renderAndBuffer` helper**

Right after the `renderViaContainer` function (around line 213), add:

```ts
// Helper used by the coalescing miss path. Calls the container and buffers
// the result into an ArrayBuffer so it can be shared across multiple
// awaiters of the same in-flight promise. Throws on non-ok upstream.
async function renderAndBuffer(env: Env, params: RenderParams): Promise<ArrayBuffer> {
  const response = await renderViaContainer(env, params);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `container render ${response.status}: ${body.slice(0, 200)}`,
    );
  }
  return response.arrayBuffer();
}
```

Because the error handling moved into `renderAndBuffer`, **delete** the original miss-path error handler that referenced `containerResponse` (the block that looked like `if (!containerResponse.ok) { ... return new Response(body, { status: containerResponse.status, ... }); }`). The new block above handles errors via the thrown Error.

- [ ] **Step 4: Smoke test**

Coalescing is hard to exercise with curl alone. Two options:

```bash
pnpm cf:dev
# Spam 20 concurrent misses on a FRESH key — they should all succeed and
# all return X-Cache: MISS the first time, then L1-HIT after.
KEY="coalesce$(date +%s)"
for i in {1..20}; do
  curl -sI "http://localhost:8787/api/og?name=$KEY" &
done | grep -c '^HTTP'
wait
# All 20 should have succeeded (exit 0, no connection errors).

# Follow-up: second wave should all be L1-HIT.
for i in {1..5}; do
  curl -sI "http://localhost:8787/api/og?name=$KEY" | grep -i x-cache
done
```
Expected:
- All 20 concurrent requests succeed.
- Follow-up wave shows `x-cache: L1-HIT` on every line.

In prod `wrangler tail`, during launch you should see fewer MISS log lines than concurrent client requests for hot keys. Count MISS-vs-L1-HIT ratio as a health signal.

- [ ] **Step 5: Commit**

```bash
git add worker/index.ts
git commit -m "$(cat <<'EOF'
feat(worker): in-process L3 request coalescing for container renders

Closes the 'known gap' from CLOUDFLARE.md: concurrent first-misses on
a fresh card no longer each call the container. A module-level
Map<cacheKey, Promise<ArrayBuffer>> lets the first request drive the
render and concurrent awaiters share the buffer. Scope is per-isolate,
not global — documented at the map definition. Error paths clean up
the map entry so a transient failure doesn't poison the cache slot.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: CSP + Early Hints in `public/_headers`

**Files:**
- Modify: `public/_headers`
- Dashboard: zone-level Early Hints toggle (one-time)

*This task is independent of `worker/index.ts` and can run in parallel with Tasks 2-7.*

Two additions: a Content-Security-Policy header for the shell, and `Link: rel=preload` headers on `/` and `/index.html` which Cloudflare automatically converts to HTTP 103 Early Hints (provided the zone toggle is ON — which it is **off** by default). This cuts LCP on cold edge hits.

**Research-verified prerequisites for the CSP:**
- `'wasm-unsafe-eval'` MUST be in `script-src` — the Three.js DRACOLoader instantiates a Draco WebAssembly module, and WASM compilation requires this directive under any `script-src`. (Source: [WebAssembly CSP proposal](https://github.com/WebAssembly/content-security-policy/blob/main/proposals/CSP.md).)
- `worker-src 'self' blob:` — DRACOLoader source at `three/addons/loaders/DRACOLoader.js` builds its decoder Worker from `URL.createObjectURL(new Blob([…]))`, so the page must allow `blob:` workers.
- Draco decoder files live at `https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/` (verified by `grep setDecoderPath js/TV.js`) — jsdelivr is already in `script-src`/`connect-src`, no extra origin needed.
- Three.js core r152: CSP-clean, no `eval`/`Function()`.
- GSAP 3.12 + ScrollTrigger: no documented CSP issues in core/ScrollTrigger. (SplitText has inline-style issues but the project doesn't use SplitText.)

**Pre-check:** the preload Link headers reference the current `?v=N` query-string versions used in `index.html`. These change over time. Before editing `_headers`, **read the actual current versions**, confirm the Draco decoder origin, AND compute the SHA-256 hash of the inline `<script type="importmap">` block:

- [ ] **Step 1: Read current cache-bust versions, Draco origin, and importmap hash**

Run:
```bash
grep -oE '(app\.js|TV\.js|styles\.css)\?v=[0-9]+' index.html | sort -u
```
Expected: lines like `app.js?v=31`, `styles.css?v=29`, etc. **Note the exact versions** — you'll paste them into the Link headers in Step 3.

Confirm the Draco decoder origin:
```bash
grep -n 'setDecoderPath' js/TV.js
```
Expected: `js/TV.js:144:    this.dracoLoader.setDecoderPath('https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/');`

If the origin is **not** jsdelivr (someone migrated to self-hosted or gstatic), stop and adjust the CSP in Step 2 before proceeding — you'll need to add that origin to `script-src` AND `connect-src`.

Also list the current module entrypoint(s) the SPA actually loads in `<head>` or just before `</body>`:
```bash
grep -nE '<script|<link' index.html | head -40
```

**Crucial: compute the SHA-256 hash of the inline `<script type="importmap">` block.** `index.html` contains an inline importmap (lines ~200-207) that maps `three` and `three/addons/` to jsdelivr URLs. Under the CSP being added in Step 2, inline scripts are blocked by default. Unless we either (a) add `'unsafe-inline'` to `script-src` (bad — defeats half the point of CSP) or (b) add a `'sha256-<hash>'` directive, the importmap will fail to parse and the entire module graph breaks. We're going with the hash.

Compute the hash:
```bash
node -e "
const fs=require('fs'),crypto=require('crypto');
const html=fs.readFileSync('index.html','utf8');
const m=html.match(/<script type=\"importmap\">([\s\S]*?)<\/script>/);
if(!m){console.error('importmap not found');process.exit(1);}
const hash=crypto.createHash('sha256').update(m[1]).digest('base64');
console.log('sha256-'+hash);
"
```
Expected output as of 2026-04-07: `sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=`

**If the output differs** (someone has edited the importmap — even whitespace changes invalidate the hash), use YOUR computed value in Step 2 below. **Do not paste the 2026-04-07 value if the importmap has drifted** — the CSP will still block it.

Write down the computed hash. You'll paste it into `script-src` in Step 2.

- [ ] **Step 2: Add the CSP header**

Open `public/_headers` and update the `/*` block (lines 6-10). Replace the existing block:

```
# ─── Security headers (apply to everything) ───
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Referrer-Policy: strict-origin-when-cross-origin
```

with:

```
# ─── Security headers (apply to everything) ───
/*
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Strict-Transport-Security: max-age=31536000; includeSubDomains
  Referrer-Policy: strict-origin-when-cross-origin
  Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self' https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'
```

**Substitute `sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=` with the value you computed in Step 1 if it differed.**

*Rationale for each directive:*
- `script-src 'self' 'sha256-…' 'wasm-unsafe-eval' https://cdn.jsdelivr.net` — `'self'` covers `/js/app.js?v=…`, the `sha256-` hash allows the inline `<script type="importmap">` block, `'wasm-unsafe-eval'` is required for DRACOLoader's WebAssembly instantiation (WebAssembly CSP proposal), and jsdelivr covers Three.js modules + GSAP script tags + Draco decoder wrapper.
- `worker-src 'self' blob:` — DRACOLoader spawns its decoder Worker from a `blob:` URL built via `URL.createObjectURL`. Without this, the Draco decoder fails and the TV GLTF never loads.
- `style-src 'self' 'unsafe-inline'` — present for inline `style=""` attributes set by GSAP. (Note: `element.style.foo = '...'` assignments are NOT blocked by CSP, but inline `style=""` on elements in the HTML is, and third-party libs sometimes rely on them.)
- `connect-src` — includes the Supabase functions origin (`tcymqfwwphacnosnnzxl.supabase.co`) so `js/supabase.js` POSTs continue to work, the DMV origin for same-origin API fetches, and jsdelivr so DRACOLoader can fetch the `.wasm` file (fetch is in `connect-src`, not `script-src`).
- `frame-ancestors 'none'` + `X-Frame-Options: DENY` — defense-in-depth against clickjacking.

- [ ] **Step 3: Add Early Hints Link headers on `/` and `/index.html`**

In `public/_headers`, find the blocks for `/` and `/index.html` (around lines 13-17). Replace both with:

```
/
  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
  Link: </css/styles.css?v=29>; rel=preload; as=style
  Link: </js/app.js?v=31>; rel=preload; as=script; crossorigin
  Link: </fonts/PPSupplyMono-Regular.otf>; rel=preload; as=font; type=font/otf; crossorigin
  Link: <https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js>; rel=preload; as=script; crossorigin

/index.html
  Cache-Control: public, max-age=0, s-maxage=60, stale-while-revalidate=300
  Link: </css/styles.css?v=29>; rel=preload; as=style
  Link: </js/app.js?v=31>; rel=preload; as=script; crossorigin
  Link: </fonts/PPSupplyMono-Regular.otf>; rel=preload; as=font; type=font/otf; crossorigin
  Link: <https://cdn.jsdelivr.net/npm/three@0.152.2/build/three.module.js>; rel=preload; as=script; crossorigin
```

**IMPORTANT:** If Step 1 returned different `?v=N` versions than `29` / `31`, substitute them here. The versions must match whatever `index.html` is currently loading — otherwise the Early Hint preloads a file the browser never requests, wasting a round-trip.

- [ ] **Step 4: Enable Early Hints at the zone level (one-time)**

**Early Hints is OFF by default on Cloudflare zones.** Without this toggle, the `Link: rel=preload` headers you just added are still honored as normal response headers but are NOT promoted to HTTP 103 Early Hints — so you won't get the LCP win.

Steps (requires dashboard access to the Taqanu account → `agentcommunity.org` zone):

1. Go to https://dash.cloudflare.com → select `agentcommunity.org` zone.
2. Left nav: **Speed** → **Optimization** → **Content Optimization** tab.
3. Scroll to **Early Hints** card. Toggle it **On**.
4. Confirm the toggle persists.

Source: [Cloudflare Early Hints docs](https://developers.cloudflare.com/cache/advanced-configuration/early-hints/).

**Caveat:** the Early Hints docs are written against standard zones and Pages. Workers Static Assets responses go through the same edge HTTP pipeline, so the zone-level toggle DOES apply, but it's worth verifying with `curl --http2 -v https://dmv.agentcommunity.org/` after deploy and looking for a `HTTP/2 103` line in the verbose output.

**If you don't have dashboard access:** ask the user to do Steps 1-4 and confirm before proceeding. Do not try to flip the toggle via wrangler — Early Hints is a dashboard-only setting.

- [ ] **Step 5: Local smoke test**

```bash
pnpm cf:dev
curl -isD - http://localhost:8787/ | grep -iE '^(link|content-security-policy)'
```
Expected: CSP header present, four Link preload headers present.

Open http://localhost:8787/ in a browser, open DevTools → Console. **Watch for CSP violation errors.** If any appear:
- If they reference an inline script, add the specific `<script>` tag's hash or fix the CSP to include `'unsafe-inline'` for `script-src` (only as a last resort).
- If they reference a blocked CDN, add that origin to the CSP.
- If they reference a blocked `connect-src` for an API, add the origin.

Iterate until the browser console is clean.

- [ ] **Step 6: Verify the page still works end-to-end**

```bash
# Open in browser, verify:
# - TV scene renders (Three.js + GLB loaded)
# - CRT terminal animates (GSAP running)
# - Sound toggle works
# - Form submission works (if you have test creds)
open http://localhost:8787/
```
Expected: full visual fidelity, no blocked requests in the Network tab. **Pay special attention to the 3D TV scene loading** — if the Draco WASM or its `blob:` Worker is blocked by CSP, you'll see the TV GLTF fail to load with a console error like "Refused to compile WebAssembly" or "Refused to create a worker from 'blob:...'".

- [ ] **Step 7: Commit**

```bash
git add public/_headers
git commit -m "$(cat <<'EOF'
feat(cf): add CSP and Early Hints preloads to _headers

Content-Security-Policy locks script/style/connect/font origins to
self + known CDNs (jsdelivr, Supabase). Includes 'wasm-unsafe-eval'
and worker-src 'self' blob:' for the DRACOLoader WebAssembly + Worker
path. Link rel=preload headers on / and /index.html get auto-promoted
to HTTP 103 Early Hints by Cloudflare (zone toggle must be ON),
kicking off critical fetches (app.js, styles.css, PPSupplyMono,
Three.js) before the HTML arrives. ~100-200ms LCP win on cold edge
hits, meaningful at the Brave takeover scale.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: Rich `/healthz` response in the container + worker forwarding

**Files:**
- Modify: `container/server.mjs`
- Modify: `worker/index.ts` (`handleHealthz` — small forward tweak so the container's rich JSON is actually observable)

**Execution order:** because this task now also touches `worker/index.ts`, it must run AFTER Task 7 (the last worker/index.ts task), not in parallel with the worker chain. Task 8 (`public/_headers`) is still parallel-safe.

`/healthz` currently returns plain `"ok"`. Returning structured metadata (uptime, renderer version, Node version) lets the worker detect cold starts and makes the health probe actually diagnostic. The worker's current `handleHealthz` only forwards a boolean (`container: "ok"`) which hides the container JSON, so we forward the full payload too.

**⚠️ Side effect:** Any change to `container/server.mjs` bumps `CONTAINER_INSTANCE_ID` at the next build, which invalidates the entire R2 + L1 cache namespace. This is correct and expected (deterministic cache version), but *know it* — the first requests after deploy will be MISS until the caches warm again.

- [ ] **Step 1: Verify `CARD_VERSION` is exported from `card-renderer.js`**

Run:
```bash
grep -n 'CARD_VERSION' container/src/card-renderer.js
```
Expected: at least one line showing `export const CARD_VERSION = ...` or similar. If it exists, use it. If it doesn't, use `'unknown'` as a string literal in the healthz payload and leave a TODO comment.

- [ ] **Step 2: Update `container/server.mjs`**

Open `container/server.mjs`. Find the import block at the top (lines 13-22) and the `/healthz` route (line 33).

Replace the import block:

```js
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createCanvas,
  CardDNA,
  renderCard,
  CW,
  CH,
} from './src/card-renderer.js';
```

with (add `CARD_VERSION` to the import — if Step 1 showed it is NOT exported, leave the import as-is and use `'unknown'` below):

```js
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import {
  createCanvas,
  CardDNA,
  renderCard,
  CW,
  CH,
  CARD_VERSION,
} from './src/card-renderer.js';

// Capture boot time once so /healthz can report uptime for cold-start
// observability. Worker-side code correlates this with its own Date.now()
// to detect container restarts in the middle of a busy window.
const CONTAINER_BOOT_MS = Date.now();
```

Replace the healthz handler (line 33):

```js
app.get('/healthz', (c) => c.text('ok'));
```

with:

```js
app.get('/healthz', (c) =>
  c.json({
    status: 'ok',
    renderer_version: CARD_VERSION,
    node: process.version,
    uptime_ms: Date.now() - CONTAINER_BOOT_MS,
    boot_ms: CONTAINER_BOOT_MS,
  }),
);
```

*(If Step 1 showed `CARD_VERSION` is NOT exported, leave it imported without the new name and hard-code `renderer_version: 'unknown'` in the JSON response.)*

- [ ] **Step 3: Update `handleHealthz` to forward the container JSON**

Open `worker/index.ts` and find `handleHealthz` (around line 643-661):

```ts
async function handleHealthz(env: Env): Promise<Response> {
  try {
    const container = getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID);
    const containerResp = await container.fetch('http://container/healthz');
    return new Response(
      JSON.stringify({
        worker: 'ok',
        container: containerResp.ok ? 'ok' : `error ${containerResp.status}`,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ worker: 'ok', container: `error: ${(err as Error).message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
```

Replace with:

```ts
async function handleHealthz(env: Env): Promise<Response> {
  try {
    const container = getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID);
    const containerResp = await container.fetch('http://container/healthz');
    // Parse the container's JSON response and embed it so callers see
    // renderer_version / uptime_ms / node without needing direct container
    // access. On parse failure (e.g., container returned text), fall back
    // to the simple boolean signal.
    let containerPayload: unknown;
    try {
      containerPayload = containerResp.ok ? await containerResp.json() : null;
    } catch {
      containerPayload = null;
    }
    return new Response(
      JSON.stringify({
        worker: 'ok',
        container: containerResp.ok
          ? (containerPayload ?? 'ok')
          : `error ${containerResp.status}`,
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({ worker: 'ok', container: `error: ${(err as Error).message}` }),
      { status: 500, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
```

- [ ] **Step 4: Smoke test via the worker**

```bash
pnpm cf:dev
curl -s http://localhost:8787/healthz | python3 -m json.tool
```
Expected:
```json
{
  "worker": "ok",
  "container": {
    "status": "ok",
    "renderer_version": 2,
    "node": "v20.x.x",
    "uptime_ms": 123,
    "boot_ms": 1743000000000
  }
}
```

If the `container` field is still just `"ok"` (string), the worker's JSON forward failed — most likely because the container is returning text instead of JSON, or the DO fetch didn't parse. Check `wrangler dev` logs.

If Docker is available and you want to verify the container directly:
```bash
cd container && docker build -t dmv-card-renderer-test . && docker run --rm -p 8080:8080 dmv-card-renderer-test &
sleep 2
curl -s http://localhost:8080/healthz | python3 -m json.tool
kill %1 && cd ..
```

- [ ] **Step 5: Commit**

```bash
git add container/server.mjs worker/index.ts
git commit -m "$(cat <<'EOF'
feat(container): return rich JSON from /healthz and forward via worker

Container /healthz now reports renderer_version (CARD_VERSION), node
version, uptime_ms, and boot_ms. Worker's handleHealthz parses and
embeds the container payload instead of the old boolean summary, so
external probes can detect cold starts and version skew during deploy
windows. Bumps CONTAINER_INSTANCE_ID by design — the next deploy will
start with a cold R2+L1 cache namespace.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Final verification + deploy checklist

**Files:**
- None (verification only)

- [ ] **Step 1: Confirm all tasks landed**

```bash
git log --oneline main..HEAD
```
Expected: 9 new commits, one per Task 1-9, in order. (Task 10 is verification + deploy and produces no commit. Task 11 adds a 10th commit AFTER Task 10 Step 5 deploys to production.)

- [ ] **Step 2: Clean-tree sanity build**

```bash
pnpm cf:build
```
Expected: exits 0. Hard-fails if QR encoder drift is introduced (it shouldn't be — no QR files changed). Writes a fresh `worker/container-instance.ts` reflecting the Task 9 container change.

- [ ] **Step 3: Full local smoke**

```bash
pnpm cf:dev &
DEV_PID=$!
sleep 5

# /api/og hot path
curl -sI http://localhost:8787/api/og?name=finalcheck | grep -iE '^(x-cache|content-length|etag)'
curl -sI http://localhost:8787/api/og?name=finalcheck | grep -iE '^(x-cache|content-length|etag)'

# HEAD
curl -sI -I http://localhost:8787/api/og?name=finalcheck | head -5

# Permalink (human)
curl -sI http://localhost:8787/c/CERT-ABC/alice | grep -iE '^(vary|x-permalink-mode|cache-control)'

# Permalink (crawler)
curl -sI -A 'Twitterbot/1.0' http://localhost:8787/c/CERT-ABC/alice | grep -iE '^(vary|x-permalink-mode)'

# Badge KV
curl -sI http://localhost:8787/badge/v1/by-cert/FINALCHECK.svg | grep -i x-badge-cache
curl -sI http://localhost:8787/badge/v1/by-cert/FINALCHECK.svg | grep -i x-badge-cache

# Shell + CSP + Early Hints
curl -sI http://localhost:8787/ | grep -iE '^(content-security-policy|link)'

# Healthz
curl -s http://localhost:8787/healthz

kill $DEV_PID
```

Expected (in order):
- First og hit: `X-Cache: MISS`, `Content-Length: <nonzero>`, no `ETag` (miss path).
- Second og hit: `X-Cache: L1-HIT`, body bytes served from L1.
- HEAD: headers present, empty body.
- Permalink human: `Vary: User-Agent`, no `X-Permalink-Mode`.
- Permalink crawler: `Vary: User-Agent`, `X-Permalink-Mode: crawler`.
- First badge: `x-badge-cache: MISS`.
- Second badge: `x-badge-cache: KV-HIT`.
- Root: `Content-Security-Policy` present, 4x `Link: ... rel=preload` headers present.
- Healthz: `{"worker":"ok","container":"ok"}`.

If any check fails, stop and fix before deploy.

- [ ] **Step 4: Open the browser and verify visual fidelity**

```bash
pnpm cf:dev &
open http://localhost:8787/
```
Check DevTools Console: **no CSP violations**. Check Network tab: Early Hint preloads fired (you'll see `three.module.js` / `app.js` / `styles.css` / `PPSupplyMono-Regular.otf` starting early in the waterfall).

Verify:
- TV scene renders.
- CRT boots.
- Form accepts input through completion.
- Card appears at the end.

Stop `cf:dev` when done (`kill %1` or Ctrl-C).

- [ ] **Step 5: Deploy to production**

⚠️ **Before running this, coordinate with the user.** Deploy is production-impacting — first requests after deploy will be MISS until the cache warms (because the Task 9 container change bumped `CONTAINER_INSTANCE_ID`).

```bash
pnpm cf:deploy
```
Expected: `wrangler deploy` exits 0, prints the deployed URL, and the new worker version is live within ~30s.

- [ ] **Step 6: Post-deploy smoke**

```bash
# Real production URLs
curl -sI https://dmv.agentcommunity.org/api/og?name=dmv | grep -iE '^(x-cache|content-length)'
curl -sI https://dmv.agentcommunity.org/api/og?name=dmv | grep -iE '^(x-cache|content-length)'

# CSP + Link headers
curl -sI https://dmv.agentcommunity.org/ | grep -iE '^(content-security-policy|link)'

# Healthz
curl -s https://dmv.agentcommunity.org/healthz

# Rate limit (should see some 429s after ~100 requests).
# IMPORTANT: use a SINGLE name so all hits after the first are L1-HIT.
# Using unique names would burn 120 container renders and leave 120
# garbage R2 entries that survive until the next CONTAINER_INSTANCE_ID bump.
# The limiter keys on ${ip}:${pathname}, not on query params, so the limit
# is exercised regardless.
for i in {1..120}; do
  curl -so /dev/null -w '%{http_code}\n' "https://dmv.agentcommunity.org/api/og?name=rltest"
done | sort | uniq -c
```

Expected:
- First og hit: `X-Cache: MISS` (post-deploy cache is cold).
- Second og hit: `X-Cache: L1-HIT`.
- CSP + Link headers present on `/`.
- Healthz returns JSON.
- Rate-limit run: mostly `200`, some `429` near the tail.

- [ ] **Step 7: Watch `wrangler tail` for ~2 minutes of post-deploy sanity**

Run in a terminal:
```bash
pnpm cf:tail
```
For roughly 2 minutes of live traffic (or until you've seen ~20 request lines), look for:
- `X-Cache` values settling to `L1-HIT` after initial warmup.
- No recurring errors in coalescing, rate limiting, KV, or analytics.
- No unexpected 4xx/5xx.

Then Ctrl-C out. The hourly cron tick + prewarm verification can happen organically over the next hour — don't sit on the tail waiting for it.

If anything is unhealthy, roll back:
```bash
pnpm wrangler rollback
```

- [ ] **Step 8: Check Analytics Engine dashboard**

Open the Cloudflare dashboard → Workers → `dmv-agentcommunity` → Analytics Engine → `dmv_worker_events`. Within ~5 minutes of the first real traffic, events should populate. Sanity-check:
- `category = render` events dominate
- `tier` distribution: mostly `L1-HIT`, some `L2-HIT`, rare `MISS`
- `category = badge` events show `KV-HIT` vs `SUPABASE` ratio (ideally KV-HIT climbing over time)
- `category = prewarm` events appear once per cron tick

- [ ] **Step 9: Final commit**

No code changes, but mark the plan as landed:

```bash
# Nothing to commit — verification only. Skip this step.
echo "Plan complete. All tasks landed in commits on this branch."
```

---

### Task 11: Update architecture docs to match the new reality

**Files:**
- Modify: `CLOUDFLARE.md` (Operational notes section, Known gaps section)
- Modify: `ARCHITECTURE.md` (Rate limiting section)

*Runs AFTER Task 10 deploys to production.* Do not land doc updates before the code is live — the docs should describe what's actually in production, not aspirational state.

`CLAUDE.md` already links to `CLOUDFLARE.md` (line near "Cloudflare Workers Static Assets") as the CF source of truth, so updating `CLOUDFLARE.md` automatically surfaces the new features in the Claude context on next load. No `CLAUDE.md` edit is needed.

- [ ] **Step 1: Update `CLOUDFLARE.md` → Operational notes**

Find the existing `- **Observability**:` bullet (around line 196). Replace it with an expanded version:

```markdown
- **Observability**: `observability.enabled = true` in `wrangler.jsonc`. Use
  `pnpm cf:tail` to stream live logs. Every cache-tier response carries
  `X-Cache: L1-HIT | L2-HIT | MISS | 304` and `X-Cache-Key` for
  point-in-time debugging. Rate-limited responses emit `X-RateLimit-Limit`
  + `X-RateLimit-Window`. Badge KV responses emit `X-Badge-Cache: KV-HIT |
  MISS`. For structured aggregate telemetry (cache hit ratio, render
  latency, KV hit ratio, rate-limit rejections), see the
  `dmv_worker_events` Analytics Engine dataset — queryable from the CF
  dashboard → Workers → dmv-agentcommunity → Analytics Engine. Schema is
  documented at the `emitAnalytics()` helper in `worker/index.ts`.

- **Rate limiting**: `/api/card` and `/api/og` are guarded by the Workers
  Rate Limiting API binding `API_RATE_LIMITER` — 100 req/60s per
  `${ip}:${pathname}`. Configured under the top-level `ratelimits` array in
  `wrangler.jsonc`. The limiter runs BEFORE L1 lookup so rejected requests
  don't eat cache-tier work, and prewarm cron requests bypass via UA check
  (`dmv-cf-prewarm/1.0`). Rate-limit rejections emit an `error` category
  Analytics Engine event. For a future zone-level upgrade to Pro+, layer a
  WAF Rate Limiting Rule on top — WAF runs earlier in the request pipeline
  and rejected requests don't count as Worker invocations.

- **Badge KV cache**: `/badge/*` is proxied through the Worker to the
  Supabase `badge` edge function with a 10-minute KV read-through cache
  (`BADGE_CACHE_KV`). Badge SVGs are deterministic per cert ID and stale
  content is cosmetic, so the 10-min window trades invisible freshness for
  ~10x fewer Supabase invocations during peak traffic. Only `GET` requests
  are cached, and only `upstream.ok` responses are written. Content-Type
  and HTTP status are stored in KV metadata (1024-byte cap). Misses emit
  `X-Badge-Cache: MISS`, hits emit `X-Badge-Cache: KV-HIT`.

- **Request coalescing**: concurrent first-misses on the same cache key
  are deduplicated per Worker isolate via an in-memory `inflightRenders`
  Map in `worker/index.ts`. Scope is single-isolate (not global): CF may
  run multiple isolates per PoP, but within each isolate a thundering herd
  of N requests collapses to one container call. Failure of the primary
  render fails all awaiters of that batch with 502 — we do NOT
  auto-re-render to avoid amplifying a thundering-herd against a broken
  container. The Map entry is cleaned up in a `finally` block so the next
  batch of requests starts fresh. Closes the "Cache API request coalescing
  is not yet implemented" known gap from earlier.
```

- [ ] **Step 2: Update `CLOUDFLARE.md` → Known gaps**

Find the "Cache API request coalescing" bullet (around line 209-213). **Delete it entirely** — Task 7 closed this gap.

Leave the other "Known gaps" bullets (`API hardening`, `DMV-branded OTP`, `R2 bucket name`) unchanged — none of them were closed by this plan.

- [ ] **Step 3: Add a Security headers note to `CLOUDFLARE.md`**

Find the "Files" table (around line 120). Add a row for `public/_headers`:

```markdown
| `public/_headers` | Cache + security headers for Workers Static Assets. Sets global security headers (CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy), immutable cache headers for hashed assets (`/js/`, `/css/`, `/fonts/`, `/models/`), and `Link: rel=preload` headers on `/` and `/index.html` that Cloudflare auto-promotes to HTTP 103 Early Hints (requires zone-level Early Hints toggle enabled in the dashboard under Speed → Optimization → Content Optimization). CSP includes a `sha256-…` hash for the inline importmap, `'wasm-unsafe-eval'` for DRACOLoader, and `worker-src 'self' blob:` for the Draco decoder Worker. |
```

(If the row already exists from a previous edit, overwrite the description.)

- [ ] **Step 4: Update `ARCHITECTURE.md` → Rate limiting section**

Find the "Rate limiting (six layers)" section (around line 121). Update the heading and body to "Rate limiting (seven layers)" and add a new layer at the top describing the CF edge limiter:

Read the current section first:
```bash
sed -n '118,135p' ARCHITECTURE.md
```

Then edit the heading and prepend a new layer line. The exact diff depends on the current numbered-list format — keep the style consistent with the existing layers. The new layer description:

> **Layer 0 — Cloudflare Worker edge rate limit.** 100 req/60s per `${ip}:${pathname}` on `/api/card` and `/api/og` via the Workers Rate Limiting API. Runs BEFORE the in-Worker cache lookup so rejections don't eat CPU on L1/R2 reads. Rejected requests return `429` with `Retry-After: 60`. Configured in `wrangler.jsonc` under the top-level `ratelimits` array.

- [ ] **Step 5: Smoke test the docs**

```bash
# Verify all three files still render as valid markdown (no broken code fences, tables, etc.)
pnpm --silent markdownlint CLOUDFLARE.md ARCHITECTURE.md docs/plans/archive/2026-04-07-cf-native-hardening.md 2>&1 || true

# If markdownlint isn't installed, fall back to a visual scan:
head -50 CLOUDFLARE.md
```

If markdownlint reports errors, fix them before committing. If it's not installed, just eyeball the files in an editor to confirm structure is intact.

- [ ] **Step 6: Commit**

```bash
git add CLOUDFLARE.md ARCHITECTURE.md
git commit -m "$(cat <<'EOF'
docs: reflect CF-native hardening in CLOUDFLARE.md + ARCHITECTURE.md

Closes the "Cache API request coalescing" known gap (landed in Task 7).
Expands Operational notes with Analytics Engine, rate limiting, badge
KV cache, and request coalescing sections. Adds public/_headers row to
the Files table with CSP + Early Hints explanation. ARCHITECTURE.md
rate limiting section now includes the CF edge layer as Layer 0.

Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Self-review notes

- **Spec coverage:** All 8 items from the audit shortlist are covered. Task 1 = bindings (prereq). Task 2 = HEAD + 304. Task 3 = Vary. Task 4 = Analytics Engine. Task 5 = rate limiting. Task 6 = KV badge cache. Task 7 = L3 coalescing. Task 8 = CSP + Early Hints. Task 9 = healthz metadata. Task 10 = verification + deploy. **Skipped:** register-agent worker proxy (deserves its own plan, too large).
- **No automated tests:** Per CLOUDFLARE.md "No automated worker tests by design". Verification is manual smoke + `wrangler tail`. TDD is not applicable here — called out up front.
- **Sequential vs parallel:** Task 1 is a hard prerequisite. Tasks 2-7 all edit `worker/index.ts` sequentially. Task 8 (`_headers`) is fully parallel-safe with 2-7. Task 9 primarily edits `container/server.mjs` but ALSO tweaks `handleHealthz` in `worker/index.ts`, so it runs AFTER Task 7. Task 10 is the final gate.
- **Cache version bump:** Task 9 changes the container which bumps `CONTAINER_INSTANCE_ID` and invalidates R2+L1 on deploy. Called out in Task 9 and Task 10 Step 5.
- **Version-dependent values:** The Early Hints Link headers hard-code `?v=29` and `?v=31`. Task 8 Step 1 requires reading the actual versions from `index.html` first and substituting them. If this plan is executed weeks later, those versions may have changed.
- **CSP iteration:** Task 8 Step 6 requires browser iteration on CSP violations. The starting CSP is research-verified against Three.js r152 + DRACOLoader + GSAP 3.12 (includes `'wasm-unsafe-eval'`, `worker-src 'self' blob:`, and a SHA-256 hash for the inline importmap) but still run it in a browser with DevTools open before committing.
- **Coalescing scope:** Task 7 coalesces per-isolate only, NOT globally. Documented inline at the `inflightRenders` map. A DO-based global coordinator is out of scope for this plan.
- **Code review corrections applied 2026-04-07** (superpowers:code-reviewer):
  - **C1 (critical):** the original CSP `script-src 'self'` would have blocked the inline `<script type="importmap">` (index.html:200-207), breaking the entire module graph. Fixed by adding a `sha256-…` hash directive + compute-and-verify step at Task 8 Step 1.
  - **C3 (critical):** the original coalescing code re-rendered on inflight rejection, creating a thundering-herd-on-failure. Fixed by failing fast to 502 instead of re-dispatching another render.
  - **I1, I2:** L1 304 path had empty-Cache-Control fallback and miss-path entries had no ETag. Fixed via default Cache-Control value and synthetic `"${key}"` ETag.
  - **I4:** Task 4 originally instrumented `handleBadge` which Task 6 then overwrote. Consolidated: Task 4 only instruments `handleRender` + prewarm, Task 6 owns all `handleBadge` analytics + dispatch-site update.
  - **I9:** Task 9 was unverifiable because `handleHealthz` strips the container JSON. Fixed by adding a worker-side JSON forward to Task 9. As a side effect, Task 9 now runs sequentially after Task 7, not in parallel.
  - **I10:** Task 10's prod rate-limit smoke would have burned 120 container renders. Changed to use a single name so subsequent hits are L1-HIT.
  - **C2:** Task 5's local smoke test was masked by the `cf-connecting-ip` gate. Smoke test description downgraded to "verifies code doesn't throw"; real verification deferred to Task 10 Step 6.
  - **M3:** Deleted the ceremonial-dead-code `putL1Placeholder` helper.
  - **M17:** Task 10's `wrangler tail` watch reduced from 10 minutes to ~2 minutes to fit sub-agent patience.
- **Deferred / not fixed:**
  - **I3** (analytics events on 4xx validation returns): cosmetic, not required for launch. Post-launch cleanup if the bad-request rate becomes interesting.
  - Multiple minor cleanups (M5-M18 from the review) are intentionally left to post-landing review on the actual PRs.

### Research log — what was verified before committing this plan

Research dispatched 2026-04-07 against Cloudflare docs + Three.js / GSAP sources. All findings baked into the tasks above. Summary:

1. **Workers Rate Limiting API** — syntax moved from `unsafe.bindings` to top-level `ratelimits` array; requires wrangler ≥ 4.36.0. `period` must be 10 or 60. For the Workers Paid plan, this is the only way to express "100 req/60s per IP" — WAF Rate Limiting Rules are capped at 1 rule / IP-only / 10s period on that plan. On Pro+, layering a WAF rule on top is complementary (runs earlier in the request pipeline, rejected requests don't count as Worker invocations). Source: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/ and https://developers.cloudflare.com/waf/rate-limiting-rules/.

2. **Analytics Engine `writeDataPoint`** — shape `{indexes, blobs, doubles}` is correct. GA. Dataset auto-created on first write. **Limits:** `indexes` must have exactly 1 entry (max 96 bytes), `blobs` max 20 entries / 16 KB total, `doubles` max 20, 250 `writeDataPoint` calls per Worker invocation, 3-month retention. Source: https://developers.cloudflare.com/analytics/analytics-engine/limits/.

3. **KV `getWithMetadata`** — `getWithMetadata<Metadata>(key, 'arrayBuffer')` returns `{ value, metadata }` only (no `cacheStatus` field — dropped from the plan). Metadata limit is 1024 bytes serialized JSON. Source: https://developers.cloudflare.com/kv/api/read-key-value-pairs/.

4. **Early Hints on Workers Static Assets** — `_headers` is honored, and `Link: rel=preload` is auto-promoted to HTTP 103 by the edge — BUT the zone-level Early Hints toggle defaults to **OFF**. Task 8 Step 4 adds the dashboard enablement step. Source: https://developers.cloudflare.com/cache/advanced-configuration/early-hints/.

5. **CSP for Three.js + Draco + GSAP** — verified directly against `DRACOLoader.js` r152 source. Draco instantiates WebAssembly (needs `'wasm-unsafe-eval'`) AND spawns its decoder Worker from a `blob:` URL (needs `worker-src 'self' blob:`). Draco decoder path in this project is `https://cdn.jsdelivr.net/npm/three@0.152.2/examples/jsm/libs/draco/` (verified: `js/TV.js:144`), so jsdelivr must be in `script-src` AND `connect-src`. Three.js core and GSAP 3.12 core + ScrollTrigger are CSP-clean (no `eval`/`Function()`). Sources: Three.js r152 source, https://github.com/WebAssembly/content-security-policy/, GSAP forum.

6. **`caches.default` coalescing** — verified CF does NOT coalesce concurrent `caches.default.match`/`put` work. Cache-lock / request-collapsing only applies to `fetch()` with `cf.cacheEverything` (CDN path), which DMV doesn't use. Task 7's in-isolate Map is the correct layer. Sources: https://developers.cloudflare.com/workers/runtime-apis/cache/, https://developers.cloudflare.com/cache/concepts/default-cache-behavior/.
