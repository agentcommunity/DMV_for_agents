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
//   GET /api/card     → cached PNG (renders on first miss)
//   GET /api/og       → TODO — port from api/og.js to workers-og or similar
//   GET /healthz      → 200 ok (verifies worker + container reachability)
//   GET /              → minimal HTML index for sanity-checking deploys
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
}

// ─────────────────────────────────────────────────────────────────────────────
//  Constants
// ─────────────────────────────────────────────────────────────────────────────

// Public origin used in OG meta tags. Stays as the production domain even
// when serving from workers.dev — crawlers should always see canonical URLs.
const DMV_ORIGIN = 'https://dmv.agentcommunity.org';

// Crawler user-agent matcher — ported verbatim from middleware.js so we
// preserve identical bot detection. Order: social/messaging crawlers first,
// then search engines.
const CRAWLER_UA =
  /Twitterbot|facebookexternalhit|Facebot|LinkedInBot|Slackbot|WhatsApp|Discordbot|TelegramBot|Applebot|Googlebot|bingbot/i;

// Permalink path: /c/CERT-ID or /c/CERT-ID/agent-name
const PERMALINK_RE = /^\/c\/([^/]+)(?:\/([^/]+))?$/;

// Supabase functions origin for /badge/* proxy.
const SUPABASE_FUNCTIONS_ORIGIN = 'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1';

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

async function renderViaContainer(env: Env, params: RenderParams): Promise<Response> {
  // Single-instance routing for the test branch (deterministic = simpler debug).
  // For production we'd use getRandom() to spread across instances, or use
  // the location-aware helpers to route to the closest container.
  const container = getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID);

  const url = new URL('http://container/render');
  url.searchParams.set('name', params.name);
  url.searchParams.set('format', params.format);
  if (params.id) url.searchParams.set('id', params.id);
  if (params.type) url.searchParams.set('type', params.type);

  return container.fetch(url.toString());
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
      return badRequest('name is required');
    }
  }

  // Validation matches api/card.js
  if (name.length > 32) return badRequest('name must be 32 characters or fewer');
  if (id && id.length > 16) return badRequest('id must be 16 characters or fewer');
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    return badRequest('type must be individual, organization, or agent');
  }

  const params: RenderParams = { id, name, type, format };
  const key = cacheKey(params);

  // 1. R2 cache lookup
  const cached = await env.CARD_CACHE.get(key);
  if (cached) {
    // M-4: surface ETag + Content-Length on the cache HIT path so CDNs and
    // browsers can do conditional requests / accurate progress bars.
    return new Response(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'X-Cache': 'HIT',
        'X-Cache-Key': key,
        ETag: cached.httpEtag,
        'Content-Length': String(cached.size),
      },
    });
  }

  // 2. Cache miss — invoke container
  const containerResponse = await renderViaContainer(env, params);

  if (!containerResponse.ok) {
    // M-3: pass through the container's actual content-type instead of
    // forcing application/json — the body might be plain text or HTML.
    const body = await containerResponse.text();
    const upstreamType = containerResponse.headers.get('content-type') ?? 'text/plain';
    return new Response(body, {
      status: containerResponse.status,
      headers: { 'Content-Type': upstreamType, 'X-Source': 'container' },
    });
  }

  // 3. Buffer the PNG so we can both write to R2 and stream to client.
  // Cards are small enough that buffering is fine (no need for duplexed streams).
  const buffer = await containerResponse.arrayBuffer();

  // 4. Write to R2 in the background (I-5). The client gets the rendered PNG
  // immediately; the cache write happens via ctx.waitUntil so a slow R2 PUT
  // (50–200ms) doesn't extend response latency on the first miss. The IIFE
  // wraps the put in try/catch so a transient R2 error logs but doesn't
  // break the response.
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

  return new Response(buffer, {
    status: 200,
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
      'X-Cache': 'MISS',
      'X-Cache-Key': key,
    },
  });
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
  const twitterAlt = `DMV certificate card for ${displayName}`;

  // HTMLRewriter handlers — replace `content` attributes on existing meta tags.
  // The default index.html already has og:* and twitter:* tags pointing at
  // generic DMV branding; we override them per-permalink.
  const setContent = (val: string) => ({
    element(el: Element) {
      el.setAttribute('content', val);
    },
  });

  const rewriter = new HTMLRewriter()
    .on('title', {
      element(el) {
        el.setInnerContent(escapeHtml(title));
      },
    })
    .on('meta[property="og:title"]', setContent(title))
    .on('meta[property="og:description"]', setContent(description))
    .on('meta[property="og:image"]', setContent(ogImage))
    .on('meta[property="og:image:width"]', setContent('1200'))
    .on('meta[property="og:image:height"]', setContent('630'))
    .on('meta[property="og:url"]', setContent(permalink))
    .on('meta[name="twitter:title"]', setContent(title))
    .on('meta[name="twitter:description"]', setContent(description))
    .on('meta[name="twitter:image"]', setContent(ogImage))
    // Inject the elements that aren't in the default index.html.
    .on('head', {
      element(el) {
        el.append(
          `<meta name="twitter:image:alt" content="${escapeHtml(twitterAlt)}">`,
          { html: true },
        );
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
  // Ping the container too so we exercise the full path.
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
};
