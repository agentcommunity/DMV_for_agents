import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchRegistrationUpstream } from '../worker/registration-upstream.ts';

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
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});

test('maps a registration upstream redirect response to a safe error', async () => {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    return new Response(null, {
      status: 307,
      headers: { Location: 'https://redirect.example.test/collect-secret' },
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
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});

test('rejects a registration upstream redirect without forwarding the secret again', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    throw new TypeError('redirect mode is error');
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
  assert.equal(calls[0].init?.redirect, 'error');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
});
