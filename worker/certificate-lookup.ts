import { normalizeCertificateId, verifyCertificateId } from './certificate';
import {
  CERTIFICATE_LOOKUP_LIMIT,
  type CertificateLookupRateLimitDecision,
} from './certificate-lookup-rate-limiter';

export const LOOKUP_LIMIT = CERTIFICATE_LOOKUP_LIMIT;
export const LOOKUP_WINDOW_SECONDS = 60;
export const LOOKUP_POSITIVE_TTL_SECONDS = 300;
export const LOOKUP_NEGATIVE_TTL_SECONDS = 60;

const SUPABASE_FUNCTIONS_ORIGIN =
  'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1';
const LOOKUP_TIMEOUT_MILLISECONDS = 5_000;

interface LookupEnv {
  RL_CERT_LOOKUP: { limit(options: { key: string }): Promise<{ success: boolean }> };
  CERT_LOOKUP_LIMITER: DurableObjectNamespace;
  BADGE_CACHE_KV: KVNamespace;
  DMV_PROXY_SECRET?: string;
}

export type CertificateLookupStatus = 'invalid_format' | 'not_found' | 'issued' | 'unavailable';

export interface CertificateLookupResult {
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

function isRateLimitDecision(result: unknown): result is CertificateLookupRateLimitDecision {
  if (!result || typeof result !== 'object') return false;
  const record = result as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'allowed,remaining,reset') return false;
  if (typeof record.allowed !== 'boolean') return false;
  if (!Number.isInteger(record.remaining)) return false;
  if (!Number.isInteger(record.reset)) return false;
  if ((record.remaining as number) < 0 || (record.remaining as number) >= LOOKUP_LIMIT) return false;
  if ((record.reset as number) < 1 || (record.reset as number) > LOOKUP_WINDOW_SECONDS) return false;
  return record.allowed || record.remaining === 0;
}

function hasExactKeys(record: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',');
}

function isNotFoundEnvelope(record: Record<string, unknown>, requestedId: string): boolean {
  return hasExactKeys(record, ['status', 'certificate_id'])
    && record.status === 'not_found'
    && record.certificate_id === requestedId;
}

function isIssuedEnvelope(record: Record<string, unknown>, requestedId: string): boolean {
  return hasExactKeys(record, ['status', 'certificate_id', 'agent_name', 'domain'])
    && record.status === 'issued'
    && record.certificate_id === requestedId
    && typeof record.agent_name === 'string'
    && record.agent_name.trim().length > 0
    && typeof record.domain === 'string'
    && record.domain.trim().length > 0;
}

async function consumeExactRateLimit(
  namespace: DurableObjectNamespace,
  ipHash: string,
  now: number,
): Promise<CertificateLookupRateLimitDecision | null> {
  try {
    const objectId = namespace.idFromName(ipHash);
    const stub = namespace.get(objectId);
    const response = await stub.fetch(
      new Request('https://certificate-lookup-rate-limiter.internal/consume', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ now }),
      }),
    );
    if (response.status !== 200) return null;
    const result: unknown = await response.json();
    return isRateLimitDecision(result) ? result : null;
  } catch (error) {
    console.error('[certificate-lookup] exact limiter failed', { error });
    return null;
  }
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
  let ipHash: string;
  try {
    ipHash = await hashIp(ip);
  } catch (error) {
    console.error('[certificate-lookup] IP hashing failed', { error });
    return jsonResponse(unavailableResult(id), 503, 0, secondsUntilNextMinute());
  }

  try {
    const cloudflareResult = await env.RL_CERT_LOOKUP.limit({ key: `${ipHash}:/api/lookup` });
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
    console.error('[certificate-lookup] Cloudflare limiter failed', { error });
  }

  const now = Date.now();
  const exactLimit = await consumeExactRateLimit(env.CERT_LOOKUP_LIMITER, ipHash, now);

  if (!exactLimit) {
    return jsonResponse(unavailableResult(id), 503, 0, secondsUntilNextMinute(now));
  }
  if (!exactLimit.allowed) {
    return jsonResponse(
      { error: 'rate_limited', retry_after_seconds: exactLimit.reset },
      429,
      0,
      exactLimit.reset,
      { 'Retry-After': String(exactLimit.reset) },
    );
  }

  const remaining = exactLimit.remaining;
  const reset = exactLimit.reset;
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
        redirect: 'error',
        signal: controller.signal,
      },
    );

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
    if (isNotFoundEnvelope(upstreamRecord, id)) {
      const result = notFoundResult(id);
      await cacheResult(env.BADGE_CACHE_KV, cacheKey, result, LOOKUP_NEGATIVE_TTL_SECONDS);
      return jsonResponse(result, 200, remaining, reset);
    }
    if (!isIssuedEnvelope(upstreamRecord, id)) {
      return jsonResponse(unavailableResult(id), 503, remaining, reset);
    }

    const result = issuedResult(id, upstreamRecord.agent_name as string);
    await cacheResult(env.BADGE_CACHE_KV, cacheKey, result, LOOKUP_POSITIVE_TTL_SECONDS);
    return jsonResponse(result, 200, remaining, reset);
  } catch (error) {
    console.error('[certificate-lookup] upstream lookup failed', { error });
    return jsonResponse(unavailableResult(id), 503, remaining, reset);
  } finally {
    clearTimeout(timeout);
  }
}
