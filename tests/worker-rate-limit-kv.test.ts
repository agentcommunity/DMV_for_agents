import assert from 'node:assert/strict';
import test from 'node:test';

import { checkKvCooldown, incrementKvCooldown } from '../worker/rate-limit-kv.ts';

const THRESHOLD = 4;
const COOLDOWN_SECONDS = 24 * 60 * 60;

interface PutCall {
  key: string;
  value: string;
  options?: KVNamespacePutOptions;
}

function createKv(initial?: string): { namespace: KVNamespace; puts: Array<PutCall> } {
  let stored: string | null = initial ?? null;
  const puts: Array<PutCall> = [];

  return {
    puts,
    namespace: {
      async get(key: string) {
        return stored;
      },
      async put(key: string, value: string, options?: KVNamespacePutOptions) {
        stored = value;
        puts.push({ key, value, options });
      },
    } as unknown as KVNamespace,
  };
}

test('checkKvCooldown does not write to KV', async () => {
  const { namespace, puts } = createKv();
  const cooldown = await checkKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.equal(cooldown, null);
  assert.equal(puts.length, 0);
});

test('checkKvCooldown reports remaining time once at threshold, without incrementing', async (t) => {
  const now = 1_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { namespace, puts } = createKv(
    JSON.stringify({ count: THRESHOLD, firstAt: now - 60 * 60 * 1000 }),
  );

  const cooldown = await checkKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.equal(puts.length, 0);
  // 23h remaining out of the 24h window.
  assert.equal(cooldown, COOLDOWN_SECONDS - 60 * 60);
});

test('incrementKvCooldown counts up to threshold then blocks with remaining TTL, not a flat window', async (t) => {
  let now = 1_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { namespace, puts } = createKv();

  for (let call = 1; call < THRESHOLD; call += 1) {
    const cooldown = await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
    assert.equal(cooldown, null, `call ${call} should not be blocked`);
  }

  // Advance the clock partway through the window before the blocking call.
  now += 60 * 60 * 1000; // +1h
  const blocked = await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.notEqual(blocked, null);
  // Remaining should reflect the elapsed hour, not the full 86400s.
  assert.ok(blocked !== null && blocked < COOLDOWN_SECONDS);
  assert.ok(blocked !== null && blocked > COOLDOWN_SECONDS - 60 * 60 - 5);

  // Once at threshold, further increments must not keep bumping the count.
  const stillBlocked = await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.notEqual(stillBlocked, null);
  const finalValue = JSON.parse(puts[puts.length - 1].value) as { count: number };
  assert.equal(finalValue.count, THRESHOLD);
});

test('incrementKvCooldown parses a legacy bare-count value without resetting it', async (t) => {
  const now = 1_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { namespace, puts } = createKv('2'); // legacy shape: bare decimal count

  const cooldown = await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.equal(cooldown, null);
  assert.equal(puts.length, 1);
  const written = JSON.parse(puts[0].value) as { count: number; firstAt: number };
  assert.equal(written.count, 3, 'legacy count of 2 must carry forward, not reset to 1');
  assert.equal(typeof written.firstAt, 'number');
});

test('checkKvCooldown parses a legacy bare-count value at/above threshold', async () => {
  const { namespace } = createKv(String(THRESHOLD));
  const cooldown = await checkKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.notEqual(cooldown, null);
});

test('incrementKvCooldown never writes a TTL below the 60s KV minimum', async (t) => {
  let now = 1_000_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { namespace, puts } = createKv(
    JSON.stringify({ count: 1, firstAt: now - (COOLDOWN_SECONDS - 5) * 1000 }),
  );

  await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS);
  assert.equal(puts.length, 1);
  assert.ok((puts[0].options?.expirationTtl ?? 0) >= 60);
});

test('checkKvCooldown and incrementKvCooldown fail open (return null) on KV read failure', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const namespace = {
    async get() {
      throw new Error('KV unavailable');
    },
    async put() {
      throw new Error('KV unavailable');
    },
  } as unknown as KVNamespace;

  assert.equal(await checkKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS), null);
  assert.equal(await incrementKvCooldown(namespace, 'k', THRESHOLD, COOLDOWN_SECONDS), null);
});
