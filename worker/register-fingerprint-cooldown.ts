// Coordinates registration upstream calls with one exact Durable Object budget
// per SHA-256 machine-fingerprint hash. The object reserves a slot before any
// upstream work begins, so concurrent requests cannot all observe the same
// pre-increment count. A claim is completed only for a well-formed fresh mint
// or an audited pre-INSERT/replay outcome; every uncertain result stays pending.

import { classifyRegistrationOutcome } from './registration-upstream';

export const FINGERPRINT_COOLDOWN_THRESHOLD = 3;
export const FINGERPRINT_COOLDOWN_SECONDS = 24 * 60 * 60;
// Current hosted Supabase limits are 150 seconds before an idle request gets a
// 504 and up to 400 seconds of Edge Function wall-clock runtime. The Worker
// may stop awaiting after 45 seconds, but that local abort does not prove the
// remote function stopped. Reserve enough time for the full gateway/queue
// allowance, a fresh remote isolate's full wall clock, and an explicit margin.
export const SUPABASE_REQUEST_IDLE_TIMEOUT_SECONDS = 150;
export const SUPABASE_EDGE_FUNCTION_WALL_CLOCK_SECONDS = 400;
export const FINGERPRINT_REMOTE_EXECUTION_SAFETY_MARGIN_SECONDS = 50;
const MINIMUM_PENDING_HORIZON_SECONDS = SUPABASE_REQUEST_IDLE_TIMEOUT_SECONDS
  + SUPABASE_EDGE_FUNCTION_WALL_CLOCK_SECONDS
  + FINGERPRINT_REMOTE_EXECUTION_SAFETY_MARGIN_SECONDS;
export const FINGERPRINT_PENDING_HORIZON_SECONDS: number = 600;
if (FINGERPRINT_PENDING_HORIZON_SECONDS < MINIMUM_PENDING_HORIZON_SECONDS) {
  throw new Error('fingerprint pending horizon does not cover remote execution uncertainty');
}
export const FINGERPRINT_MAX_RETRY_AFTER_SECONDS = FINGERPRINT_COOLDOWN_SECONDS
  + FINGERPRINT_PENDING_HORIZON_SECONDS;
// Abort only bounds how long the public Worker awaits a response. A timeout is
// ambiguous, so the claim remains pending until the conservative horizon and
// is then counted as a possible success for a full rolling 24 hours.
export const FINGERPRINT_UPSTREAM_DEADLINE_MILLISECONDS = 45_000;

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

export function fingerprintCooldownResponse(retryAfterSeconds: number): Response {
  return Response.json(
    {
      error: 'fingerprint_cooldown',
      message: 'Too many registrations from this machine. Please wait before trying again.',
      retry_after_seconds: retryAfterSeconds,
    },
    {
      status: 429,
      headers: { 'Retry-After': String(retryAfterSeconds) },
    },
  );
}

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
    && (record.retry_after_seconds as number) <= FINGERPRINT_MAX_RETRY_AFTER_SECONDS
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
  callUpstream: (signal: AbortSignal) => Promise<Response>,
  options: { deadlineMilliseconds?: number } = {},
): Promise<FingerprintGatedUpstreamResult> {
  if (cooldownKey === null) {
    const upstream = await callUpstream(new AbortController().signal);
    return { blocked: false, upstream, bodyText: await upstream.clone().text() };
  }

  const claim = await gate.claim(cooldownKey);
  if (!claim.allowed) {
    return { blocked: true, retryAfterSeconds: claim.retryAfterSeconds };
  }

  const deadlineMilliseconds = options.deadlineMilliseconds
    ?? FINGERPRINT_UPSTREAM_DEADLINE_MILLISECONDS;
  if (
    !Number.isSafeInteger(deadlineMilliseconds)
    || deadlineMilliseconds < 1
    || deadlineMilliseconds > SUPABASE_REQUEST_IDLE_TIMEOUT_SECONDS * 1_000
  ) {
    throw new Error('fingerprint upstream response deadline must fit within the request idle timeout');
  }

  const controller = new AbortController();
  const deadlineError = new Error('registration upstream deadline exceeded');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        controller.abort(deadlineError);
        reject(deadlineError);
      }, deadlineMilliseconds);
    });
    const upstream = await Promise.race([
      callUpstream(controller.signal),
      deadline,
    ]);
    const bodyText = await upstream.clone().text();
    const outcome = classifyRegistrationOutcome(upstream.status, bodyText);
    if (outcome !== 'ambiguous') {
      await gate.complete(cooldownKey, claim.claimId, outcome === 'minted');
    }
    return { blocked: false, upstream, bodyText };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
