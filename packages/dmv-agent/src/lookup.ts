// Certificate verification — live issuance lookup against the DMV Worker,
// with an offline check-digit fallback.
//
// The Worker's public `/api/lookup` endpoint is the single source of truth for
// "does this certificate exist in the database". The Luhn mod-36 check digit
// (see certificate.ts) only proves the ID is *well-formed* — it says nothing
// about whether the certificate was ever issued. Callers that need a live
// answer (the `verify_certificate` MCP tool, `dmv-agent verify`) should use
// `verifyCertificate()` here rather than `verifyCertificateId()` directly.

import { verifyCertificateId } from './certificate.js';

/** Which check actually produced this result. */
export type CertificateCheckMode = 'live' | 'format_only';

/** Mirrors worker/certificate-lookup.ts CertificateLookupStatus. */
export type CertificateLookupStatus = 'invalid_format' | 'not_found' | 'issued' | 'unavailable';

export interface CertificateVerificationResult {
  certificateId: string;
  /** Whether the Luhn mod-36 check digit is valid. Always computed, regardless of mode. */
  formatValid: boolean;
  /** 'live' = the DMV database was actually queried. 'format_only' = no network call was made. */
  checkMode: CertificateCheckMode;
  /** Only set when checkMode === 'live'. */
  status?: CertificateLookupStatus;
  issued?: boolean | null;
  agentName?: string | null;
  certificateUrl?: string | null;
  /**
   * Set only when a live check was requested but could not complete (network error,
   * timeout, or a malformed response) and the tool fell back to the offline format
   * check instead. Its presence is what distinguishes an intentional format-only
   * request from an unintended fallback.
   */
  fallbackReason?: string;
  /**
   * Set when the Worker itself answered with HTTP 429 (its own request, not the
   * fallback path — the live check DID run, it was just throttled). The Worker's
   * 429 body is `{error: "rate_limited", retry_after_seconds}` with no `status`
   * field (see worker/certificate-lookup.ts), so this is reported distinctly from
   * both a normal live result and a network-failure fallback.
   */
  rateLimited?: boolean;
  /** Only set when rateLimited is true and the Worker's body included it. */
  retryAfterSeconds?: number;
}

export interface VerifyCertificateOptions {
  /** Skip the network call entirely and only check the offline Luhn check digit. */
  formatOnly?: boolean;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'https://dmv.agentcommunity.org';
const DEFAULT_TIMEOUT_MS = 8_000;

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
}

function hasExactKeys(record: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',');
}

const PUBLIC_RESULT_KEYS = [
  'certificate_id',
  'status',
  'valid_format',
  'issued',
  'agent_name',
  'certificate_url',
];

function isExactIssuedEnvelope(
  record: Record<string, unknown>,
  certificateId: string,
): record is Record<string, unknown> & { agent_name: string; certificate_url: string } {
  if (!hasExactKeys(record, PUBLIC_RESULT_KEYS)) return false;
  if (
    record.certificate_id !== certificateId
    || record.status !== 'issued'
    || record.valid_format !== true
    || record.issued !== true
    || typeof record.agent_name !== 'string'
    || record.agent_name.trim().length === 0
    || typeof record.certificate_url !== 'string'
  ) {
    return false;
  }
  const expectedUrl = `${DEFAULT_BASE_URL}/c/${encodeURIComponent(certificateId)}/${encodeURIComponent(record.agent_name)}`;
  return record.certificate_url === expectedUrl;
}

function isExactEmptyEnvelope(
  record: Record<string, unknown>,
  certificateId: string,
  status: 'not_found' | 'unavailable',
): boolean {
  return hasExactKeys(record, PUBLIC_RESULT_KEYS)
    && record.certificate_id === certificateId
    && record.status === status
    && record.valid_format === true
    && record.issued === (status === 'not_found' ? false : null)
    && record.agent_name === null
    && record.certificate_url === null;
}

function parseRateLimitEnvelope(record: Record<string, unknown>): number | null {
  if (!hasExactKeys(record, ['error', 'retry_after_seconds'])) return null;
  if (record.error !== 'rate_limited') return null;
  if (!Number.isSafeInteger(record.retry_after_seconds)) return null;
  const retryAfterSeconds = record.retry_after_seconds as number;
  return retryAfterSeconds >= 1 && retryAfterSeconds <= 60 ? retryAfterSeconds : null;
}

/**
 * Verify a DMV certificate ID.
 *
 * By default this performs a **live issuance check** against the public
 * `GET /api/lookup` endpoint on the DMV Worker — it confirms whether a
 * matching registration row exists (rate-limited ~30/60s per IP by the
 * Worker). `issued: true` means a row exists; it does not mean the operator
 * completed email verification or that DNS delegation exists.
 *
 * If the live check cannot complete (network error, timeout, or a malformed
 * response), this function automatically falls back to the offline Luhn
 * check-digit validation and sets `fallbackReason` so callers can label the
 * result accordingly — a network failure must never be reported as "not
 * issued".
 *
 * Pass `formatOnly: true` to skip the network call entirely and only run the
 * offline check-digit validation (matches `verifyCertificateId`).
 */
export async function verifyCertificate(
  certificateId: string,
  options: VerifyCertificateOptions = {},
): Promise<CertificateVerificationResult> {
  const {
    formatOnly = false,
    baseUrl = process.env.DMV_BASE_URL ?? DEFAULT_BASE_URL,
    fetchFn = fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const formatValid = verifyCertificateId(certificateId);

  if (formatOnly) {
    return { certificateId, formatValid, checkMode: 'format_only' };
  }

  // The Worker rejects a malformed ID before ever touching the database, and
  // charges no rate-limit budget for it either way — mirror that locally
  // instead of spending a network round trip to learn what we already know.
  if (!formatValid) {
    return {
      certificateId,
      formatValid: false,
      checkMode: 'live',
      status: 'invalid_format',
      issued: false,
      agentName: null,
      certificateUrl: null,
    };
  }

  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(
      `${normalizedBaseUrl}/api/lookup?id=${encodeURIComponent(certificateId)}`,
      { method: 'GET', redirect: 'manual', signal: controller.signal },
    );

    const text = await response.text();

    const contentType = response.headers.get('content-type') ?? '';
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) {
      throw new Error(`lookup returned a non-JSON response (HTTP ${response.status})`);
    }

    let json: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('response body is not an object');
      }
      json = parsed as Record<string, unknown>;
    } catch {
      throw new Error(`lookup returned invalid JSON (HTTP ${response.status})`);
    }

    // The Worker's rate-limit response (`{error: "rate_limited", retry_after_seconds}`,
    // both the coarse Cloudflare limiter and the exact Durable Object one — see
    // worker/certificate-lookup.ts:245-271) has no `status` field. Handle it before
    // the generic shape check below, so a 429 is never mislabeled as "malformed" —
    // the live check DID run, it was just throttled.
    if (response.status === 429) {
      const retryAfterSeconds = parseRateLimitEnvelope(json);
      if (retryAfterSeconds === null) {
        throw new Error('lookup returned a malformed rate-limit response (HTTP 429)');
      }
      return {
        certificateId,
        formatValid,
        checkMode: 'live',
        rateLimited: true,
        retryAfterSeconds,
      };
    }

    if (response.status === 200 && isExactIssuedEnvelope(json, certificateId)) {
      return {
        certificateId,
        formatValid,
        checkMode: 'live',
        status: 'issued',
        issued: true,
        agentName: json.agent_name,
        certificateUrl: json.certificate_url,
      };
    }
    if (response.status === 200 && isExactEmptyEnvelope(json, certificateId, 'not_found')) {
      return {
        certificateId,
        formatValid,
        checkMode: 'live',
        status: 'not_found',
        issued: false,
        agentName: null,
        certificateUrl: null,
      };
    }
    if (response.status === 503 && isExactEmptyEnvelope(json, certificateId, 'unavailable')) {
      return {
        certificateId,
        formatValid,
        checkMode: 'live',
        status: 'unavailable',
        issued: null,
        agentName: null,
        certificateUrl: null,
      };
    }
    throw new Error(`lookup returned an inconsistent response (HTTP ${response.status})`);
  } catch (err) {
    const reason = err instanceof Error && err.name === 'AbortError'
      ? `timed out after ${timeoutMs}ms`
      : err instanceof Error
        ? err.message
        : String(err);
    return {
      certificateId,
      formatValid,
      checkMode: 'format_only',
      fallbackReason: reason,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Render a `CertificateVerificationResult` as a human-readable line (or two).
 * Shared by the CLI and MCP server so both surfaces describe outcomes identically.
 */
export function formatVerificationResult(result: CertificateVerificationResult): string {
  if (result.rateLimited) {
    const retrySuffix = typeof result.retryAfterSeconds === 'number'
      ? ` Retry after ${result.retryAfterSeconds}s.`
      : '';
    return [
      `? Certificate ${result.certificateId}: live issuance check is rate limited right now.${retrySuffix}`,
      `  This is inconclusive, not a negative result — the request was throttled, not answered.`,
    ].join('\n');
  }

  if (result.checkMode === 'format_only') {
    const headline = result.formatValid
      ? `✓ Certificate ${result.certificateId} has a valid check digit.`
      : `✗ Certificate ${result.certificateId} has an invalid check digit.`;

    if (result.fallbackReason) {
      return [
        `${headline} (format-only — live issuance check unavailable)`,
        `  Live check could not run: ${result.fallbackReason}.`,
        `  This does NOT mean the certificate is unissued — only that live confirmation was not possible.`,
      ].join('\n');
    }

    return `${headline} (format-only check — does not confirm the certificate was issued)`;
  }

  switch (result.status) {
    case 'issued':
      return [
        `✓ Certificate ${result.certificateId} is issued (live check).`,
        `  Agent: ${result.agentName}.agent`,
        result.certificateUrl ? `  View: ${result.certificateUrl}` : undefined,
      ].filter(Boolean).join('\n');
    case 'not_found':
      return `✗ Certificate ${result.certificateId} has a valid check digit but is not registered in the DMV database (live check).`;
    case 'invalid_format':
      return `✗ Certificate ${result.certificateId} has an invalid check digit (format check — no network call was made).`;
    case 'unavailable':
      return [
        `? Certificate ${result.certificateId}: live issuance could not be confirmed right now (DMV lookup service unavailable).`,
        `  This is NOT a "not issued" result — the database was not reachable, not queried-and-empty.`,
      ].join('\n');
    default:
      return `? Certificate ${result.certificateId}: unrecognized lookup response.`;
  }
}

/**
 * Exit-code convention shared by the CLI: 0 = confirmed good, 1 = confirmed
 * bad/absent, 2 = inconclusive (no confirmation either way was possible).
 */
export function exitCodeForVerification(result: CertificateVerificationResult): 0 | 1 | 2 {
  if (result.rateLimited) return 2;
  if (result.checkMode === 'format_only') {
    if (result.fallbackReason) return 2;
    return result.formatValid ? 0 : 1;
  }
  switch (result.status) {
    case 'issued':
      return 0;
    case 'not_found':
    case 'invalid_format':
      return 1;
    case 'unavailable':
    default:
      return 2;
  }
}
