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
import { incrementKvCooldown } from './rate-limit-kv';

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

// Ambient type for the Workers Rate Limiting API binding. Not exported by
// @cloudflare/workers-types at all versions; define locally.
interface RateLimit {
  limit(options: { key: string }): Promise<{ success: boolean }>;
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
  // Workers Rate Limiting API binding. Configured in wrangler.jsonc under
  // the top-level `ratelimits` array. 100 req/60s per IP+path across /api/*.
  API_RATE_LIMITER: RateLimit;
  // Shared signup abuse counters with PAGE. Only the email and IP+email
  // surfaces are shared across products.
  RL_OTP_EMAIL: RateLimit;
  RL_OTP_IP_EMAIL: RateLimit;
  // KV cache for /badge/* responses. 10 min TTL. Keyed by
  // `badge:${pathname}${search}`. Values are raw bytes with content-type
  // stored in the KV metadata.
  BADGE_CACHE_KV: KVNamespace;
  // DMV-local coarse cooldown state for machine-fingerprint registration
  // limits on CLI/MCP flows. Intentionally not shared with PAGE.
  REGISTER_COOLDOWN_KV: KVNamespace;
  TURNSTILE_SECRET_KEY: string;
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
  category: 'render' | 'badge' | 'prewarm' | 'register' | 'error';
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

// Content-Security-Policy applied to permalink HTML responses served by
// handlePermalink. Mirrors the /* rule in public/_headers — duplicated here
// because `run_worker_first: ["/c/*"]` means the Worker constructs the
// Response directly and Static Assets' _headers rules never get a chance
// to run on these paths. Keep in sync with public/_headers manually.
//
// Includes the sha256 hash for the inline <script type="importmap"> block
// in index.html. If that block changes, recompute the hash via:
//   node -e 'const fs=require("fs"),crypto=require("crypto");const m=fs.readFileSync("index.html","utf8").match(/<script type="importmap">([\s\S]*?)<\/script>/);console.log("sha256-"+crypto.createHash("sha256").update(m[1]).digest("base64"));'
// and update BOTH this constant AND public/_headers.
const PERMALINK_CSP =
  "default-src 'self'; script-src 'self' 'sha256-4FXY4zEWzG37E4zo2Jp75PEXIdWH8wCQO29RFVSutWk=' 'wasm-unsafe-eval' https://cdn.jsdelivr.net https://challenges.cloudflare.com https://static.cloudflareinsights.com; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' blob: https://tcymqfwwphacnosnnzxl.supabase.co https://cdn.jsdelivr.net https://challenges.cloudflare.com https://cloudflareinsights.com; frame-src https://challenges.cloudflare.com; media-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'";

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

// Permalink path: /c/CERT-ID or /c/CERT-ID/agent-name
const PERMALINK_RE = /^\/c\/([^/]+)(?:\/([^/]+))?$/;

// Supabase functions origin for /badge/* proxy.
const SUPABASE_FUNCTIONS_ORIGIN = 'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1';
const DMV_REGISTER_PATH = '/api/register';
const DMV_TURNSTILE_ACTION = 'dmv_register';

// Browser Turnstile tokens must be minted for the same hostname that served
// the DMV page. In production this is dmv.agentcommunity.org; in local dev
// this naturally becomes localhost / 127.0.0.1 when using Cloudflare's test
// keys.
const TURNSTILE_VERIFY_ENDPOINT = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

// Allow 3 successful registrations per machine fingerprint in a rolling 24h
// window; block the 4th and later attempts until the existing TTL expires.
const FINGERPRINT_COOLDOWN_THRESHOLD = 4;
const FINGERPRINT_COOLDOWN_SECONDS = 24 * 60 * 60;

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

function jsonResponse(body: unknown, status: number, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...(headers ?? {}),
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripPort(hostname: string): string {
  return hostname.trim().toLowerCase().replace(/:\d+$/, '');
}

function getExpectedHostname(request: Request): string {
  const forwardedHost = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
  if (forwardedHost) return stripPort(forwardedHost);
  return stripPort(new URL(request.url).hostname);
}

function getClientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip')
    ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    ?? '127.0.0.1';
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('');
}

type SignupSource = 'ui' | 'cli' | 'mcp' | 'api';
type RegistrationType = 'AGENT' | 'INDIVIDUAL' | 'ORGANIZATION';

interface CanonicalRegisterBody {
  agent_name: string;
  email: string;
  operator_name: string | null;
  organization_name: string | null;
  description: string | null;
  signup_source: SignupSource;
  registration_type: RegistrationType;
  machine_fingerprint?: string;
  'cf-turnstile-response'?: string;
}

interface TurnstileVerifyResponse {
  success?: boolean;
  hostname?: string;
  action?: string;
}

function parseRegisterBody(body: unknown): { value: CanonicalRegisterBody | null; error: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { value: null, error: 'invalid_request' };
  }

  const raw = body as Record<string, unknown>;
  const agentName = typeof raw.agent_name === 'string' ? raw.agent_name.trim() : '';
  if (!agentName) return { value: null, error: 'agent_name is required' };
  if (agentName.length < 3) return { value: null, error: 'agent_name must be at least 3 characters' };
  if (agentName.length > 63) return { value: null, error: 'agent_name must be at most 63 characters' };
  if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(agentName)) {
    return { value: null, error: 'agent_name must be lowercase alphanumeric (hyphens allowed in middle)' };
  }

  const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
  if (!email) return { value: null, error: 'email is required' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { value: null, error: 'Invalid email format' };
  }
  if (email.length > 254) return { value: null, error: 'email must be 254 characters or fewer' };

  const operatorName = typeof raw.operator_name === 'string' ? raw.operator_name.trim() : '';
  if (operatorName.length > 100) {
    return { value: null, error: 'operator_name must be 100 characters or fewer' };
  }

  const organizationName = typeof raw.organization_name === 'string' ? raw.organization_name.trim() : '';
  if (organizationName.length > 100) {
    return { value: null, error: 'organization_name must be 100 characters or fewer' };
  }

  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  if (description.length > 500) {
    return { value: null, error: 'description must be 500 characters or fewer' };
  }

  const signupSourceRaw = typeof raw.signup_source === 'string' ? raw.signup_source.trim() : 'api';
  if (!['ui', 'cli', 'mcp', 'api'].includes(signupSourceRaw)) {
    return { value: null, error: 'signup_source must be ui, cli, mcp, or api' };
  }
  const signup_source = signupSourceRaw as SignupSource;

  const registrationTypeRaw = typeof raw.registration_type === 'string' ? raw.registration_type.trim() : 'AGENT';
  if (!['AGENT', 'INDIVIDUAL', 'ORGANIZATION'].includes(registrationTypeRaw)) {
    return { value: null, error: 'registration_type must be AGENT, INDIVIDUAL, or ORGANIZATION' };
  }
  const registration_type = registrationTypeRaw as RegistrationType;

  if ((registration_type === 'INDIVIDUAL' || registration_type === 'ORGANIZATION') && !operatorName) {
    return { value: null, error: 'operator_name (full_name) is required for INDIVIDUAL and ORGANIZATION registrations' };
  }

  if (registration_type === 'ORGANIZATION' && !organizationName) {
    return { value: null, error: 'organization_name is required for ORGANIZATION registrations' };
  }

  const canonical: CanonicalRegisterBody = {
    agent_name: agentName,
    email,
    operator_name: operatorName || null,
    organization_name: organizationName || null,
    description: description || null,
    signup_source,
    registration_type,
  };

  if (typeof raw.machine_fingerprint === 'string' && raw.machine_fingerprint.trim()) {
    canonical.machine_fingerprint = raw.machine_fingerprint.trim();
  } else if (raw.machine_fingerprint != null && raw.machine_fingerprint !== '') {
    return { value: null, error: 'machine_fingerprint must be a non-empty string' };
  }

  if (typeof raw['cf-turnstile-response'] === 'string' && raw['cf-turnstile-response'].trim()) {
    canonical['cf-turnstile-response'] = raw['cf-turnstile-response'].trim();
  } else if (raw['cf-turnstile-response'] != null && raw['cf-turnstile-response'] !== '') {
    return { value: null, error: 'cf-turnstile-response must be a non-empty string' };
  }

  return { value: canonical, error: null };
}

async function verifyTurnstileToken(
  token: string,
  request: Request,
  env: Env,
): Promise<boolean> {
  const formData = new URLSearchParams();
  formData.set('secret', env.TURNSTILE_SECRET_KEY);
  formData.set('response', token);
  formData.set('remoteip', getClientIp(request));

  try {
    const response = await fetch(TURNSTILE_VERIFY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formData.toString(),
    });

    if (!response.ok) return false;
    const payload = await response.json() as TurnstileVerifyResponse;
    if (payload.success !== true) return false;
    if (stripPort(payload.hostname ?? '') !== getExpectedHostname(request)) return false;
    if (payload.action !== DMV_TURNSTILE_ACTION) return false;
    return true;
  } catch (error) {
    console.error('[turnstile] siteverify failed', error);
    return false;
  }
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
      const rlKey = `${clientIp}:${path}`;
      const { success } = await env.API_RATE_LIMITER.limit({ key: rlKey });
      if (!success) {
        emitError('429');
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
        path,
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
        path,
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
  // and R2 both tolerate redundant puts for the same key.
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
//  /api/register — browser Turnstile + shared CF limits + local fingerprint
//  cooldown + upstream Supabase proxy
// ─────────────────────────────────────────────────────────────────────────────

const REGISTER_FORWARD_REQUEST_HEADERS = [
  'content-type',
  'accept',
  'accept-encoding',
  'accept-language',
  'user-agent',
] as const;

const REGISTER_RESPONSE_HEADERS_TO_STRIP = new Set([
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

function emitRegisterAnalytics(
  env: Env,
  tier: string,
  key: string,
  latencyMs: number,
  sizeBytes = 0,
): void {
  emitAnalytics(env, {
    category: 'register',
    tier,
    path: DMV_REGISTER_PATH,
    key,
    latencyMs,
    sizeBytes,
  });
}

async function handleRegister(request: Request, env: Env): Promise<Response> {
  const startedAt = Date.now();
  const method = request.method;

  if (method !== 'POST') {
    emitRegisterAnalytics(env, '405', method, Date.now() - startedAt);
    return new Response('Method Not Allowed', {
      status: 405,
      headers: {
        Allow: 'POST',
        'Content-Type': 'text/plain; charset=utf-8',
      },
    });
  }

  let parsedBody: CanonicalRegisterBody | null = null;
  try {
    const body = await request.json();
    const parsed = parseRegisterBody(body);
    if (parsed.error || !parsed.value) {
      emitRegisterAnalytics(env, 'validation', parsed.error ?? 'invalid_request', Date.now() - startedAt);
      return jsonResponse({ error: parsed.error ?? 'invalid_request' }, 400);
    }
    parsedBody = parsed.value;
  } catch {
    emitRegisterAnalytics(env, 'invalid_json', 'invalid_json', Date.now() - startedAt);
    return jsonResponse({ error: 'Invalid JSON' }, 400);
  }

  const clientIp = getClientIp(request);
  const emailHash = await sha256Hex(parsedBody.email);
  const ipHash = await sha256Hex(clientIp);
  const ipEmailHash = await sha256Hex(`${ipHash}:${emailHash}`);

  if (parsedBody.signup_source === 'ui') {
    const token = parsedBody['cf-turnstile-response'];
    if (!token) {
      emitRegisterAnalytics(env, 'turnstile_required', emailHash, Date.now() - startedAt);
      return jsonResponse(
        {
          error: 'turnstile_required',
          message: 'Verification failed. Please retry.',
        },
        400,
      );
    }

    const turnstileValid = await verifyTurnstileToken(token, request, env);
    if (!turnstileValid) {
      emitRegisterAnalytics(env, 'turnstile_failed', emailHash, Date.now() - startedAt);
      return jsonResponse(
        {
          error: 'turnstile_failed',
          message: 'Verification failed. Please retry.',
        },
        400,
      );
    }
  } else {
    if (!parsedBody.machine_fingerprint) {
      emitRegisterAnalytics(env, 'machine_fingerprint_required', emailHash, Date.now() - startedAt);
      return jsonResponse(
        {
          error: 'machine_fingerprint_required',
          message: 'machine_fingerprint is required for CLI and MCP registration',
        },
        400,
      );
    }
  }

  const [emailLimit, ipEmailLimit] = await Promise.all([
    env.RL_OTP_EMAIL.limit({ key: `otp:email:${emailHash}` }),
    env.RL_OTP_IP_EMAIL.limit({ key: `otp:ip-email:${ipEmailHash}` }),
  ]);

  if (!emailLimit.success || !ipEmailLimit.success) {
    emitRegisterAnalytics(env, 'rate_limited', emailHash, Date.now() - startedAt);
    return jsonResponse(
      {
        error: 'rate_limited',
        message: 'Too many requests. Please wait 60 seconds and try again.',
        retry_after_seconds: 60,
      },
      429,
      { 'Retry-After': '60' },
    );
  }

  if (parsedBody.signup_source !== 'ui' && parsedBody.machine_fingerprint) {
    const fingerprintHash = await sha256Hex(parsedBody.machine_fingerprint);
    const cooldown = await incrementKvCooldown(
      env.REGISTER_COOLDOWN_KV,
      `dmv:register:fingerprint:${fingerprintHash}`,
      FINGERPRINT_COOLDOWN_THRESHOLD,
      FINGERPRINT_COOLDOWN_SECONDS,
    );

    if (cooldown !== null) {
      emitRegisterAnalytics(env, 'fingerprint_cooldown', fingerprintHash, Date.now() - startedAt);
      return jsonResponse(
        {
          error: 'fingerprint_cooldown',
          message: 'Too many registrations from this machine. Please wait before trying again.',
          retry_after_seconds: cooldown,
        },
        429,
        { 'Retry-After': String(cooldown) },
      );
    }
  }

  const upstreamHeaders = new Headers();
  for (const name of REGISTER_FORWARD_REQUEST_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) upstreamHeaders.set(name, value);
  }
  upstreamHeaders.set('x-forwarded-for', clientIp);
  upstreamHeaders.set('x-forwarded-host', new URL(request.url).host);
  upstreamHeaders.set('x-forwarded-proto', new URL(request.url).protocol.replace(':', ''));
  upstreamHeaders.set('x-dmv-proxy', 'v1');

  const upstreamBody = {
    agent_name: parsedBody.agent_name,
    email: parsedBody.email,
    operator_name: parsedBody.operator_name,
    organization_name: parsedBody.organization_name,
    description: parsedBody.description,
    signup_source: parsedBody.signup_source,
    registration_type: parsedBody.registration_type,
    machine_fingerprint: parsedBody.machine_fingerprint,
  };

  const upstream = await fetch(`${SUPABASE_FUNCTIONS_ORIGIN}/register-agent`, {
    method: 'POST',
    headers: upstreamHeaders,
    body: JSON.stringify(upstreamBody),
  });

  const bodyText = await upstream.text();
  const responseHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!REGISTER_RESPONSE_HEADERS_TO_STRIP.has(key.toLowerCase())) {
      responseHeaders.set(key, value);
    }
  });

  emitRegisterAnalytics(
    env,
    upstream.ok ? 'supabase' : `supabase_${upstream.status}`,
    emailHash,
    Date.now() - startedAt,
    bodyText.length,
  );

  return new Response(bodyText, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

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
        'Content-Security-Policy': PERMALINK_CSP,
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
      'Content-Security-Policy': PERMALINK_CSP,
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

async function handleBadge(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  if (buffer) {
    // Background KV write, tethered to ctx.waitUntil so the runtime keeps
    // the work alive past response return. Matches the putL1() pattern
    // used by handleRender's L1/L2 cache writes.
    const contentType = upstream.headers.get('content-type') ?? 'image/svg+xml';
    const status = upstream.status;
    ctx.waitUntil(
      env.BADGE_CACHE_KV
        .put(kvKey, buffer, {
          expirationTtl: 600, // 10 minutes
          metadata: { contentType, status },
        })
        .catch((err) => {
          console.error('[badge] KV put failed', { kvKey, err });
        }),
    );
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

async function handleHealthz(env: Env): Promise<Response> {
  // Ping the singleton container so we exercise the full path.
  try {
    const container = getContainer(env.CARD_RENDERER, CONTAINER_INSTANCE_ID);
    const containerResp = await container.fetch('http://container/healthz');
    // Parse the container's JSON response and embed it so callers see
    // renderer_version / uptime_ms / node without needing direct container
    // access. `container` is normalised to an object in every branch so
    // probes can consistently read `.status` without polymorphism.
    let containerPayload: unknown;
    try {
      containerPayload = containerResp.ok ? await containerResp.json() : null;
    } catch {
      containerPayload = null;
    }
    let containerField: unknown;
    if (containerResp.ok) {
      // Rich JSON from Task 9+ container, OR a sentinel for an older
      // container that returns text (the parse-fallback branch). The
      // `legacy: true` flag lets probes detect a mis-built or rolled-back
      // container image that returns 200 but no structured payload.
      containerField = containerPayload ?? { status: 'ok', legacy: true };
    } else {
      containerField = {
        status: 'error',
        http: containerResp.status,
      };
    }
    return new Response(
      JSON.stringify({ worker: 'ok', container: containerField }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        worker: 'ok',
        container: { status: 'error', message: (err as Error).message },
      }),
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

    if (url.pathname === DMV_REGISTER_PATH) return handleRegister(request, env);

    // /api/card → container-rendered 880x630 PNG with R2 cache
    if (url.pathname === '/api/card') return handleCard(request, env, ctx);

    // /api/og → SAME container renderer, composited onto 1200x630 for OG/Twitter
    if (url.pathname === '/api/og') return handleOg(request, env, ctx);

    // /badge/* → Supabase Edge Function proxy
    if (url.pathname.startsWith('/badge/') || url.pathname === '/badge') {
      return handleBadge(request, env, ctx);
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
