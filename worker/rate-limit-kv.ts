/**
 * Workers KV-backed cooldown helper for coarse local anti-abuse limits.
 *
 * This mirrors the PAGE repo's "increment until threshold, then hold for TTL"
 * pattern, but takes the KV binding explicitly so DMV can keep its cooldown
 * state local to this worker.
 */
export async function incrementKvCooldown(
  kv: KVNamespace,
  key: string,
  threshold: number,
  cooldownSeconds: number,
): Promise<number | null> {
  try {
    const current = await kv.get(key)
    const count = current ? parseInt(current, 10) : 0

    if (count >= threshold) {
      return cooldownSeconds
    }

    const next = count + 1
    await kv.put(key, String(next), { expirationTtl: cooldownSeconds })
    if (next >= threshold) {
      return cooldownSeconds
    }

    return null
  } catch (error) {
    console.error('[rate-limit-kv] incrementKvCooldown failed', { key, error })
    return null
  }
}

export interface KvBucketResult {
  allowed: boolean;
  remaining: number;
}

/**
 * Workers KV increments are race-tolerant rather than atomic; the binding remains
 * the burst backstop while this limits sustained sequential abuse. Each write
 * refreshes TTL, so fixed-window callers must include a wall-clock bucket in key.
 */
export async function consumeKvBucket(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<KvBucketResult | null> {
  try {
    const stored = await kv.get(key);
    if (stored !== null && !/^(0|[1-9]\d*)$/.test(stored)) {
      console.error('[rate-limit-kv] consumeKvBucket found invalid count', { key });
      return null;
    }
    const current = stored === null ? 0 : Number(stored);
    if (!Number.isInteger(current) || current < 0 || current > limit) {
      console.error('[rate-limit-kv] consumeKvBucket found invalid count', { key });
      return null;
    }
    if (current >= limit) return { allowed: false, remaining: 0 };
    const next = current + 1;
    const remaining = limit - next;
    if (!Number.isInteger(remaining) || remaining < 0 || remaining > limit) {
      console.error('[rate-limit-kv] consumeKvBucket computed invalid remaining count', { key });
      return null;
    }
    await kv.put(key, String(next), { expirationTtl: windowSeconds });
    return { allowed: true, remaining };
  } catch (error) {
    console.error('[rate-limit-kv] consumeKvBucket failed', { key, error });
    return null;
  }
}
