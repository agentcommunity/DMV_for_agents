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
