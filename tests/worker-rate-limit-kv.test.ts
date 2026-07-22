import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeKvBucket } from '../worker/rate-limit-kv.ts';

function createKv(): KVNamespace {
  const values = new Map<string, string>();

  return {
    async get(key: string) {
      return values.get(key) ?? null;
    },
    async put(key: string, value: string) {
      values.set(key, value);
    },
  } as KVNamespace;
}

test('allows calls through the limit with decreasing remaining count', async () => {
  const kv = createKv();

  for (let call = 1; call <= 30; call += 1) {
    const result = await consumeKvBucket(kv, 'lookup:203.0.113.7:minute', 30, 60);

    assert.deepEqual(result, { allowed: true, remaining: 30 - call });
  }
});

test('denies the call after the limit with no remaining count', async () => {
  const kv = createKv();

  for (let call = 1; call <= 30; call += 1) {
    await consumeKvBucket(kv, 'lookup:203.0.113.7:minute', 30, 60);
  }

  const result = await consumeKvBucket(kv, 'lookup:203.0.113.7:minute', 30, 60);

  assert.deepEqual(result, { allowed: false, remaining: 0 });
});

test('returns null when KV reads or writes fail', async (t) => {
  t.mock.method(console, 'error', () => undefined);

  const failingKvs: Array<KVNamespace> = [
    {
      async get() {
        throw new Error('KV read unavailable');
      },
    } as KVNamespace,
    {
      async get() {
        return null;
      },
      async put() {
        throw new Error('KV write unavailable');
      },
    } as KVNamespace,
  ];

  for (const kv of failingKvs) {
    const result = await consumeKvBucket(kv, 'lookup:203.0.113.7:minute', 30, 60);

    assert.equal(result, null);
  }
});

test('returns null for malformed or out-of-range stored counts', async (t) => {
  t.mock.method(console, 'error', () => undefined);

  for (const storedCount of [
    '',
    '   ',
    'not-a-number',
    '7junk',
    '-1',
    '1.5',
    '1e1',
    '01',
    'Infinity',
    '31',
  ]) {
    let putCalls = 0;
    const kv = {
      async get() {
        return storedCount;
      },
      async put() {
        putCalls += 1;
      },
    } as KVNamespace;

    const result = await consumeKvBucket(kv, 'lookup:203.0.113.7:minute', 30, 60);

    assert.equal(result, null);
    assert.equal(putCalls, 0, `must not overwrite corrupt counter ${JSON.stringify(storedCount)}`);
  }
});
