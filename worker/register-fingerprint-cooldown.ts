// Composes the machine-fingerprint cooldown gate around a single upstream
// registration call. Pulled out of handleRegister (worker/index.ts) into its
// own module — with no `./container-instance` import — specifically so this
// ordering can be unit-tested without pulling in the Container/Durable
// Object machinery that makes the rest of worker/index.ts hard to import in
// tests (container-instance.ts is generated at build time and isn't
// committed).
//
// The whole point of this module is the ORDER of operations:
//   1. check (read-only) BEFORE calling upstream at all — an attempt that's
//      already over budget must never reach register-agent.
//   2. call upstream.
//   3. increment AFTER upstream, and only when the response is an actual
//      new certificate mint — never for a 4xx/5xx failure, and never for an
//      `already_recorded` replay (which mints nothing new).
// Getting this order wrong (e.g. incrementing before the upstream call, or
// incrementing regardless of outcome) is exactly the bug this module fixes;
// see tests/worker-register-fingerprint-cooldown.test.ts.

import { isNewCertificateMint } from './registration-upstream';

// Single source of truth for the fingerprint-cooldown budget. Kept here
// (rather than as a local const in worker/index.ts, which cannot be
// imported by tests — see the module comment above) so the number that
// governs production behavior is the same number the test suite pins down.
// Allow 3 successful registrations per machine fingerprint in a rolling 24h
// window; block the 4th and later attempts until the window expires. Only
// successful mints (upstream 201, not an `already_recorded` replay) consume
// budget. With checkKvCooldown blocking at count >= threshold and
// incrementKvCooldown only running after a successful mint, a threshold of 3
// means: mints 1-3 each see count < 3 at check-time and succeed, bringing
// count to 3; the 4th request's check then sees count >= 3 and blocks before
// ever calling upstream. (threshold=4 was the bug: it let 4 successful mints
// through and only blocked the 5th — see
// tests/worker-register-fingerprint-cooldown.test.ts for the pinned budget.)
export const FINGERPRINT_COOLDOWN_THRESHOLD = 3;
export const FINGERPRINT_COOLDOWN_SECONDS = 24 * 60 * 60;

export interface FingerprintCooldownGate {
  check(key: string, threshold: number, cooldownSeconds: number): Promise<number | null>;
  increment(key: string, threshold: number, cooldownSeconds: number): Promise<number | null>;
}

export type FingerprintGatedUpstreamResult =
  | { blocked: true; retryAfterSeconds: number }
  | { blocked: false; upstream: Response; bodyText: string };

/**
 * Runs `callUpstream` behind a fingerprint cooldown gate.
 *
 * `cooldownKey` is null when fingerprint cooldown gating doesn't apply to
 * this request (e.g. UI/Turnstile signups don't carry a machine
 * fingerprint) — in that case upstream is always called and the gate is
 * never touched.
 */
export async function runFingerprintGatedUpstream(
  gate: FingerprintCooldownGate,
  cooldownKey: string | null,
  threshold: number,
  cooldownSeconds: number,
  callUpstream: () => Promise<Response>,
): Promise<FingerprintGatedUpstreamResult> {
  if (cooldownKey !== null) {
    const blockedFor = await gate.check(cooldownKey, threshold, cooldownSeconds);
    if (blockedFor !== null) {
      return { blocked: true, retryAfterSeconds: blockedFor };
    }
  }

  const upstream = await callUpstream();
  const bodyText = await upstream.clone().text();

  if (cooldownKey !== null && isNewCertificateMint(upstream.status, bodyText)) {
    await gate.increment(cooldownKey, threshold, cooldownSeconds);
  }

  return { blocked: false, upstream, bodyText };
}
