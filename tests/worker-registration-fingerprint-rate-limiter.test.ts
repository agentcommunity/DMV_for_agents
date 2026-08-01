import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  createFingerprintCooldownGate,
  fingerprintCooldownResponse,
  FINGERPRINT_PENDING_HORIZON_SECONDS,
  FINGERPRINT_COOLDOWN_SECONDS,
  FINGERPRINT_COOLDOWN_THRESHOLD,
  runFingerprintGatedUpstream,
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
    pending: Array<{ claimDigest: string; claimedAt: number }>;
    successes: Array<number>;
  };
  assert.equal(state.pending.length, 3);
  assert.deepEqual(state.successes, []);
});

test('three fresh pending claims compose to the public fingerprint cooldown response', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const { limiter } = createLimiter();
  const namespace = {
    idFromName(name: string) {
      return { name };
    },
    get() {
      return {
        fetch(request: Request) {
          return limiter.fetch(request);
        },
      };
    },
  } as unknown as DurableObjectNamespace;
  const gate = createFingerprintCooldownGate(namespace);
  let upstreamCalls = 0;

  for (let claim = 0; claim < 3; claim += 1) {
    const pending = await runFingerprintGatedUpstream(
      gate,
      'dmv:register:fingerprint:abc123',
      async () => {
        upstreamCalls += 1;
        return Response.json({ error: 'ambiguous upstream result' }, { status: 503 });
      },
    );
    assert.equal(pending.blocked, false);
  }

  const blocked = await runFingerprintGatedUpstream(
    gate,
    'dmv:register:fingerprint:abc123',
    async () => {
      upstreamCalls += 1;
      return Response.json({ error: 'must not be called' }, { status: 500 });
    },
  );
  assert.equal(blocked.blocked, true);
  if (!blocked.blocked) assert.fail('expected the fourth claim to be blocked');
  assert.equal(blocked.retryAfterSeconds, 87_000);
  assert.equal(upstreamCalls, 3);

  const response = fingerprintCooldownResponse(blocked.retryAfterSeconds);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('Retry-After'), '87000');
  assert.deepEqual(await json(response), {
    error: 'fingerprint_cooldown',
    message: 'Too many registrations from this machine. Please wait before trying again.',
    retry_after_seconds: 87_000,
  });
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
    pending: Array<{ claimDigest: string; claimedAt: number }>;
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

  const state = storage.values.get(STATE_KEY) as { pending: Array<{ claimDigest: string }> };
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

  now += FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000;
  await limiter.alarm();
  let state = storage.values.get(STATE_KEY) as {
    successes: Array<number>;
    pending: Array<unknown>;
  };
  const recoveredAt = 1_752_537_600_000 + FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000;
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

test('an abandoned claim cannot reopen a slot before 24 hours after its pending horizon', async (t) => {
  const claimedAt = 1_752_537_600_000;
  let now = claimedAt;
  t.mock.method(Date, 'now', () => now);
  const { limiter } = createLimiter();

  await Promise.all(
    Array.from({ length: FINGERPRINT_COOLDOWN_THRESHOLD }, () => limiter.fetch(request('/claim'))),
  );

  // The old claimedAt-based recovery incorrectly reopened all three slots here,
  // before the latest possible mint's full 24-hour window.
  now = claimedAt + FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  const tooEarly = await json(await limiter.fetch(request('/claim')));
  assert.equal(tooEarly.allowed, false);
  assert.equal(tooEarly.retry_after_seconds, FINGERPRINT_PENDING_HORIZON_SECONDS);

  now = claimedAt
    + FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000
    + FINGERPRINT_COOLDOWN_SECONDS * 1_000;
  const afterFullWindow = await json(await limiter.fetch(request('/claim')));
  assert.equal(afterFullWindow.allowed, true);
});

test('a timed-out caller remains reserved through the latest conservative remote mint horizon', async (t) => {
  const claimedAt = 1_752_537_600_000;
  let now = claimedAt;
  t.mock.method(Date, 'now', () => now);
  const { limiter, storage } = createLimiter();

  await Promise.all(
    Array.from({ length: FINGERPRINT_COOLDOWN_THRESHOLD }, () => limiter.fetch(request('/claim'))),
  );

  now = claimedAt + 599_999;
  const beforeRemoteExecutionBound = await json(await limiter.fetch(request('/claim')));
  assert.equal(beforeRemoteExecutionBound.allowed, false);
  assert.equal(beforeRemoteExecutionBound.retry_after_seconds, 86_401);

  now = claimedAt + 600_000;
  await limiter.alarm();
  assert.deepEqual(storage.values.get(STATE_KEY), {
    successes: [claimedAt + 600_000, claimedAt + 600_000, claimedAt + 600_000],
    pending: [],
  });

  now = claimedAt + 600_000 + FINGERPRINT_COOLDOWN_SECONDS * 1_000 - 1;
  assert.equal((await json(await limiter.fetch(request('/claim')))).allowed, false);

  now += 1;
  assert.equal((await json(await limiter.fetch(request('/claim')))).allowed, true);
});

test('a delayed alarm preserves the horizon timestamp and a late completion cannot shorten or double count it', async (t) => {
  const claimedAt = 1_752_537_600_000;
  let now = claimedAt;
  t.mock.method(Date, 'now', () => now);
  const { limiter, storage } = createLimiter();
  const claim = await json(await limiter.fetch(request('/claim')));

  now = claimedAt + (FINGERPRINT_PENDING_HORIZON_SECONDS + 600) * 1_000;
  await limiter.alarm();
  const recoveredAt = claimedAt + FINGERPRINT_PENDING_HORIZON_SECONDS * 1_000;
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

test('stored state contains only claim digests and timestamps, never raw claim tokens or caller identity', async () => {
  const { limiter, storage } = createLimiter();
  const claim = await json(await limiter.fetch(request('/claim')));
  assert.equal(typeof claim.claim_id, 'string');
  if (typeof claim.claim_id !== 'string') assert.fail('expected an opaque claim token');

  const state = storage.values.get(STATE_KEY) as {
    pending: Array<{ claimDigest: string; claimedAt: number }>;
  };
  const expectedDigest = createHash('sha256').update(claim.claim_id).digest('hex');
  assert.deepEqual(Object.keys(state.pending[0]).sort(), ['claimDigest', 'claimedAt']);
  assert.equal(state.pending[0].claimDigest, expectedDigest);

  const serialized = JSON.stringify(state);
  assert.doesNotMatch(serialized, new RegExp(claim.claim_id));
  assert.doesNotMatch(serialized, /127\.0\.0\.1|cf-connecting-ip|machine_fingerprint/i);
});
