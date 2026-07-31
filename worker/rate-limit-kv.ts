/**
 * Workers KV-backed cooldown helper for coarse local anti-abuse limits.
 *
 * This mirrors the PAGE repo's "increment until threshold, then hold for TTL"
 * pattern, but takes the KV binding explicitly so DMV can keep its cooldown
 * state local to this worker.
 *
 * Stored value shape is `{ count, firstAt }` (JSON), where `firstAt` is the
 * epoch-ms timestamp of the first increment in the current window. This lets
 * `Retry-After` report the actual remaining window instead of a flat
 * `cooldownSeconds`. Values written before this shape existed are a bare
 * decimal count (e.g. `"2"`) — `parseCooldownValue` still reads those and
 * treats "now" as the window start rather than resetting the counter, since
 * there's no record of when the legacy window actually began.
 */

interface CooldownState {
  count: number;
  firstAt: number;
}

// Workers KV rejects expirationTtl below 60s.
const MIN_KV_TTL_SECONDS = 60;

function parseCooldownValue(raw: string): CooldownState {
  const trimmed = raw.trim();

  // Legacy bare-count value (written before {count, firstAt} existed).
  // Preserve the count; anchor firstAt to now since the true window start
  // isn't recoverable — this is never worse than the previous behavior,
  // which always reported a flat cooldownSeconds regardless of progress.
  if (/^\d+$/.test(trimmed)) {
    return { count: parseInt(trimmed, 10), firstAt: Date.now() };
  }

  try {
    const parsed = JSON.parse(trimmed) as Partial<CooldownState>;
    if (typeof parsed.count === 'number' && typeof parsed.firstAt === 'number') {
      return { count: parsed.count, firstAt: parsed.firstAt };
    }
  } catch {
    // fall through to the zero-state default below
  }

  return { count: 0, firstAt: Date.now() };
}

function remainingSeconds(state: CooldownState, cooldownSeconds: number): number {
  const elapsedMs = Date.now() - state.firstAt;
  const remainingMs = cooldownSeconds * 1000 - elapsedMs;
  return Math.max(1, Math.ceil(remainingMs / 1000));
}

/**
 * Check-only read: reports the remaining cooldown (seconds) if the key is
 * already at or above `threshold`, without writing anything. Use this to
 * gate work that should not itself count as a consumed attempt.
 */
export async function checkKvCooldown(
  kv: KVNamespace,
  key: string,
  threshold: number,
  cooldownSeconds: number,
): Promise<number | null> {
  try {
    const current = await kv.get(key);
    if (!current) return null;

    const state = parseCooldownValue(current);
    if (state.count >= threshold) {
      return remainingSeconds(state, cooldownSeconds);
    }

    return null;
  } catch (error) {
    console.error('[rate-limit-kv] checkKvCooldown failed', { key, error });
    return null;
  }
}

/**
 * Record one consumption of the cooldown budget. Callers must only call this
 * after the event actually worth counting has happened (e.g. a successful
 * mint) — never merely because a request was attempted.
 */
export async function incrementKvCooldown(
  kv: KVNamespace,
  key: string,
  threshold: number,
  cooldownSeconds: number,
): Promise<number | null> {
  try {
    const current = await kv.get(key);
    const state = current ? parseCooldownValue(current) : { count: 0, firstAt: Date.now() };

    if (state.count >= threshold) {
      return remainingSeconds(state, cooldownSeconds);
    }

    const next: CooldownState = { count: state.count + 1, firstAt: state.firstAt };

    // TTL is anchored to firstAt, not "now" — re-deriving the remaining
    // window on every write keeps a legacy/rehydrated entry from being
    // granted a fresh full-length window on each increment.
    const elapsedSeconds = Math.floor((Date.now() - state.firstAt) / 1000);
    const ttl = Math.max(MIN_KV_TTL_SECONDS, cooldownSeconds - elapsedSeconds);

    await kv.put(key, JSON.stringify(next), { expirationTtl: ttl });

    if (next.count >= threshold) {
      return remainingSeconds(next, cooldownSeconds);
    }

    return null;
  } catch (error) {
    console.error('[rate-limit-kv] incrementKvCooldown failed', { key, error });
    return null;
  }
}
