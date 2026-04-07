// DMV card Worker — entry point for /api/card with R2 read-through cache.
//
// Flow:
//   GET /api/card?id=<>&name=<>&type=<>
//     1. Build cache key from query params
//     2. Try R2 GET — on hit, stream PNG back (free, no container invocation)
//     3. On miss, call CARD_RENDERER container, get PNG buffer
//     4. Write to R2 with 1y immutable cache headers
//     5. Return PNG to caller
//
// Endpoints:
//   GET /api/card     → cached PNG, 880×630 card (renders on first miss)
//   GET /api/og       → cached PNG, 1200×630 composite for OG/Twitter
//   GET /badge/*      → proxied through to the Supabase badge edge function
//   GET /c/:id/:name  → SPA shell (crawler UA gets OG meta-injected variant)
//   GET /healthz      → 200 ok (verifies worker + container reachability)
//
// Static assets are served by Workers Static Assets (declared in wrangler.jsonc).
// This Worker only handles dynamic routes.

import { Container, getContainer } from '@cloudflare/containers';
import { CONTAINER_INSTANCE_ID } from './container-instance';

// Cloudflare Containers ship as Durable Objects under the hood.
// `defaultPort` is the port the container's HTTP server listens on.
// `sleepAfter` triggers scale-to-zero when the container is idle.
export class CardRenderer extends Container {
  defaultPort = 8080;
  // 10m keeps the one active container warm across the scattered real
  // traffic DMV actually sees (few thousand requests over the takeover,
  // not the 25M the main site will absorb). Shorter sleepAfter would
  // force avoidable cold-starts between bursts.
  sleepAfter = '10m';

  override onStart(): void {
    console.log('[CardRenderer] container started');
  }
  override onStop(): void {
    console.log('[CardRenderer] container stopped');
  }
  override onError(error: unknown): void {
    console.error('[CardRenderer] container error:', error);
  }
}

interface Env {
  CARD_RENDERER: DurableObjectNamespace<CardRenderer>;
  CARD_CACHE: R2Bucket;
  // Workers Static Assets binding — points at the dist/ directory built by
  // scripts/build-cf.mjs. Used for: (1) crawler middleware HTMLRewriter
  // injection on /c/* (we fetch index.html via env.ASSETS.fetch and inject
  // og:* meta tags), (2) any future Worker route that needs to read a static
  // file. Static asset serving for everything else is automatic — the Worker
  // doesn't need to call ASSETS for those.
  ASSETS: Fetcher;
  // Origin used by the cron prewarm handler when fetching its own URLs.
  // Set in wrangler.jsonc `vars`. On the test branch this is the workers.dev
  // subdomain; on cutover it becomes https://dmv.agentcommunity.org.
  PREWARM_ORIGIN: string;
  // Analytics Engine dataset for structured cache/render/proxy metrics.
  // Schema: see emitAnalytics() below. Bound in wrangler.jsonc as
  // analytics_engine_datasets.
  ANALYTICS: AnalyticsEngineDataset;
}

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

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

// Public origin used in OG meta tags. Stays as the production domain even
// when serving from workers.dev — crawlers should always see canonical URLs.
const DMV_ORIGIN = 'https://dmv.agentcommunity.org';

// Crawler user-agent matcher. Order: social/messaging crawlers first, then
// search engines. Patterns are distinctive enough that false positives on
// real user browsers are extremely unlikely.
//
// Covered:
//   - Twitter/X                 → Twitterbot
//   - Facebook + Threads        → facebookexternalhit, Facebot
//   - LinkedIn                  → LinkedInBot
//   - Messaging                 → Slackbot, WhatsApp, Discordbot, TelegramBot
//   - iMessage + Safari link    → Applebot
//   - Search engines            → Googlebot, bingbot
//   - Pinterest                 → Pinterest (matches Pinterest/0.2 + Pinterestbot/1.0)
//   - Reddit                    → redditbot
//   - Fediverse (ActivityPub)   → Mastodon, Pleroma, Akkoma, Misskey
//   - Bluesky card fetcher      → Bluesky (matches "Bluesky Cardyb/1.0")
//
// Non-matching UAs fall through to the human SPA path, which still has
// generic OG tags from the static index.html — so a missed crawler degrades
// to generic branding rather than breaking.
const CRAWLER_UA =
  /Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Slackbot|WhatsApp|Discordbot|TelegramBot|Applebot|Googlebot|bingbot|Pinterest|redditbot|Mastodon|Pleroma|Akkoma|Misskey|Bluesky/i;

// Permalink path: /c/CERT-ID or /c/CERT-ID/agent-name
const PERMALINK_RE = /^\/c\/([^/]+)(?:\/([^/]+))?$/;

// Supabase functions origin for /badge/* proxy.
const SUPABASE_FUNCTIONS_ORIGIN = 'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1';

// URLs the cron prewarm handler hits to keep L1/L2 caches warm in whichever
// PoP CF schedules the cron in. Add featured-agent OG cards here when we
// identify them — anything in this list gets re-warmed every cron tick.
//
// Why prewarm at all: Brave new tab takeover lands ~25M impressions on a
// small set of hot URLs. Without prewarm, the FIRST hit in any cold PoP eats
// the full container render time (~150-300ms) and races against any
// concurrent requests for the same card. With a cron prewarm running every
// 10 minutes from CF's network, the L1 + L2 entries in serving PoPs stay
// fresh and the first real Brave hit is an L1-HIT.
//
// CF cron triggers run from various PoPs over time, so this also acts as a
// poor-man's global L1 warmer. Not as good as a fan-out warmer that hits
// every PoP, but free and zero ops.
const PREWARM_PATHS = [
  // Default homepage og:image — the Brave-takeover hot path. Hit BOTH the
  // explicit ?name=dmv and the fallback (no name) so we cover the two URL
  // shapes that the SPA might emit.
  '/api/og?name=dmv',
  '/api/og',
  // Sanity-check the /api/card endpoint too — same renderer, separate cache
  // namespace. Cheap to keep warm.
  '/api/card?name=dmv&type=individual',
] as const;

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

type RenderFormat = 'card' | 'og';

interface RenderParams {
  id?: string;
  name: string;
  type?: string;
  format: RenderFormat;
}

// Strip the 'card-renderer-' prefix from CONTAINER_INSTANCE_ID — we use just
// the hash as the R2 cache namespace so a container code change automatically
// invalidates all cached cards. Old entries become orphaned (R2 storage is
// cheap; they sit until manually purged or fall to TTL).
const CACHE_VERSION = CONTAINER_INSTANCE_ID.replace(/^card-renderer-/, '');

function cacheKey(params: RenderParams): string {
  // Card output is deterministic from (name, type, format, container code).
  // - name+type+id+format identify the visual
  // - CACHE_VERSION (= container hash) invalidates the cache when the
  //   renderer changes, so a deploy that fixes a rendering bug doesn't keep
  //   serving the old broken PNG forever
  // R2 key format:  v/<version>/<format>/<type>/<name>-<id>.png
  const id = params.id ?? '_';
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
  const type = safe(params.type ?? 'individual');
  return `v/${CACHE_VERSION}/${params.format}/${type}/${safe(params.name)}-${safe(id)}.png`;
}

// Build the L1 (caches.default / Cloudflare edge cache) cache key for a card.
//
// We use a SYNTHETIC URL on the same origin as the request so that:
//   1. Two requests with different query-param ordering or extra junk params
//      still resolve to the same L1 entry (the key encodes ONLY id/name/type/
//      format/version, not the raw query string).
//   2. The L1 namespace is the same as the R2 namespace — both invalidate
//      atomically when CACHE_VERSION (= container hash) changes.
//   3. The cache key is independent of /api/card vs /api/og path-prefix
//      collision risk: format is part of the key.
//
// The synthetic path `/__cache/...` is private to the Worker — it's never
// served as a real URL, only used as a Cache API key. The Cache API uses the
// URL as the cache key string; nothing actually fetches this URL.
//
// I-6: this is the L1 layer in front of R2. See handleRender for the lookup
// flow.
function l1CacheKey(request: Request, params: RenderParams): Request {
  const url = new URL(request.url);
  url.pathname = `/__cache/${cacheKey(params)}`;
  url.search = '';
  return new Request(url.toString(), { method: 'GET' });
}

async function renderViaContainer(env: Env, params: RenderParams): Promise<Response> {
  // Singleton routing — one active container is more than enough for DMV's
  // expected traffic (few thousand requests over the Brave window; the main
  // site absorbs the 25M impressions, not DMV). The version-namespaced
  // CONTAINER_INSTANCE_ID means a deploy atomically rolls forward the
  // container (fresh image) and the cache namespace (R2 + L1 keys both
  // prefix CACHE_VERSION), so there's no version skew.
  //
  // If DMV ever actually needs a pool, see git history at fafef20 for the
  // version-namespaced pickContainer() implementation and the reasoning
  // about why we don't use @cloudflare/containers' built-in getRandom().
  const container = getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID);

  const url = new URL('http://container/render');
  url.searchParams.set('name', params.name);
  url.searchParams.set('format', params.format);
  if (params.id) url.searchParams.set('id', params.id);
  if (params.type) url.searchParams.set('type', params.type);

  return container.fetch(url.toString());
}

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

// Match an If-None-Match header against a stored ETag per RFC 7232 §3.2.
// Supports the "*" wildcard, comma-separated lists, and weak comparison
// (W/"x" matches "x"). Returns true when the client already has a matching
// cached representation and the server should return 304.
function ifNoneMatchMatches(headerValue: string | null, etag: string): boolean {
  if (!headerValue) return false;
  const trimmed = headerValue.trim();
  if (trimmed === '*') return true;
  const stripWeak = (s: string) => s.replace(/^W\//, '');
  const normalized = stripWeak(etag);
  return trimmed
    .split(',')
    .some((candidate) => stripWeak(candidate.trim()) === normalized);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────────────────────────────────

// Default name used when /api/og is hit without a `name` parameter — e.g.,
// the homepage og:image meta tag. Picks a deterministic, on-brand name so
// the rendered card looks intentional.
const DEFAULT_OG_NAME = 'dmv';

async function handleRender(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  format: RenderFormat,
): Promise<Response> {
  const url = new URL(request.url);
  const startedAt = Date.now();
  const path = url.pathname;
  const method = request.method;
  if (method !== 'GET' && method !== 'HEAD') {
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
        Allow: 'GET, HEAD',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }
  const ifNoneMatch = request.headers.get('if-none-match');
  // Emit an analytics event for validation-error returns (4xx). Used by
  // the bad() helper below and directly for 405. tier is passed in so the
  // dataset can distinguish 'validation', '405', '429', etc.
  const emitError = (tier: string): void => {
    emitAnalytics(env, {
      category: 'error',
      tier,
      path,
      key: '',
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
  };
  const bad = (msg: string): Response => {
    emitError('validation');
    return badRequest(msg);
  };
  let name = url.searchParams.get('name');
  const id = url.searchParams.get('id') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;

  // OG without a name → fall back to a default-branded card so the homepage
  // meta tag still has something to point at. /api/card without a name still
  // 400s — only /api/og is forgiving here.
  if (!name) {
    if (format === 'og') {
      name = DEFAULT_OG_NAME;
    } else {
      return bad('name is required');
    }
  }

  // Input validation — 32-char name cap, 16-char id cap, type enum.
  if (name.length > 63) return bad('name must be 63 characters or fewer');
  if (id && id.length > 16) return bad('id must be 16 characters or fewer');
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    return bad('type must be individual, organization, or agent');
  }

  const params: RenderParams = { id, name, type, format };
  const key = cacheKey(params);
  const l1Key = l1CacheKey(request, params);

  // Synthetic strong ETag shared across all cache tiers (L1, L2, miss).
  // The cache key already encodes CACHE_VERSION + format + type + name + id,
  // so it is a deterministic content identifier. Using the same ETag from
  // L1/L2/miss means clients that cached the ETag from any tier will get
  // 304 on the next conditional request from any tier (no wasted full-body
  // responses after L1 evictions).
  const synthEtag = `"${key}"`;

  // ───────────────────────────────────────────────────────────────────────
  //  Cache hierarchy (I-6 — added before Brave new tab takeover)
  //
  //   L1 = caches.default (Cloudflare edge cache, in-region, ~ms)
  //   L2 = R2 (cross-region, ~50–200ms)
  //   L3 = Container (Skia render via DO, ~150–300ms)
  //
  //  Why L1 in front of R2:
  //  Brave new tab takeover lands ~25M impressions on the homepage og:image.
  //  Without L1, every cold-PoP first-hit goes through R2 (~100ms p50). With
  //  L1, the second hit and onwards in any given PoP serves from edge cache
  //  for free, with no R2 read or DO invocation. R2 still acts as the
  //  cross-PoP source of truth so a cold PoP can warm without re-rendering.
  //
  //  Note: caches.default does NOT do true cross-request coalescing during
  //  the cache-fill window — concurrent first-misses can still race for a
  //  few ms. For the hot-card scenario (homepage og:image, featured agents)
  //  the fill window is over before it matters because one of the racing
  //  requests wins and fills the cache. For the worst worst case
  //  (a brand-new viral card hit by a thundering herd), the win is bounded
  //  by however long the container takes to render (150–300ms) — we accept
  //  that as the cost of not having a Durable Object render coordinator.
  // ───────────────────────────────────────────────────────────────────────

  // 1. L1 lookup — the hot path. Serves from in-region edge cache when warm.
  try {
    const l1Hit = await caches.default.match(l1Key);
    if (l1Hit) {
      const l1Etag = l1Hit.headers.get('etag');
      // Conditional request: if the client's If-None-Match matches the cached
      // ETag, return 304 with no body (saves egress on repeat visits).
      if (l1Etag && ifNoneMatchMatches(ifNoneMatch, l1Etag)) {
        emitAnalytics(env, {
          category: 'render',
          tier: '304',
          path,
          key,
          latencyMs: Date.now() - startedAt,
          sizeBytes: 0,
        });
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
      // L1 entries inherit Content-Type/Cache-Control/ETag/Content-Length from
      // the putL1() call — we just overlay X-Cache/X-Cache-Key per request.
      const headers = new Headers(l1Hit.headers);
      headers.set('X-Cache', 'L1-HIT');
      headers.set('X-Cache-Key', key);
      emitAnalytics(env, {
        category: 'render',
        tier: 'L1-HIT',
        path,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: Number(l1Hit.headers.get('content-length') ?? 0),
      });
      return stripBodyForHead(
        new Response(l1Hit.body, { status: l1Hit.status, headers }),
        method,
      );
    }
  } catch (err) {
    console.error('[L1] caches.default.match failed', { key, err });
    emitAnalytics(env, {
      category: 'error',
      tier: 'L1-EXCEPTION',
      path,
      key,
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
  }

  // 2. L2 lookup — R2 cross-region cache.
  const cached = await env.CARD_CACHE.get(key);
  if (cached) {
    // Conditional request short-circuit: no need to materialise the body if
    // the client already has this ETag. Note: we do NOT promote this entry
    // into L1 on the 304 path because we skipped arrayBuffer() and don't
    // have the bytes to store. The next full-body miss will promote.
    if (ifNoneMatchMatches(ifNoneMatch, synthEtag)) {
      emitAnalytics(env, {
        category: 'render',
        tier: '304',
        path,
        key,
        latencyMs: Date.now() - startedAt,
        sizeBytes: 0,
      });
      return new Response(null, {
        status: 304,
        headers: {
          'X-Cache': 'L2-HIT',
          'X-Cache-Key': key,
          ETag: synthEtag,
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
      ETag: synthEtag,
      'Content-Length': String(cached.size),
    } as const;
    ctx.waitUntil(putL1(l1Key, bodyBuffer, synthEtag, key));
    emitAnalytics(env, {
      category: 'render',
      tier: 'L2-HIT',
      path,
      key,
      latencyMs: Date.now() - startedAt,
      sizeBytes: cached.size,
    });
    return stripBodyForHead(
      new Response(bodyBuffer, { status: 200, headers: responseHeaders }),
      method,
    );
  }

  // 3. Both caches miss — invoke container.
  const containerResponse = await renderViaContainer(env, params);

  if (!containerResponse.ok) {
    // M-3: pass through the container's actual content-type instead of
    // forcing application/json — the body might be plain text or HTML.
    // Don't cache errors anywhere — let the next request try again.
    const body = await containerResponse.text();
    const upstreamType = containerResponse.headers.get('content-type') ?? 'text/plain';
    emitAnalytics(env, {
      category: 'error',
      tier: `container-${containerResponse.status}`,
      path,
      key,
      latencyMs: Date.now() - startedAt,
      sizeBytes: 0,
    });
    return new Response(body, {
      status: containerResponse.status,
      headers: { 'Content-Type': upstreamType, 'X-Source': 'container' },
    });
  }

  // Buffer the PNG so we can stream to client AND populate both cache tiers.
  // Cards are small enough that buffering is fine (no need for duplexed streams).
  const buffer = await containerResponse.arrayBuffer();

  // 4. Write to BOTH cache tiers in the background (I-5 + I-6). The client
  // gets the rendered PNG immediately; cache writes happen via ctx.waitUntil
  // so neither R2 PUT (~50–200ms) nor L1 PUT (~few ms) extends response
  // latency on the first miss. Each put is wrapped in try/catch so a
  // transient cache error logs but doesn't break the response.
  // Note: M-5 — httpMetadata.cacheControl is dead because the Worker re-applies
  // its own Cache-Control on every response and R2 isn't exposed publicly.
  // Drop it rather than carrying confusing dead config.
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
  ctx.waitUntil(putL1(l1Key, buffer, synthEtag, key));

  emitAnalytics(env, {
    category: 'render',
    tier: 'MISS',
    path,
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
        ETag: synthEtag,
      },
    }),
    method,
  );
}

// L1 (caches.default) put helper — wraps the cache write in try/catch so a
// transient Cache API error logs but doesn't break the upstream response.
//
// We construct a fresh Response (rather than reusing the upstream R2/container
// response) because the Cache API needs an immutable Cache-Control header on
// the stored response to honour TTL, and Response objects can only be put()
// once (the body stream gets consumed). Building from a buffer is cheap.
async function putL1(
  l1Key: Request,
  body: ArrayBuffer,
  etag: string | undefined,
  debugKey: string,
): Promise<void> {
  try {
    const headers = new Headers({
      'Content-Type': 'image/png',
      // s-maxage drives the L1 TTL; the Cache API honours s-maxage (or
      // max-age in its absence). 7 days matches what the M-4 R2 hit path
      // returns to clients. Cards are deterministic from CACHE_VERSION so a
      // long TTL is safe — a deploy bumps the version → fresh cache key.
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
      'Content-Length': String(body.byteLength),
    });
    if (etag) headers.set('ETag', etag);
    await caches.default.put(l1Key, new Response(body, { status: 200, headers }));
  } catch (err) {
    console.error('[L1] caches.default.put failed', { key: debugKey, err });
  }
}

const handleCard = (request: Request, env: Env, ctx: ExecutionContext) =>
  handleRender(request, env, ctx, 'card');
const handleOg = (request: Request, env: Env, ctx: ExecutionContext) =>
  handleRender(request, env, ctx, 'og');

// ─────────────────────────────────────────────────────────────────────────────
//  /c/:certId/:agentName — permalink with crawler OG injection
// ─────────────────────────────────────────────────────────────────────────────
//
// Two paths:
//   - Crawler UA  → fetch index.html via env.ASSETS, use HTMLRewriter to
//                   override <title> + og:* + twitter:* meta tags with
//                   card-specific values, return modified HTML
//   - Human  UA  → fetch index.html via env.ASSETS unchanged. The SPA reads
//                   window.location and renders the permalink card.
//
// Functionally identical to the previous Vercel middleware.js, but the
// canonical HTML stays in one place (index.html) and we just patch meta tags
// in-stream rather than maintaining a hand-written HTML template.

async function handlePermalink(
  request: Request,
  env: Env,
  match: RegExpMatchArray,
): Promise<Response> {
  // M-8: only GET/HEAD make sense for the permalink shell. Anything else
  // (POST/PUT/DELETE) used to fall through and serve the SPA HTML — surprising
  // and slightly misleading. Reject explicitly with 405.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method Not Allowed', {
      status: 405,
      headers: { Allow: 'GET, HEAD', 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const certId = decodeURIComponent(match[1]);
  const agentName = match[2] ? decodeURIComponent(match[2]) : '';

  // Always serve index.html — both human and crawler paths render the SPA shell.
  // We use a same-origin URL so the assets binding picks the right file.
  const indexUrl = new URL('/index.html', request.url);
  const indexResp = await env.ASSETS.fetch(new Request(indexUrl.toString(), { method: 'GET' }));

  // I-4: if the assets binding can't return a usable index.html (genuine 404,
  // 5xx, etc.), don't keep going. Wrapping a 404 body with a 200 status —
  // which the old crawler path did via the hardcoded `status: 200` — would
  // tell crawlers a missing page is fine. Bail with a hand-built 404 instead.
  if (!indexResp.ok) {
    console.error('[handlePermalink] index.html fetch failed', {
      status: indexResp.status,
      url: indexUrl.toString(),
    });
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  const ua = request.headers.get('user-agent') ?? '';
  if (!CRAWLER_UA.test(ua)) {
    // Human visitor — return index.html unchanged. SPA handles the permalink
    // route via window.location parsing.
    return new Response(indexResp.body, {
      status: indexResp.status,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        // Same cache profile as the index.html _headers rule.
        'Cache-Control': 'public, max-age=0, s-maxage=60, stale-while-revalidate=300',
        // Prevents the edge from serving a cached crawler variant to a human
        // (or vice versa) since the two branches return different bodies.
        Vary: 'User-Agent',
      },
    });
  }

  // Crawler — patch meta tags via HTMLRewriter (streaming, zero buffering).
  const displayName = agentName ? `${agentName}.agent` : 'Agent';
  const title = `${displayName} — DMV Certificate ${certId}`;
  const description = `${displayName} is verified at the Department of Machine Verification. Certificate ID: ${certId}. Get yours at dmv.agentcommunity.org`;
  const permalink = `${DMV_ORIGIN}/c/${encodeURIComponent(certId)}/${encodeURIComponent(agentName || 'agent')}`;
  // Both og:image and twitter:image now use /api/og — the same Skia-rendered
  // card composited onto a 1200x630 canvas (1.91:1, perfect for OG/Twitter).
  // No need for the dual /api/card + /api/og workaround the old Vercel
  // middleware used: with R2 caching, the once-per-card render cost is paid
  // up front and every subsequent crawler hit is free.
  const ogImage = `${DMV_ORIGIN}/api/og?id=${encodeURIComponent(certId)}&name=${encodeURIComponent(agentName)}`;
  const imageAlt = `DMV certificate card for ${displayName}`;

  // HTMLRewriter handlers — replace `content` attributes on existing meta tags.
  // The default index.html already has og:* and twitter:* tags pointing at
  // generic DMV branding; we override them per-permalink.
  const setContent = (val: string) => ({
    element(el: Element) {
      el.setAttribute('content', val);
    },
  });

  // Override tags that exist in the static index.html — each setContent call
  // swaps the existing `content` attribute in place. og:image:type stays as
  // the static "image/png" (deterministic, no per-card variation).
  //
  // og:image:alt and twitter:image:alt both exist in the static HTML with
  // generic DMV copy; here we override them with per-card alt text so screen
  // readers on FB/LinkedIn and Twitter announce the actual agent name.
  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        // setInnerContent defaults to { html: false }, which escapes the
        // content as text on output. Passing a raw string here is correct;
        // wrapping it in escapeHtml() would double-escape `&`, `<`, `>`, `"`.
        el.setInnerContent(title);
      },
    })
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:image"]', setContent(ogImage))
    .on('meta[property="og:image:width"]', setContent('1200'))
    .on('meta[property="og:image:height"]', setContent('630'))
    .on('meta[property="og:image:alt"]', setContent(imageAlt))
    .on('meta[property="og:url"]', setContent(permalink))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[name="twitter:image"]', setContent(ogImage))
    .on('meta[name="twitter:image:alt"]', setContent(imageAlt))
    // rel=canonical doesn't exist in the default index.html, so append it.
    .on('head', {
      element(el) {
        el.append(
          `<link rel="canonical" href="${escapeHtml(permalink)}">`,
          { html: true },
        );
      },
    });

  const transformed = rewriter.transform(indexResp);
  return new Response(transformed.body, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // Match the previous Vercel middleware cache profile.
      'Cache-Control': 'public, max-age=300, s-maxage=3600',
      'X-Permalink-Mode': 'crawler',
      Vary: 'User-Agent',
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
//  /badge/* — proxy to Supabase Edge Functions
// ─────────────────────────────────────────────────────────────────────────────
//
// Replaces the vercel.json rewrite. We just forward the request to the
// Supabase function URL with the path tail preserved. No auth needed —
// the badge function is public.

// Headers we forward upstream to Supabase. Anything else (Cookie,
// Authorization, cf-*, host, etc.) is dropped — we never want to leak
// dmv.agentcommunity.org credentials to a different origin, and CF-injected
// headers carry no meaning to Supabase. (I-2)
const BADGE_FORWARD_REQUEST_HEADERS = [
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
] as const;

// Headers we strip from Supabase's response before returning to the client.
// `set-cookie` would scope a Supabase cookie onto the DMV domain — refuse it.
// Hop-by-hop headers per RFC 7230 §6.1 are connection-scoped and must not be
// proxied. (I-2)
const BADGE_RESPONSE_HEADERS_TO_STRIP = new Set([
  'set-cookie',
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'upgrade',
]);

async function handleBadge(request: Request): Promise<Response> {
  const url = new URL(request.url);
  // /badge/foo/bar → /badge/foo/bar (Supabase function path matches).
  // Strip the prefix so we can validate the resolved path below.
  const tail = url.pathname.slice('/badge'.length); // '' or '/...'

  // I-3: path traversal defense. Defense-in-depth — reject obvious badness
  // first, then validate by URL parsing on the upstream side.
  if (tail.includes('..') || tail.includes('//')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }
  const targetUrl = new URL(`${SUPABASE_FUNCTIONS_ORIGIN}/badge${tail}${url.search}`);
  // After URL normalisation, make sure we're still inside /functions/v1/badge.
  // If a URL trick squeaked past the textual check, this catches it.
  if (!targetUrl.pathname.startsWith('/functions/v1/badge')) {
    return new Response('Not Found', {
      status: 404,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    });
  }

  // Build a clean header set instead of forwarding the request verbatim. (I-2)
  const upstreamHeaders = new Headers();
  for (const name of BADGE_FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }
  // Standard reverse-proxy hints so the Supabase function knows the original
  // client. cf-connecting-ip is the CF-attested client IP.
  const clientIp = request.headers.get('cf-connecting-ip');
  if (clientIp) upstreamHeaders.set('x-forwarded-for', clientIp);
  upstreamHeaders.set('x-forwarded-host', url.host);
  upstreamHeaders.set('x-forwarded-proto', url.protocol.replace(':', ''));

  const upstream = await fetch(targetUrl.toString(), {
    method: request.method,
    headers: upstreamHeaders,
    body: request.body,
  });

  // Strip hop-by-hop + set-cookie headers from the response. (I-2)
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!BADGE_RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

async function handleHealthz(env: Env): Promise<Response> {
  // Ping the singleton container so we exercise the full path.
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

// ─────────────────────────────────────────────────────────────────────────────
//  Entry
// ─────────────────────────────────────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // /api/card → container-rendered 880x630 PNG with R2 cache
    if (url.pathname === '/api/card') return handleCard(request, env, ctx);

    // /api/og → SAME container renderer, composited onto 1200x630 for OG/Twitter
    if (url.pathname === '/api/og') return handleOg(request, env, ctx);

    // /badge/* → Supabase Edge Function proxy
    if (url.pathname.startsWith('/badge/') || url.pathname === '/badge') {
      return handleBadge(request);
    }

    // /c/:certId/:agentName → permalink with crawler OG injection or SPA shell
    const permalinkMatch = url.pathname.match(PERMALINK_RE);
    if (permalinkMatch) return handlePermalink(request, env, permalinkMatch);

    // Health check
    if (url.pathname === '/healthz') return handleHealthz(env);

    // Everything else: defer to Workers Static Assets (this only fires for
    // paths NOT in `assets.run_worker_first`, but if a request slips through,
    // we still serve it correctly.)
    return env.ASSETS.fetch(request);
  },

  // Cron-driven cache prewarm. wrangler.jsonc declares the trigger schedule
  // (default: every 10 minutes). For each path in PREWARM_PATHS we synthesize
  // an internal Request and call handleRender directly — same code path as a
  // real /api/card or /api/og hit, so it warms L1 (caches.default in this
  // PoP) and populates L2 (R2, cross-PoP).
  //
  // Why direct calls instead of `fetch(env.PREWARM_ORIGIN + path)`: Workers
  // can't reliably loop back to their own public URL — CF's edge classifies
  // a Worker fetching its own subdomain as a recursive subrequest and routes
  // it past the Worker into Static Assets, which 404s on /api/* paths.
  // Verified empirically: the public-URL approach returned 404 from inside
  // the cron handler even though the same URL returns 200 from outside.
  // Calling handleCard/handleOg directly avoids the loopback entirely.
  //
  // PREWARM_ORIGIN is still used as the synthetic Request's origin so the
  // resulting `request.url` looks like a real public URL (handleRender uses
  // it to build the L1 cache key — keeps the cache key shape consistent
  // with real traffic).
  //
  // Cache effectiveness shows up in wrangler tail: each line logs the
  // X-Cache header. Healthy steady state: every line says L1-HIT. After a
  // deploy that bumps CACHE_VERSION the next tick says MISS once per path
  // (fresh container render) then L1-HIT forever after.
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const origin = env.PREWARM_ORIGIN;
    if (!origin) {
      console.error('[prewarm] PREWARM_ORIGIN not set; skipping');
      return;
    }
    for (const path of PREWARM_PATHS) {
      ctx.waitUntil(
        (async () => {
          try {
            const url = new URL(path, origin);
            const request = new Request(url.toString(), {
              method: 'GET',
              headers: { 'user-agent': 'dmv-cf-prewarm/1.0' },
            });
            // Route by pathname — only /api/card and /api/og make sense for
            // a render-cache prewarm. Other paths in PREWARM_PATHS would be
            // a config error; log and skip rather than 500.
            let response: Response;
            if (url.pathname === '/api/og') {
              response = await handleOg(request, env, ctx);
            } else if (url.pathname === '/api/card') {
              response = await handleCard(request, env, ctx);
            } else {
              console.error(`[prewarm] ${path} -> not a renderable path, skipping`);
              return;
            }
            console.log(
              `[prewarm] ${path} -> ${response.status} x-cache=${response.headers.get('x-cache') ?? 'none'}`,
            );
            emitAnalytics(env, {
              category: 'prewarm',
              tier: response.headers.get('x-cache') ?? 'UNKNOWN',
              path,
              key: response.headers.get('x-cache-key') ?? '',
              latencyMs: 0, // prewarm latency isn't meaningful (background)
              sizeBytes: 0,
            });
            // Drain the body so any handleRender ctx.waitUntil work (R2 put,
            // L1 put) actually has something to flush. Without this the
            // Response body sits unread and the underlying buffer/stream
            // isn't released.
            await response.arrayBuffer();
          } catch (err) {
            console.error(`[prewarm] ${path} failed`, err);
          }
        })(),
      );
    }
  },
} satisfies ExportedHandler<Env>;
