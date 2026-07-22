export const CERTIFICATE_LOOKUP_LIMIT = 30;
export const CERTIFICATE_LOOKUP_WINDOW_MILLISECONDS = 60_000;

const BUCKET_KEY = 'certificate-lookup-minute';

interface StoredBucket {
  minute: number;
  count: number;
  resetAt: number;
}

export interface CertificateLookupRateLimitDecision {
  allowed: boolean;
  remaining: number;
  reset: number;
}

function isStoredBucket(value: unknown): value is StoredBucket {
  if (!value || typeof value !== 'object') return false;
  const bucket = value as Record<string, unknown>;
  return Number.isSafeInteger(bucket.minute)
    && Number.isSafeInteger(bucket.count)
    && Number.isSafeInteger(bucket.resetAt)
    && (bucket.minute as number) >= 0
    && (bucket.count as number) >= 1
    && (bucket.count as number) <= CERTIFICATE_LOOKUP_LIMIT
    && (bucket.resetAt as number)
      === ((bucket.minute as number) + 1) * CERTIFICATE_LOOKUP_WINDOW_MILLISECONDS;
}

function resetSeconds(resetAt: number, now: number): number {
  return Math.max(1, Math.ceil((resetAt - now) / 1_000));
}

function badRequest(): Response {
  return Response.json({ error: 'bad_request' }, { status: 400 });
}

export class CertificateLookupRateLimiter {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST' || request.body !== null) return badRequest();

    const decision = await this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const minute = Math.floor(now / CERTIFICATE_LOOKUP_WINDOW_MILLISECONDS);
      const resetAt = (minute + 1) * CERTIFICATE_LOOKUP_WINDOW_MILLISECONDS;
      const stored = await transaction.get<unknown>(BUCKET_KEY);
      if (stored === undefined) {
        const next: StoredBucket = { minute, count: 1, resetAt };
        await transaction.put(BUCKET_KEY, next);
        await transaction.setAlarm(resetAt);
        return {
          allowed: true,
          remaining: CERTIFICATE_LOOKUP_LIMIT - 1,
          reset: resetSeconds(resetAt, now),
        } satisfies CertificateLookupRateLimitDecision;
      }
      if (!isStoredBucket(stored)) {
        throw new Error('invalid certificate lookup rate-limit state');
      }
      if (stored.minute !== minute) {
        const next: StoredBucket = { minute, count: 1, resetAt };
        await transaction.put(BUCKET_KEY, next);
        await transaction.setAlarm(resetAt);
        return {
          allowed: true,
          remaining: CERTIFICATE_LOOKUP_LIMIT - 1,
          reset: resetSeconds(resetAt, now),
        } satisfies CertificateLookupRateLimitDecision;
      }

      if (stored.count >= CERTIFICATE_LOOKUP_LIMIT) {
        return {
          allowed: false,
          remaining: 0,
          reset: resetSeconds(stored.resetAt, now),
        } satisfies CertificateLookupRateLimitDecision;
      }

      const next: StoredBucket = { ...stored, count: stored.count + 1 };
      await transaction.put(BUCKET_KEY, next);
      return {
        allowed: true,
        remaining: CERTIFICATE_LOOKUP_LIMIT - next.count,
        reset: resetSeconds(stored.resetAt, now),
      } satisfies CertificateLookupRateLimitDecision;
    });

    return Response.json(decision);
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(BUCKET_KEY);
      if (stored === undefined) {
        await transaction.deleteAlarm();
        return;
      }
      if (!isStoredBucket(stored)) {
        throw new Error('invalid certificate lookup rate-limit state');
      }
      if (stored.resetAt <= now) {
        await transaction.delete(BUCKET_KEY);
        await transaction.deleteAlarm();
        return;
      }
      await transaction.setAlarm(stored.resetAt);
    });
  }
}
