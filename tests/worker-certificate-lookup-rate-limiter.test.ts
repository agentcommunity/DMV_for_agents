import assert from 'node:assert/strict';
import test from 'node:test';

const LIMIT = 30;
const MINUTE = 60_000;
const BUCKET_KEY = 'certificate-lookup-minute';

interface StoredBucket {
  minute: number;
  count: number;
  resetAt: number;
}

class FakeStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | null = null;
  failTransactions = false;
  private transactionTail: Promise<void> = Promise.resolve();

  async transaction<T>(closure: (transaction: DurableObjectTransaction) => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.transactionTail;
    this.transactionTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;

    try {
      if (this.failTransactions) throw new Error('transaction unavailable');
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      return await closure({
        get: async <Value>(key: string) => this.values.get(key) as Value | undefined,
        put: async <Value>(key: string, value: Value) => {
          this.values.set(key, value);
        },
        delete: async (key: string) => this.values.delete(key),
        getAlarm: async () => this.alarmAt,
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

function createState(storage: FakeStorage): DurableObjectState {
  return { storage } as unknown as DurableObjectState;
}

async function loadRateLimiterClass(): Promise<new (state: DurableObjectState) => {
  fetch(request: Request): Promise<Response>;
  alarm(): Promise<void>;
}> {
  try {
    const module = await import('../worker/certificate-lookup-rate-limiter.ts');
    return module.CertificateLookupRateLimiter;
  } catch (error) {
    assert.fail(`CertificateLookupRateLimiter must be importable: ${String(error)}`);
  }
}

function decisionRequest(): Request {
  return new Request('https://certificate-lookup-rate-limiter.internal/consume', {
    method: 'POST',
  });
}

async function readDecision(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

test('calls 1-30 are allowed with exact decreasing remaining and call 31 is denied', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  const limiter = new RateLimiter(createState(storage));

  for (let call = 1; call <= LIMIT; call += 1) {
    const response = await limiter.fetch(decisionRequest());
    assert.equal(response.status, 200);
    assert.deepEqual(await readDecision(response), {
      allowed: true,
      remaining: LIMIT - call,
      reset: 60,
    });
  }

  const denied = await limiter.fetch(decisionRequest());
  assert.equal(denied.status, 200);
  assert.deepEqual(await readDecision(denied), { allowed: false, remaining: 0, reset: 60 });
});

test('a new wall-clock minute resets the counter', async (t) => {
  let now = 1_752_537_659_999;
  t.mock.method(Date, 'now', () => now);
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  const limiter = new RateLimiter(createState(storage));

  await limiter.fetch(decisionRequest());
  now = 1_752_537_660_000;
  const response = await limiter.fetch(decisionRequest());

  assert.deepEqual(await readDecision(response), { allowed: true, remaining: 29, reset: 60 });
  assert.deepEqual(storage.values.get(BUCKET_KEY), {
    minute: Math.floor(1_752_537_660_000 / MINUTE),
    count: 1,
    resetAt: 1_752_537_720_000,
  });
});

test('serialized transactions prevent concurrent calls from losing increments', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  const limiter = new RateLimiter(createState(storage));

  const responses = await Promise.all(
    Array.from({ length: 31 }, () => limiter.fetch(decisionRequest())),
  );
  const decisions = await Promise.all(responses.map(readDecision));

  assert.equal(decisions.filter((decision) => decision.allowed === true).length, 30);
  assert.equal(decisions.filter((decision) => decision.allowed === false).length, 1);
  assert.equal((storage.values.get(BUCKET_KEY) as StoredBucket).count, 30);
});

test('malformed method or any caller-supplied body returns 400 without changing state', async () => {
  const RateLimiter = await loadRateLimiterClass();

  for (const request of [
    new Request('https://certificate-lookup-rate-limiter.internal/consume'),
    new Request('https://certificate-lookup-rate-limiter.internal/consume', {
      method: 'POST',
      body: '{',
    }),
    new Request('https://certificate-lookup-rate-limiter.internal/consume', {
      method: 'POST',
      body: JSON.stringify({ now: -1 }),
    }),
  ]) {
    const storage = new FakeStorage();
    const limiter = new RateLimiter(createState(storage));
    const response = await limiter.fetch(request);

    assert.equal(response.status, 400);
    assert.equal(storage.values.size, 0);
    assert.equal(storage.alarmAt, null);
  }
});

test('storage transaction failure rejects the internal request', async () => {
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  storage.failTransactions = true;
  const limiter = new RateLimiter(createState(storage));

  await assert.rejects(limiter.fetch(decisionRequest()), /transaction unavailable/);
});

test('a delayed old request is charged to processing time and cannot reopen a full new-minute budget', async (t) => {
  let now = 1_752_537_600_000;
  t.mock.method(Date, 'now', () => now);
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  const limiter = new RateLimiter(createState(storage));

  await limiter.fetch(decisionRequest());
  const delayedOldRequest = decisionRequest();
  assert.equal(delayedOldRequest.body, null);

  now += MINUTE;
  for (let call = 1; call <= LIMIT; call += 1) {
    const response = await limiter.fetch(decisionRequest());
    assert.deepEqual(await readDecision(response), {
      allowed: true,
      remaining: LIMIT - call,
      reset: 60,
    });
  }

  const denied = await limiter.fetch(delayedOldRequest);
  assert.deepEqual(await readDecision(denied), { allowed: false, remaining: 0, reset: 60 });
  assert.deepEqual(storage.values.get(BUCKET_KEY), {
    minute: Math.floor(now / MINUTE),
    count: LIMIT,
    resetAt: now + MINUTE,
  });
});

test('alarm deletes expired state but preserves and rearms a fresh rollover bucket', async (t) => {
  let now = 1_752_537_600_000;
  t.mock.method(Date, 'now', () => now);
  const RateLimiter = await loadRateLimiterClass();
  const storage = new FakeStorage();
  const limiter = new RateLimiter(createState(storage));

  await limiter.fetch(decisionRequest());
  now += MINUTE;
  await limiter.alarm();
  assert.equal(storage.values.has(BUCKET_KEY), false);
  assert.equal(storage.alarmAt, null);

  await limiter.fetch(decisionRequest());
  const freshBucket = storage.values.get(BUCKET_KEY);
  await limiter.alarm();

  assert.deepEqual(storage.values.get(BUCKET_KEY), freshBucket);
  assert.equal(storage.alarmAt, now + MINUTE);
});
