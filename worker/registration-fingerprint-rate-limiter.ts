import {
  FINGERPRINT_PENDING_HORIZON_SECONDS,
  FINGERPRINT_COOLDOWN_SECONDS,
  FINGERPRINT_COOLDOWN_THRESHOLD,
} from './register-fingerprint-cooldown';

const STATE_KEY = 'fingerprint-budget';
const WINDOW_MILLISECONDS = FINGERPRINT_COOLDOWN_SECONDS * 1_000;
const PENDING_HORIZON_MILLISECONDS = FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000;

interface FingerprintBudgetState {
  successes: Array<number>;
  pending: Array<{ claimId: string; claimedAt: number }>;
}

function hasExactKeys(record: Record<string, unknown>, keys: Array<string>): boolean {
  return Object.keys(record).sort().join(',') === [...keys].sort().join(',');
}

function isBudgetState(value: unknown): value is FingerprintBudgetState {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return hasExactKeys(record, ['pending', 'successes'])
    && Array.isArray(record.successes)
    && record.successes.every((timestamp) => Number.isSafeInteger(timestamp) && timestamp >= 0)
    && Array.isArray(record.pending)
    && record.pending.every((claim) => {
      if (!claim || typeof claim !== 'object') return false;
      const pending = claim as Record<string, unknown>;
      return hasExactKeys(pending, ['claimId', 'claimedAt'])
        && typeof pending.claimId === 'string'
        && pending.claimId.length > 0
        && Number.isSafeInteger(pending.claimedAt)
        && (pending.claimedAt as number) >= 0;
    })
    && new Set(
      (record.pending as Array<{ claimId: string }>).map((claim) => claim.claimId),
    ).size === record.pending.length;
}

function pruneSuccesses(successes: Array<number>, now: number): Array<number> {
  const cutoff = now - WINDOW_MILLISECONDS;
  return successes.filter((timestamp) => timestamp > cutoff).sort((left, right) => left - right);
}

function reconcileState(state: FingerprintBudgetState, now: number): FingerprintBudgetState {
  const claimCutoff = now - PENDING_HORIZON_MILLISECONDS;
  const abandoned = state.pending.filter((claim) => claim.claimedAt <= claimCutoff);
  return {
    successes: pruneSuccesses(
      [
        ...state.successes,
        ...abandoned.map((claim) => claim.claimedAt + PENDING_HORIZON_MILLISECONDS),
      ],
      now,
    ),
    pending: state.pending.filter((claim) => claim.claimedAt > claimCutoff),
  };
}

function retryAfterSeconds(successes: Array<number>, now: number): number {
  if (successes.length === 0) return 1;
  return Math.max(1, Math.ceil((successes[0] + WINDOW_MILLISECONDS - now) / 1_000));
}

function badRequest(): Response {
  return Response.json({ error: 'bad_request' }, { status: 400 });
}

export class RegistrationFingerprintRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return badRequest();
    const path = new URL(request.url).pathname;
    if (path === '/claim' && request.body === null) return this.claim();
    if (path === '/complete' && request.body !== null) return this.complete(request);
    return badRequest();
  }

  async alarm(): Promise<void> {
    await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      if (stored === undefined) {
        await transaction.deleteAlarm();
        return;
      }
      if (!isBudgetState(stored)) throw new Error('invalid fingerprint budget state');

      const now = Date.now();
      const next = reconcileState(stored, now);
      await this.persist(transaction, next);
    });
  }

  private async claim(): Promise<Response> {
    const decision = await this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const stored = await transaction.get<unknown>(STATE_KEY);
      if (stored !== undefined && !isBudgetState(stored)) {
        throw new Error('invalid fingerprint budget state');
      }
      const current = reconcileState(
        stored ?? { successes: [], pending: [] },
        now,
      );
      if (current.successes.length + current.pending.length >= FINGERPRINT_COOLDOWN_THRESHOLD) {
        await this.persist(transaction, current);
        return {
          allowed: false,
          retry_after_seconds: retryAfterSeconds(
            [
              ...current.successes,
              ...current.pending.map(
                (claim) => claim.claimedAt + PENDING_HORIZON_MILLISECONDS,
              ),
            ].sort((left, right) => left - right),
            now,
          ),
        } as const;
      }

      const claimId = crypto.randomUUID();
      await this.persist(transaction, {
        successes: current.successes,
        pending: [...current.pending, { claimId, claimedAt: now }],
      });
      return { allowed: true, claim_id: claimId } as const;
    });

    return Response.json(decision);
  }

  private async complete(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return badRequest();
    }
    if (!body || typeof body !== 'object') return badRequest();
    const record = body as Record<string, unknown>;
    if (
      !hasExactKeys(record, ['claim_id', 'minted'])
      || typeof record.claim_id !== 'string'
      || record.claim_id.length === 0
      || typeof record.minted !== 'boolean'
    ) {
      return badRequest();
    }

    const completed = await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(STATE_KEY);
      if (stored === undefined || !isBudgetState(stored)) return false;
      const current = reconcileState(stored, Date.now());
      if (!current.pending.some((claim) => claim.claimId === record.claim_id)) {
        await this.persist(transaction, current);
        return false;
      }

      const now = Date.now();
      const successes = pruneSuccesses(current.successes, now);
      if (record.minted === true) successes.push(now);
      await this.persist(transaction, {
        successes,
        pending: current.pending.filter((claim) => claim.claimId !== record.claim_id),
      });
      return true;
    });

    return completed ? new Response(null, { status: 204 }) : Response.json(
      { error: 'unknown_claim' },
      { status: 409 },
    );
  }

  private async persist(
    transaction: DurableObjectTransaction,
    state: FingerprintBudgetState,
  ): Promise<void> {
    if (state.successes.length === 0 && state.pending.length === 0) {
      await transaction.delete(STATE_KEY);
      await transaction.deleteAlarm();
      return;
    }
    await transaction.put(STATE_KEY, state);
    const nextSuccessExpiry = state.successes.length > 0
      ? state.successes[0] + WINDOW_MILLISECONDS
      : Number.POSITIVE_INFINITY;
    const nextClaimExpiry = state.pending.length > 0
      ? Math.min(...state.pending.map(
        (claim) => claim.claimedAt + FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000,
      ))
      : Number.POSITIVE_INFINITY;
    const nextAlarm = Math.min(nextSuccessExpiry, nextClaimExpiry);
    if (Number.isFinite(nextAlarm)) {
      await transaction.setAlarm(nextAlarm);
    } else {
      await transaction.deleteAlarm();
    }
  }
}
