import { normalizeCertificateId, verifyCertificateId } from './certificate';
import { consumeKvBucket } from './rate-limit-kv';

export const LOOKUP_LIMIT = 30;
export const LOOKUP_WINDOW_SECONDS = 60;
export const LOOKUP_POSITIVE_TTL_SECONDS = 300;
export const LOOKUP_NEGATIVE_TTL_SECONDS = 60;

const SUPABASE_FUNCTIONS_ORIGIN =
  'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1';
const LOOKUP_TIMEOUT_MILLISECONDS = 5_000;

interface LookupEnv {
  RL_CERT_LOOKUP: { limit(options: { key: string }): Promise<{ success: boolean }> };
  BADGE_CACHE_KV: KVNamespace;
  REGISTER_COOLDOWN_KV: KVNamespace;
  DMV_PROXY_SECRET?: string;
}

type CertificateLookupStatus = 'invalid_format' | 'not_found' | 'issued' | 'unavailable';

interface CertificateLookupResult {
  certificate_id: string;
  status: CertificateLookupStatus;
  valid_format: boolean;
  issued: boolean | null;
  agent_name: string | null;
  certificate_url: string | null;
}

function secondsUntilNextMinute(now = Date.now()): number {
  const elapsedSeconds = Math.floor(now / 1_000) % LOOKUP_WINDOW_SECONDS;
  return LOOKUP_WINDOW_SECONDS - elapsedSeconds;
}

function responseHeaders(remaining: number, reset: number): Headers {
  return new Headers({
    'Cache-Control': 'private, no-store',
    'Content-Type': 'application/json; charset=utf-8',
    'RateLimit-Limit': String(LOOKUP_LIMIT),
    'RateLimit-Remaining': String(remaining),
    'RateLimit-Reset': String(reset),
  });
}

function jsonResponse(
  body: CertificateLookupResult | Record<string, unknown>,
  status: number,
  remaining: number,
  reset: number,
  extraHeaders?: HeadersInit,
): Response {
  const headers = responseHeaders(remaining, reset);
  if (extraHeaders) {
    new Headers(extraHeaders).forEach((value, key) => headers.set(key, value));
  }
  return new Response(JSON.stringify(body), { status, headers });
}

function invalidFormatResult(id: string): CertificateLookupResult {
  return {
    certificate_id: id,
    status: 'invalid_format',
    valid_format: false,
    issued: false,
    agent_name: null,
    certificate_url: null,
  };
}

function notFoundResult(id: string): CertificateLookupResult {
  return {
    certificate_id: id,
    status: 'not_found',
    valid_format: true,
    issued: false,
    agent_name: null,
    certificate_url: null,
  };
}

function unavailableResult(id: string): CertificateLookupResult {
  return {
    certificate_id: id,
    status: 'unavailable',
    valid_format: true,
    issued: null,
    agent_name: null,
    certificate_url: null,
  };
}

function issuedResult(id: string, agentName: string): CertificateLookupResult {
  return {
    certificate_id: id,
    status: 'issued',
    valid_format: true,
    issued: true,
    agent_name: agentName,
    certificate_url:
      `https://dmv.agentcommunity.org/c/${encodeURIComponent(id)}/${encodeURIComponent(agentName)}`,
  };
}

function parseCachedResult(value: string, requestedId: string): CertificateLookupResult | null {
  try {
    const cached: unknown = JSON.parse(value);
    if (!cached || typeof cached !== 'object') return null;
    const record = cached as Record<string, unknown>;

    if (record.status === 'not_found' && record.certificate_id === requestedId) {
      return notFoundResult(requestedId);
    }
    if (
      record.status === 'issued'
      && record.certificate_id === requestedId
      && typeof record.agent_name === 'string'
      && record.agent_name.length > 0
    ) {
      return issuedResult(requestedId, record.agent_name);
    }
  } catch {
    return null;
  }
  return null;
}

async function hashIp(ip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function cacheResult(
  kv: KVNamespace,
  key: string,
  result: CertificateLookupResult,
  expirationTtl: number,
): Promise<void> {
  try {
    await kv.put(key, JSON.stringify(result), { expirationTtl });
  } catch (error) {
    console.error('[certificate-lookup] result cache write failed', { key, error });
  }
}

export async function handleCertificateLookup(
  request: Request,
  env: LookupEnv,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  if (request.method !== 'GET') {
    const reset = secondsUntilNextMinute();
    return jsonResponse(
      { error: 'method_not_allowed' },
      405,
      LOOKUP_LIMIT,
      reset,
      { Allow: 'GET' },
    );
  }

  const requestUrl = new URL(request.url);
  const id = normalizeCertificateId(requestUrl.searchParams.get('id') ?? '');
  if (!id || !verifyCertificateId(id)) {
    return jsonResponse(
      invalidFormatResult(id),
      400,
      LOOKUP_LIMIT,
      secondsUntilNextMinute(),
    );
  }

  const secret = env.DMV_PROXY_SECRET;
  if (!secret) {
    return jsonResponse(
      unavailableResult(id),
      503,
      LOOKUP_LIMIT,
      secondsUntilNextMinute(),
    );
  }

  const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
  let cloudflareLimiterAvailable = true;
  try {
    const cloudflareResult = await env.RL_CERT_LOOKUP.limit({ key: `${ip}:/api/lookup` });
    if (!cloudflareResult.success) {
      const reset = secondsUntilNextMinute();
      return jsonResponse(
        { error: 'rate_limited', retry_after_seconds: reset },
        429,
        0,
        reset,
        { 'Retry-After': String(reset) },
      );
    }
  } catch (error) {
    cloudflareLimiterAvailable = false;
    console.error('[certificate-lookup] Cloudflare limiter failed', { error });
  }

  const ipHash = await hashIp(ip);
  const now = Date.now();
  const minuteBucket = Math.floor(now / 60_000);
  const reset = secondsUntilNextMinute(now);
  const bucketKey = `dmv:lookup:v1:${ipHash}:${minuteBucket}`;
  const kvLimit = await consumeKvBucket(
    env.REGISTER_COOLDOWN_KV,
    bucketKey,
    LOOKUP_LIMIT,
    LOOKUP_WINDOW_SECONDS,
  );

  if (kvLimit && !kvLimit.allowed) {
    return jsonResponse(
      { error: 'rate_limited', retry_after_seconds: reset },
      429,
      0,
      reset,
      { 'Retry-After': String(reset) },
    );
  }
  if (!cloudflareLimiterAvailable && !kvLimit) {
    return jsonResponse(unavailableResult(id), 503, 0, reset);
  }

  const remaining = kvLimit?.remaining ?? LOOKUP_LIMIT - 1;
  const cacheKey = `lookup:v1:${id}`;
  try {
    const cachedValue = await env.BADGE_CACHE_KV.get(cacheKey);
    if (cachedValue) {
      const cachedResult = parseCachedResult(cachedValue, id);
      if (cachedResult) return jsonResponse(cachedResult, 200, remaining, reset);
    }
  } catch (error) {
    console.error('[certificate-lookup] result cache read failed', { cacheKey, error });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MILLISECONDS);
  try {
    const upstream = await fetchImpl(
      `${SUPABASE_FUNCTIONS_ORIGIN}/lookup-agent?id=${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: { 'x-dmv-proxy': secret },
        signal: controller.signal,
      },
    );

    if (upstream.status === 404) {
      const result = notFoundResult(id);
      await cacheResult(env.BADGE_CACHE_KV, cacheKey, result, LOOKUP_NEGATIVE_TTL_SECONDS);
      return jsonResponse(result, 200, remaining, reset);
    }
    if (upstream.status !== 200) {
      return jsonResponse(unavailableResult(id), 503, remaining, reset);
    }

    let upstreamBody: unknown;
    try {
      upstreamBody = await upstream.json();
    } catch {
      return jsonResponse(unavailableResult(id), 503, remaining, reset);
    }
    if (!upstreamBody || typeof upstreamBody !== 'object') {
      return jsonResponse(unavailableResult(id), 503, remaining, reset);
    }

    const upstreamRecord = upstreamBody as Record<string, unknown>;
    if (
      typeof upstreamRecord.certificate_id !== 'string'
      || upstreamRecord.certificate_id.length === 0
      || typeof upstreamRecord.agent_name !== 'string'
      || upstreamRecord.agent_name.length === 0
    ) {
      return jsonResponse(unavailableResult(id), 503, remaining, reset);
    }

    const result = issuedResult(upstreamRecord.certificate_id, upstreamRecord.agent_name);
    await cacheResult(env.BADGE_CACHE_KV, cacheKey, result, LOOKUP_POSITIVE_TTL_SECONDS);
    return jsonResponse(result, 200, remaining, reset);
  } catch (error) {
    console.error('[certificate-lookup] upstream lookup failed', { error });
    return jsonResponse(unavailableResult(id), 503, remaining, reset);
  } finally {
    clearTimeout(timeout);
  }
}
