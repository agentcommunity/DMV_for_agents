import assert from 'node:assert/strict';
import test from 'node:test';

import {
  runFingerprintGatedUpstream,
  type FingerprintCooldownGate,
} from '../worker/register-fingerprint-cooldown.ts';

const THRESHOLD = 4;
const COOLDOWN_SECONDS = 24 * 60 * 60;
const KEY = 'dmv:register:fingerprint:abc123';

function createGate(options: {
  checkReturns?: number | null;
  incrementReturns?: number | null;
  order?: Array<string>;
} = {}): { gate: FingerprintCooldownGate; order: Array<string> } {
  const order = options.order ?? [];
  return {
    order,
    gate: {
      async check() {
        order.push('check');
        return options.checkReturns ?? null;
      },
      async increment() {
        order.push('increment');
        return options.incrementReturns ?? null;
      },
    },
  };
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('at-threshold: blocked BEFORE any upstream call — upstream is never invoked', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ checkReturns: 3600, order });
  let upstreamCalls = 0;
  const callUpstream = async () => {
    upstreamCalls += 1;
    order.push('upstream');
    return jsonResponse({ certificate_id: 'X' }, 201);
  };

  const result = await runFingerprintGatedUpstream(gate, KEY, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.deepEqual(result, { blocked: true, retryAfterSeconds: 3600 });
  assert.equal(upstreamCalls, 0, 'upstream must not be called once already at threshold');
  assert.deepEqual(order, ['check']);
});

test('upstream 5xx: increment is never called', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });
  const callUpstream = async () => {
    order.push('upstream');
    return jsonResponse({ error: 'Registration failed.' }, 500);
  };

  const result = await runFingerprintGatedUpstream(gate, KEY, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['check', 'upstream']);
  assert.ok(!order.includes('increment'), 'a 5xx upstream response must not consume cooldown budget');
});

test('already_recorded 200 replay: increment is never called', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });
  const callUpstream = async () => {
    order.push('upstream');
    return jsonResponse({ certificate_id: 'X', already_recorded: true }, 200);
  };

  const result = await runFingerprintGatedUpstream(gate, KEY, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['check', 'upstream']);
  assert.ok(!order.includes('increment'), 'an already_recorded replay must not consume cooldown budget');
});

test('fresh 201 mint: increment is called exactly once, after upstream', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });
  const callUpstream = async () => {
    order.push('upstream');
    return jsonResponse({ certificate_id: 'MESA-DD6-660J' }, 201);
  };

  const result = await runFingerprintGatedUpstream(gate, KEY, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['check', 'upstream', 'increment']);
  assert.equal(order.filter((step) => step === 'increment').length, 1);
});

test('no fingerprint key (e.g. UI/Turnstile signup): upstream is called, gate is never touched', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });
  const callUpstream = async () => {
    order.push('upstream');
    return jsonResponse({ certificate_id: 'X' }, 201);
  };

  const result = await runFingerprintGatedUpstream(gate, null, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['upstream']);
});

test('the response returned on a mint carries the real upstream body', async () => {
  const { gate } = createGate();
  const callUpstream = async () => jsonResponse({ certificate_id: 'MESA-DD6-660J' }, 201);

  const result = await runFingerprintGatedUpstream(gate, KEY, THRESHOLD, COOLDOWN_SECONDS, callUpstream);

  assert.equal(result.blocked, false);
  if (!result.blocked) {
    assert.equal(result.upstream.status, 201);
    assert.equal(result.bodyText, JSON.stringify({ certificate_id: 'MESA-DD6-660J' }));
    // The Response body must still be readable by the caller (not consumed
    // by internally cloning it to read bodyText).
    assert.deepEqual(await result.upstream.json(), { certificate_id: 'MESA-DD6-660J' });
  }
});
