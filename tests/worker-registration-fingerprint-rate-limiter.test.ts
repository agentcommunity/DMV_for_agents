import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FINGERPRINT_CLAIM_LEASE_SECONDS,
  FINGERPRINT_COOLDOWN_SECONDS,
  FINGERPRINT_COOLDOWN_THRESHOLD,
} from '../worker/register-fingerprint-cooldown.ts';
import { RegistrationFingerprintRateLimiter } from '../worker/registration-fingerprint-rate-limiter.ts';

const STATE_KEY = 'fingerprint-budget';

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return await closure({
        get: async <Value>(key: string) => this.values.get(key) as Value | undefined,
        put: async <Value>(key: string, value: Value) => {
          this.values.set(key, value);
        },
        delete: async (key: string) => this.values.delete(key),
        setAlarm: async (scheduledTime: number | Date) => {
          this.alarmAt = scheduledTime instanceof Date ? scheduledTime.getTime() : scheduledTime;
        },
        deleteAlarm: async () => {
          this.alarmAt = null;
        },
      } as DurableObjectTransaction);
    } finally {
      release();
    }
  }
}

function createLimiter(storage = new FakeStorage()): {
  limiter: RegistrationFingerprintRateLimiter;
  storage: FakeStorage;
} {
  const state = { storage } as unknown as DurableObjectState;
  return { limiter: new RegistrationFingerprintRateLimiter(state), storage };
}

function request(path: '/claim' | '/complete', body?: unknown): Request {
  return new Request(`https://registration-fingerprint.internal${path}`, {
    method: 'POST',
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
  });
}

async function json(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('four simultaneous claims reserve exactly three upstream slots', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const { limiter, storage } = createLimiter();

  const responses = await Promise.all(
    Array.from({ length: 4 }, () => limiter.fetch(request('/claim'))),
  );
  const decisions = await Promise.all(responses.map(json));

  assert.equal(decisions.filter((decision) => decision.allowed === true).length, 3);
  assert.equal(decisions.filter((decision) => decision.allowed === false).length, 1);
  const state = storage.values.get(STATE_KEY) as {
    pending: Array<{ claimId: string; claimedAt: number }>;
    successes: Array<number>;
  };
  assert.equal(state.pending.length, 3);
  assert.deepEqual(state.successes, []);
});

test('failed and non-mint outcomes release their slots for later claims', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const { limiter } = createLimiter();
  const claims = await Promise.all(
    Array.from({ length: 3 }, async () => json(await limiter.fetch(request('/claim')))),
  );
  const blocked = await json(await limiter.fetch(request('/claim')));
  assert.equal(blocked.allowed, false);

  const claimId = claims[0].claim_id;
  assert.equal(typeof claimId, 'string');
  const released = await limiter.fetch(request('/complete', { claim_id: claimId, minted: false }));
  assert.equal(released.status, 204);

  const replacement = await json(await limiter.fetch(request('/claim')));
  assert.equal(replacement.allowed, true);
});

test('committed successes consume the rolling budget and expire after 24 hours', async (t) => {
  let now = 1_752_537_600_000;
  t.mock.method(Date, 'now', () => now);
  const { limiter, storage } = createLimiter();

  for (let mint = 0; mint < FINGERPRINT_COOLDOWN_THRESHOLD; mint += 1) {
    const claim = await json(await limiter.fetch(request('/claim')));
    const completed = await limiter.fetch(
      request('/complete', { claim_id: claim.claim_id, minted: true }),
    );
    assert.equal(completed.status, 204);
  }

  const blocked = await json(await limiter.fetch(request('/claim')));
  assert.deepEqual(blocked, {
    allowed: false,
    retry_after_seconds: FINGERPRINT_COOLDOWN_SECONDS,
  });

  now += FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  const afterWindow = await json(await limiter.fetch(request('/claim')));
  assert.equal(afterWindow.allowed, true);
  const state = storage.values.get(STATE_KEY) as {
    pending: Array<{ claimId: string; claimedAt: number }>;
    successes: Array<number>;
  };
  assert.deepEqual(state.successes, []);
  assert.equal(state.pending.length, 1);
});

test('malformed completion cannot release another request reservation', async () => {
  const { limiter, storage } = createLimiter();
  await limiter.fetch(request('/claim'));

  for (const body of [
    {},
    { claim_id: '', minted: false },
    { claim_id: 'unknown', minted: false },
    { claim_id: 'claim', minted: 'false' },
  ]) {
    const response = await limiter.fetch(request('/complete', body));
    assert.ok(response.status >= 400);
  }

  const state = storage.values.get(STATE_KEY) as { pending: Array<{ claimId: string }> };
  assert.equal(state.pending.length, 1);
});

test('duplicate completion tokens are rejected without changing committed state', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const { limiter, storage } = createLimiter();
  const claim = await json(await limiter.fetch(request('/claim')));

  assert.equal(
    (await limiter.fetch(request('/complete', { claim_id: claim.claim_id, minted: true }))).status,
    204,
  );
  assert.equal(
    (await limiter.fetch(request('/complete', { claim_id: claim.claim_id, minted: false }))).status,
    409,
  );
  const state = storage.values.get(STATE_KEY) as { successes: Array<number>; pending: Array<unknown> };
  assert.equal(state.successes.length, 1);
  assert.equal(state.pending.length, 0);
});

test('an abandoned claim is conservatively counted, then recovers after its 24h window', async (t) => {
  let now = 1_752_537_600_000;
  t.mock.method(Date, 'now', () => now);
  const { limiter, storage } = createLimiter();
  const abandoned = await json(await limiter.fetch(request('/claim')));

  now += FINGERPRINT_CLAIM_LEASE_SECONDS * 1_000;
  await limiter.alarm();
  let state = storage.values.get(STATE_KEY) as {
    successes: Array<number>;
    pending: Array<unknown>;
  };
  const recoveredAt = 1_752_537_600_000 + FINGERPRINT_CLAIM_LEASE_SECONDS * 1_000;
  assert.deepEqual(state.successes, [recoveredAt]);
  assert.deepEqual(state.pending, []);
  assert.equal(
    (await limiter.fetch(request('/complete', { claim_id: abandoned.claim_id, minted: false }))).status,
    409,
  );

  now = recoveredAt + FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  await limiter.alarm();
  const recovered = await json(await limiter.fetch(request('/claim')));
  assert.equal(recovered.allowed, true);
  state = storage.values.get(STATE_KEY) as { successes: Array<number>; pending: Array<unknown> };
  assert.deepEqual(state.successes, []);
  assert.equal(state.pending.length, 1);
});

test('an abandoned claim cannot reopen a slot before 24 hours after its lease expires', async (t) => {
  const claimedAt = 1_752_537_600_000;
  let now = claimedAt;
  t.mock.method(Date, 'now', () => now);
  const { limiter } = createLimiter();

  await Promise.all(
    Array.from({ length: FINGERPRINT_COOLDOWN_THRESHOLD }, () => limiter.fetch(request('/claim'))),
  );

  // The old claimedAt-based recovery incorrectly reopened all three slots here,
  // up to one full lease before the latest possible mint's 24-hour window.
  now = claimedAt + FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  const tooEarly = await json(await limiter.fetch(request('/claim')));
  assert.equal(tooEarly.allowed, false);
  assert.equal(tooEarly.retry_after_seconds, FINGERPRINT_CLAIM_LEASE_SECONDS);

  now = claimedAt
    + FINGERPRINT_CLAIM_LEASE_SECONDS * 1_000
    + FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  const afterFullWindow = await json(await limiter.fetch(request('/claim')));
  assert.equal(afterFullWindow.allowed, true);
});

test('a delayed alarm preserves the lease-expiry timestamp and a late completion cannot shorten or double count it', async (t) => {
  const claimedAt = 1_752_537_600_000;
  let now = claimedAt;
  t.mock.method(Date, 'now', () => now);
  const { limiter, storage } = createLimiter();
  const claim = await json(await limiter.fetch(request('/claim')));

  now = claimedAt + (FINGERPRINT_CLAIM_LEASE_SECONDS + 600) * 1_000;
  await limiter.alarm();
  const recoveredAt = claimedAt + FINGERPRINT_CLAIM_LEASE_SECONDS * 1_000;
  assert.deepEqual(storage.values.get(STATE_KEY), {
    successes: [recoveredAt],
    pending: [],
  });

  const lateCompletion = await limiter.fetch(
    request('/complete', { claim_id: claim.claim_id, minted: true }),
  );
  assert.equal(lateCompletion.status, 409);
  assert.deepEqual(storage.values.get(STATE_KEY), {
    successes: [recoveredAt],
    pending: [],
  });

  now = recoveredAt + FINGERPRINT_COOLDOWN_SECONDS * 1_000 - 1;
  assert.equal((await json(await limiter.fetch(request('/claim')))).allowed, true);
  assert.deepEqual(
    (storage.values.get(STATE_KEY) as { successes: Array<number> }).successes,
    [recoveredAt],
  );
});

test('stored state contains only claim ids and timestamps, never caller identity material', async () => {
  const { limiter, storage } = createLimiter();
  await limiter.fetch(request('/claim'));

  const serialized = JSON.stringify(storage.values.get(STATE_KEY));
  assert.doesNotMatch(serialized, /127\.0\.0\.1|cf-connecting-ip|machine_fingerprint/i);
});
