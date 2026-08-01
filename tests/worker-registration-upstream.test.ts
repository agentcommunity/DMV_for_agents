import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRegistrationOutcome,
  fetchRegistrationUpstream,
} from '../worker/registration-upstream.ts';

function registrationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    certificate_id: 'MESA-DD6-660J',
    agent_name: 'mesa-agent',
    domain: 'mesa-agent.agent',
    registration_type: 'AGENT',
    queue_number: 42,
    permalink_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/mesa-agent',
    badge_url: 'https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J',
    badge_card_url: 'https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J&style=card',
    message: 'Certificate MESA-DD6-660J issued for mesa-agent.agent.',
    ...overrides,
  };
}

test('passes through a normal 201 registration response and strips unsafe headers', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(JSON.stringify({ certificate_id: 'MESA-DD6-660J' }), {
      status: 201,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Request-Id': 'registration-123',
        'Set-Cookie': 'supabase-session=secret',
        Connection: 'keep-alive',
      },
    });
  }) as typeof fetch;

  const response = await fetchRegistrationUpstream(
    'https://project.supabase.test/functions/v1/register-agent',
    {
      method: 'POST',
      headers: { 'x-dmv-proxy': 'worker-secret' },
      body: JSON.stringify({ agent_name: 'mesa-agent' }),
    },
    fetchImpl,
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { certificate_id: 'MESA-DD6-660J' });
  assert.equal(response.headers.get('Content-Type'), 'application/json; charset=utf-8');
  assert.equal(response.headers.get('X-Request-Id'), 'registration-123');
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('Connection'), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});

test('fails closed for a registration upstream redirect without following it or forwarding the secret', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const redirectTarget = 'https://redirect.example.test/collect-secret';
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(null, {
      status: 307,
      headers: { Location: redirectTarget },
    });
  }) as typeof fetch;

  const response = await fetchRegistrationUpstream(
    'https://project.supabase.test/functions/v1/register-agent',
    {
      method: 'POST',
      headers: { 'x-dmv-proxy': 'worker-secret' },
      body: '{}',
    },
    fetchImpl,
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'registration_unavailable',
    message: 'Registration is temporarily unavailable. Please try again shortly.',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
  assert.ok(calls.every(({ input }) => input !== redirectTarget));
});

test('a well-formed 201 is classified as a fresh mint', () => {
  assert.equal(
    classifyRegistrationOutcome(201, JSON.stringify(registrationPayload())),
    'minted',
  );
});

test('a well-formed 200 already_recorded replay is releasable', () => {
  assert.equal(
    classifyRegistrationOutcome(
      200,
      JSON.stringify(registrationPayload({
        queue_number: null,
        message: 'Pre-registration already recorded for mesa-agent.agent.',
        already_recorded: true,
      })),
    ),
    'releasable',
  );
});

test('only audited pre-insert error statuses are releasable', () => {
  assert.equal(
    classifyRegistrationOutcome(400, JSON.stringify({ error: 'agent_name is required' })),
    'releasable',
  );
  assert.equal(
    classifyRegistrationOutcome(403, JSON.stringify({
      error: "You've maxed out your quota on this email: up to 5 agent identities. Members who've signed the endorsement letter can pre-register up to 12.",
      current: 5,
      limit: 5,
      endorsed: false,
    })),
    'releasable',
  );
  assert.equal(
    classifyRegistrationOutcome(409, JSON.stringify({
      error: 'Certificate ID collision. Please retry with a different name.',
    })),
    'releasable',
  );
});

test('all 5xx and 546 responses are ambiguous even with a normal error body', () => {
  for (const status of [500, 503, 504, 546]) {
    assert.equal(
      classifyRegistrationOutcome(status, JSON.stringify({ error: 'upstream failed' })),
      'ambiguous',
    );
  }
});

test('malformed and unexpected response shapes are ambiguous', () => {
  assert.equal(classifyRegistrationOutcome(201, 'not json'), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(201, JSON.stringify({ ok: true })), 'ambiguous');
  assert.equal(
    classifyRegistrationOutcome(201, JSON.stringify({ certificate_id: 'MESA-DD6-660J' })),
    'ambiguous',
  );
  assert.equal(
    classifyRegistrationOutcome(201, JSON.stringify({ certificate_id: 'X', already_recorded: true })),
    'ambiguous',
  );
  assert.equal(classifyRegistrationOutcome(400, JSON.stringify({ ok: false })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(400, JSON.stringify({ error: 'unknown rejection' })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(403, JSON.stringify({ error: 'quota' })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(409, JSON.stringify({ error: 'conflict' })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(400, JSON.stringify({ error: '   ' })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(201, JSON.stringify({ certificate_id: '   ' })), 'ambiguous');
  assert.equal(classifyRegistrationOutcome(200, JSON.stringify({ certificate_id: 'X' })), 'ambiguous');
  assert.equal(
    classifyRegistrationOutcome(200, JSON.stringify({ certificate_id: 'X', already_recorded: true })),
    'ambiguous',
  );
  assert.equal(classifyRegistrationOutcome(204, ''), 'ambiguous');
});

test('propagates an ambiguous registration fetch rejection with manual redirect mode', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    throw new TypeError('network fetch failed');
  }) as typeof fetch;

  await assert.rejects(
    fetchRegistrationUpstream(
      'https://project.supabase.test/functions/v1/register-agent',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-dmv-proxy': 'worker-secret',
        },
        body: JSON.stringify({ agent_name: 'mesa-agent' }),
      },
      fetchImpl,
    ),
    /network fetch failed/,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});
