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
}

// ─────────────────────────────────────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────────────────────────────────────

function badRequest(msg: string): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status: 400,
    headers: { 'Content-Type': 'application/json' },
  });
}

function cacheKey(params: { id?: string; name: string; type?: string }): string {
  // Card output is deterministic from (name, type) — id is part of the visual
  // (it's printed on the card) but generated deterministically from name when
  // not provided. We include all three in the key so explicit-id requests
  // don't collide with implicit-id requests.
  const id = params.id ?? '_';
  const type = params.type ?? 'individual';
  // Lowercase + simple normalization. Slashes forbidden inside R2 key segments.
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9._-]/g, '_').toLowerCase();
  return `cards/${safe(params.type ?? 'individual')}/${safe(params.name)}-${safe(id)}.png`;
}

async function renderViaContainer(
  env: Env,
  params: { id?: string; name: string; type?: string },
): Promise<Response> {
  // Single-instance routing for the test branch (deterministic = simpler debug).
  // For production we'd use getRandom() to spread across instances, or use
  // the location-aware helpers to route to the closest container.
  const container = getContainer(env.CARD_RENDERER, 'default');

  const url = new URL('http://container/render');
  url.searchParams.set('name', params.name);
  if (params.id) url.searchParams.set('id', params.id);
  if (params.type) url.searchParams.set('type', params.type);

  return container.fetch(url.toString());
}

// ─────────────────────────────────────────────────────────────────────────────
//  Routes
// ─────────────────────────────────────────────────────────────────────────────

async function handleCard(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const name = url.searchParams.get('name');
  const id = url.searchParams.get('id') ?? undefined;
  const type = url.searchParams.get('type') ?? undefined;

  // Validation matches api/card.js
  if (!name) {
    // Current Vercel behavior: redirect to /api/og when no name
    return Response.redirect(new URL('/api/og', request.url).toString(), 302);
  }
  if (name.length > 32) return badRequest('name must be 32 characters or fewer');
  if (id && id.length > 16) return badRequest('id must be 16 characters or fewer');
  if (type && !['individual', 'organization', 'agent'].includes(type.toLowerCase())) {
    return badRequest('type must be individual, organization, or agent');
  }

  const key = cacheKey({ id, name, type });

  // 1. R2 cache lookup
  const cached = await env.CARD_CACHE.get(key);
  if (cached) {
    return new Response(cached.body, {
      status: 200,
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400',
        'X-Cache': 'HIT',
        'X-Cache-Key': key,
      },
    });
  }

  // 2. Cache miss — invoke container
  const containerResponse = await renderViaContainer(env, { id, name, type });

  if (!containerResponse.ok) {
    // Pass through error from container
    const body = await containerResponse.text();
    return new Response(body, {
      status: containerResponse.status,
      headers: { 'Content-Type': 'application/json', 'X-Source': 'container' },
    });
  }

  // 3. Tee the body so we can both write to R2 and stream to client.
  // Using arrayBuffer() is simpler for a small PNG (<300 KB) and avoids
  // duplexed-stream complexity. Cards are small enough that buffering is fine.
  const buffer = await containerResponse.arrayBuffer();

  // 4. Write to R2 (fire-and-forget — don't block the response)
  // ctx.waitUntil would be the production pattern, but for the test we just
  // await it so we know it succeeded.
  await env.CARD_CACHE.put(key, buffer, {
    httpMetadata: {
      contentType: 'image/png',
      cacheControl: 'public, max-age=31536000, immutable',
    },
  });

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

async function handleHealthz(env: Env): Promise<Response> {
  // Ping the container too so we exercise the full path.
  try {
    const container = getContainer(env.CARD_RENDERER, 'default');
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/card') return handleCard(request, env);
    if (url.pathname === '/healthz') return handleHealthz(env);

    // Everything else falls through to static assets (declared in wrangler.jsonc).
    // For the test branch, we don't serve any static assets — just return 404
    // for unknown paths so the test harness can detect bad routing.
    return new Response('not found', { status: 404 });
  },
};
