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
