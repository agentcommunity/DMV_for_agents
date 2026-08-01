import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createFingerprintCooldownGate,
  FINGERPRINT_CLAIM_LEASE_SECONDS,
  FINGERPRINT_COOLDOWN_SECONDS,
  FINGERPRINT_COOLDOWN_THRESHOLD,
  FINGERPRINT_UPSTREAM_DEADLINE_MILLISECONDS,
  runFingerprintGatedUpstream,
  type FingerprintCooldownGate,
} from '../worker/register-fingerprint-cooldown.ts';

const KEY = 'dmv:register:fingerprint:abc123';

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function createGate(options: {
  claim?: { allowed: boolean; claimId?: string; retryAfterSeconds?: number };
  order?: Array<string>;
} = {}): { gate: FingerprintCooldownGate; order: Array<string> } {
  const order = options.order ?? [];
  return {
    order,
    gate: {
      async claim() {
        order.push('claim');
        return options.claim ?? { allowed: true, claimId: 'claim-1' };
      },
      async complete(_key, claimId, minted) {
        order.push(`complete:${claimId}:${minted ? 'minted' : 'released'}`);
      },
    },
  };
}

test('an exhausted fingerprint budget blocks before upstream', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({
    claim: { allowed: false, retryAfterSeconds: 3600 },
    order,
  });
  let upstreamCalls = 0;

  const result = await runFingerprintGatedUpstream(gate, KEY, async () => {
    upstreamCalls += 1;
    order.push('upstream');
    return jsonResponse({ certificate_id: 'X' }, 201);
  });

  assert.deepEqual(result, { blocked: true, retryAfterSeconds: 3600 });
  assert.equal(upstreamCalls, 0);
  assert.deepEqual(order, ['claim']);
});

test('a fresh mint commits its reservation after upstream', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });

  const result = await runFingerprintGatedUpstream(gate, KEY, async () => {
    order.push('upstream');
    return jsonResponse({ certificate_id: 'MESA-DD6-660J' }, 201);
  });

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['claim', 'upstream', 'complete:claim-1:minted']);
});

for (const [label, upstream] of [
  ['an upstream failure', () => jsonResponse({ error: 'Registration failed.' }, 500)],
  [
    'an already-recorded replay',
    () => jsonResponse({ certificate_id: 'X', already_recorded: true }, 200),
  ],
] as const) {
  test(`${label} releases its reservation`, async () => {
    const order: Array<string> = [];
    const { gate } = createGate({ order });

    const result = await runFingerprintGatedUpstream(gate, KEY, async () => {
      order.push('upstream');
      return upstream();
    });

    assert.equal(result.blocked, false);
    assert.deepEqual(order, ['claim', 'upstream', 'complete:claim-1:released']);
  });
}

test('an ambiguous thrown upstream call leaves its reservation pending before propagating', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });

  await assert.rejects(
    runFingerprintGatedUpstream(gate, KEY, async () => {
      order.push('upstream');
      throw new Error('network failed');
    }),
    /network failed/,
  );
  assert.deepEqual(order, ['claim', 'upstream']);
});

test('an upstream deadline aborts the call and leaves its reservation pending', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });

  await assert.rejects(
    runFingerprintGatedUpstream(
      gate,
      KEY,
      async (signal) => {
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            order.push('upstream-aborted');
            reject(signal.reason);
          }, { once: true });
        });
      },
      { deadlineMilliseconds: 5 },
    ),
    /deadline/i,
  );
  assert.deepEqual(order, ['claim', 'upstream-aborted']);
});

test('a prompt explicit upstream response clears the deadline timer', async () => {
  const { gate } = createGate();
  let upstreamSignal: AbortSignal | undefined;

  const result = await runFingerprintGatedUpstream(
    gate,
    KEY,
    async (signal) => {
      upstreamSignal = signal;
      return jsonResponse({ error: 'Registration failed.' }, 500);
    },
    { deadlineMilliseconds: 5 },
  );
  assert.equal(result.blocked, false);

  await new Promise<void>((resolve) => setTimeout(resolve, 15));
  assert.equal(upstreamSignal?.aborted, false);
});

test('a late upstream settlement after the deadline never completes the claim', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });

  await assert.rejects(
    runFingerprintGatedUpstream(
      gate,
      KEY,
      async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        order.push('upstream-settled-late');
        return jsonResponse({ certificate_id: 'MESA-DD6-660J' }, 201);
      },
      { deadlineMilliseconds: 5 },
    ),
    /deadline/i,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(order, ['claim', 'upstream-settled-late']);
});

test('the upstream deadline is bounded by the abandoned-claim lease', () => {
  assert.ok(FINGERPRINT_UPSTREAM_DEADLINE_MILLISECONDS > 0);
  assert.ok(
    FINGERPRINT_UPSTREAM_DEADLINE_MILLISECONDS <= FINGERPRINT_CLAIM_LEASE_SECONDS * 1_000,
  );
});

test('UI traffic without a fingerprint bypasses the fingerprint object', async () => {
  const order: Array<string> = [];
  const { gate } = createGate({ order });

  const result = await runFingerprintGatedUpstream(gate, null, async () => {
    order.push('upstream');
    return jsonResponse({ certificate_id: 'X' }, 201);
  });

  assert.equal(result.blocked, false);
  assert.deepEqual(order, ['upstream']);
});

test('the production budget remains exactly 3 successful mints in 24 hours', () => {
  assert.equal(FINGERPRINT_COOLDOWN_THRESHOLD, 3);
  assert.equal(FINGERPRINT_COOLDOWN_SECONDS, 24 * 60 * 60);
});

test('blocked public results never expose internal claim ids', async () => {
  const { gate } = createGate({
    claim: { allowed: false, retryAfterSeconds: 60 },
  });
  const result = await runFingerprintGatedUpstream(
    gate,
    KEY,
    async () => jsonResponse({ certificate_id: 'never-called' }, 201),
  );

  assert.deepEqual(Object.keys(result).sort(), ['blocked', 'retryAfterSeconds']);
  assert.doesNotMatch(JSON.stringify(result), /claim/i);
});

test('claim and completion address the same hashed-fingerprint object only', async () => {
  const selectedNames: Array<string> = [];
  const requests: Array<Request> = [];
  const stub = {
    async fetch(request: Request) {
      requests.push(request);
      if (new URL(request.url).pathname === '/claim') {
        return jsonResponse({ allowed: true, claim_id: 'opaque-claim' }, 200);
      }
      return new Response(null, { status: 204 });
    },
  };
  const namespace = {
    idFromName(name: string) {
      selectedNames.push(name);
      return { name };
    },
    get() {
      return stub;
    },
  } as unknown as DurableObjectNamespace;
  const gate = createFingerprintCooldownGate(namespace);

  const claim = await gate.claim(KEY);
  assert.equal(claim.allowed, true);
  if (!claim.allowed) assert.fail('expected an allowed claim');
  await gate.complete(KEY, claim.claimId, true);

  assert.deepEqual(selectedNames, [KEY, KEY]);
  assert.equal(requests.length, 2);
  assert.equal(await requests[0].text(), '');
  const completionBody = await requests[1].text();
  assert.deepEqual(JSON.parse(completionBody), {
    claim_id: 'opaque-claim',
    minted: true,
  });
  assert.doesNotMatch(completionBody, /fingerprint|127\.0\.0\.1|ip/i);
});
