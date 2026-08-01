import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchRegistrationUpstream, isNewCertificateMint } from '../worker/registration-upstream.ts';

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

test('isNewCertificateMint is true only for a 201 that is not an already_recorded replay', () => {
  assert.equal(
    isNewCertificateMint(201, JSON.stringify({ certificate_id: 'MESA-DD6-660J' })),
    true,
  );
});

test('isNewCertificateMint is false for a 200 already_recorded replay', () => {
  assert.equal(
    isNewCertificateMint(
      200,
      JSON.stringify({ certificate_id: 'MESA-DD6-660J', already_recorded: true }),
    ),
    false,
  );
});

test('isNewCertificateMint is false for any non-201 status, including 5xx', () => {
  assert.equal(isNewCertificateMint(500, JSON.stringify({ error: 'Registration failed.' })), false);
  assert.equal(isNewCertificateMint(503, JSON.stringify({ error: 'registration_unavailable' })), false);
  assert.equal(isNewCertificateMint(403, JSON.stringify({ error: 'quota exceeded' })), false);
  assert.equal(isNewCertificateMint(409, JSON.stringify({ error: 'Certificate ID collision.' })), false);
});

test('isNewCertificateMint defensively checks the body flag even on a 201, not just the status', () => {
  // Guards the counting logic against a future response-shape regression
  // where a replay accidentally carries a 201 status.
  assert.equal(
    isNewCertificateMint(201, JSON.stringify({ already_recorded: true })),
    false,
  );
});

test('isNewCertificateMint treats an unparsable 201 body as a mint (fails toward counting a real success)', () => {
  assert.equal(isNewCertificateMint(201, 'not json'), true);
});

test('maps a registration upstream fetch rejection to unavailable with manual redirect mode', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    throw new TypeError('network fetch failed');
  }) as typeof fetch;

  const response = await fetchRegistrationUpstream(
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
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), {
    error: 'registration_unavailable',
    message: 'Registration is temporarily unavailable. Please try again shortly.',
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});
