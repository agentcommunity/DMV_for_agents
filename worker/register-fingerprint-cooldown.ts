// Coordinates registration upstream calls with one exact Durable Object budget
// per SHA-256 machine-fingerprint hash. The object reserves a slot before any
// upstream work begins, so concurrent requests cannot all observe the same
// pre-increment count. Every claimed slot is then committed for a fresh mint or
// released for a failed/non-mint outcome.

import { isNewCertificateMint } from './registration-upstream';

export const FINGERPRINT_COOLDOWN_THRESHOLD = 3;
export const FINGERPRINT_COOLDOWN_SECONDS = 24 * 60 * 60;
// A completion normally arrives in the same Worker request. If it never does
// (process reset/caller disconnect), the claim becomes a conservative success
// after this lease rather than being released: the upstream may already have
// minted, so release would permit a fourth possible success.
export const FINGERPRINT_CLAIM_LEASE_SECONDS = 60;

export type FingerprintClaimDecision =
  | { allowed: true; claimId: string }
  | { allowed: false; retryAfterSeconds: number };

export interface FingerprintCooldownGate {
  claim(key: string): Promise<FingerprintClaimDecision>;
  complete(key: string, claimId: string, minted: boolean): Promise<void>;
}

export type FingerprintGatedUpstreamResult =
  | { blocked: true; retryAfterSeconds: number }
  | { blocked: false; upstream: Response; bodyText: string };

function hasExactKeys(record: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',');
}

function parseClaimDecision(value: unknown): FingerprintClaimDecision | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  if (
    hasExactKeys(record, ['allowed', 'claim_id'])
    && record.allowed === true
    && typeof record.claim_id === 'string'
    && record.claim_id.length > 0
  ) {
    return { allowed: true, claimId: record.claim_id };
  }
  if (
    hasExactKeys(record, ['allowed', 'retry_after_seconds'])
    && record.allowed === false
    && Number.isSafeInteger(record.retry_after_seconds)
    && (record.retry_after_seconds as number) >= 1
    && (record.retry_after_seconds as number) <= FINGERPRINT_COOLDOWN_SECONDS
  ) {
    return {
      allowed: false,
      retryAfterSeconds: record.retry_after_seconds as number,
    };
  }
  return null;
}

export function createFingerprintCooldownGate(
  namespace: DurableObjectNamespace,
): FingerprintCooldownGate {
  function stubFor(key: string): DurableObjectStub {
    return namespace.get(namespace.idFromName(key));
  }

  return {
    async claim(key) {
      const response = await stubFor(key).fetch(
        new Request('https://registration-fingerprint.internal/claim', { method: 'POST' }),
      );
      if (response.status !== 200) {
        throw new Error(`fingerprint limiter claim failed with HTTP ${response.status}`);
      }
      const decision = parseClaimDecision(await response.json());
      if (!decision) throw new Error('fingerprint limiter returned a malformed claim decision');
      return decision;
    },
    async complete(key, claimId, minted) {
      const response = await stubFor(key).fetch(
        new Request('https://registration-fingerprint.internal/complete', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim_id: claimId, minted }),
        }),
      );
      if (response.status !== 204) {
        throw new Error(`fingerprint limiter completion failed with HTTP ${response.status}`);
      }
    },
  };
}

export async function runFingerprintGatedUpstream(
  gate: FingerprintCooldownGate,
  cooldownKey: string | null,
  callUpstream: () => Promise<Response>,
): Promise<FingerprintGatedUpstreamResult> {
  if (cooldownKey === null) {
    const upstream = await callUpstream();
    return { blocked: false, upstream, bodyText: await upstream.clone().text() };
  }

  const claim = await gate.claim(cooldownKey);
  if (!claim.allowed) {
    return { blocked: true, retryAfterSeconds: claim.retryAfterSeconds };
  }

  let minted = false;
  try {
    const upstream = await callUpstream();
    const bodyText = await upstream.clone().text();
    minted = isNewCertificateMint(upstream.status, bodyText);
    return { blocked: false, upstream, bodyText };
  } finally {
    await gate.complete(cooldownKey, claim.claimId, minted);
  }
}
