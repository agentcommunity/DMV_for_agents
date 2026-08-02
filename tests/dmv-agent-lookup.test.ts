import assert from 'node:assert/strict';
import test from 'node:test';

import { verifyCertificate } from '../packages/dmv-agent/src/lookup.ts';

const CERTIFICATE_ID = 'MESA-DD6-660J';
const AGENT_NAME = 'smoke-agent';
const CERTIFICATE_URL =
  `https://dmv.agentcommunity.org/c/${CERTIFICATE_ID}/${AGENT_NAME}`;

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function publicEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    certificate_id: CERTIFICATE_ID,
    status: 'issued',
    valid_format: true,
    issued: true,
    agent_name: AGENT_NAME,
    certificate_url: CERTIFICATE_URL,
    ...overrides,
  };
}

async function expectFallback(status: number, body: unknown): Promise<void> {
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async () => response(status, body),
  });
  assert.equal(result.checkMode, 'format_only');
  assert.equal(result.formatValid, true);
  assert.equal(typeof result.fallbackReason, 'string');
  assert.equal(result.status, undefined);
  assert.equal(result.issued, undefined);
}

test('live lookup sends GET with redirects disabled', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return response(200, publicEnvelope());
    },
  });

  assert.equal(seenUrl, `https://dmv.agentcommunity.org/api/lookup?id=${CERTIFICATE_ID}`);
  assert.equal(seenInit?.method, 'GET');
  assert.equal(seenInit?.redirect, 'manual');
  assert.equal(result.checkMode, 'live');
  assert.equal(result.status, 'issued');
});

test('typed HTTP 503 unavailable stays a live inconclusive result', async () => {
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async () => response(503, publicEnvelope({
      status: 'unavailable',
      issued: null,
      agent_name: null,
      certificate_url: null,
    })),
  });

  assert.equal(result.checkMode, 'live');
  assert.equal(result.status, 'unavailable');
  assert.equal(result.issued, null);
});

test('a valid Worker 429 is distinct and preserves bounded retry metadata', async () => {
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async () => response(429, { error: 'rate_limited', retry_after_seconds: 37 }),
  });

  assert.equal(result.checkMode, 'live');
  assert.equal(result.rateLimited, true);
  assert.equal(result.retryAfterSeconds, 37);
});

test('a JSON-like but invalid media type falls back safely', async () => {
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async () => new Response(JSON.stringify(publicEnvelope()), {
      status: 200,
      headers: { 'Content-Type': 'application/jsonp' },
    }),
  });

  assert.equal(result.checkMode, 'format_only');
  assert.match(result.fallbackReason ?? '', /non-JSON response/);
});

for (const [label, status, body] of [
  ['redirect', 302, publicEnvelope()],
  ['issued body on HTTP 503', 503, publicEnvelope()],
  ['unavailable body on HTTP 200', 200, publicEnvelope({
    status: 'unavailable', issued: null, agent_name: null, certificate_url: null,
  })],
  ['not-found body on HTTP 404', 404, publicEnvelope({
    status: 'not_found', issued: false, agent_name: null, certificate_url: null,
  })],
  ['malformed 429', 429, { error: 'rate_limited', retry_after_seconds: '37' }],
] as const) {
  test(`unexpected HTTP/body relationship (${label}) falls back safely`, async () => {
    await expectFallback(status, body);
  });
}

for (const [label, body] of [
  ['mismatched certificate id', publicEnvelope({ certificate_id: 'REEF-068-BD0Q' })],
  ['false valid_format on issued', publicEnvelope({ valid_format: false })],
  ['issued false on issued', publicEnvelope({ issued: false })],
  ['empty agent name', publicEnvelope({ agent_name: '' })],
  ['wrong canonical certificate URL', publicEnvelope({ certificate_url: `${CERTIFICATE_URL}/extra` })],
  ['partial object', { status: 'issued' }],
  ['extra public field', publicEnvelope({ email: 'private@example.com' })],
  ['unknown status', publicEnvelope({ status: 'complete' })],
] as const) {
  test(`adversarial public envelope (${label}) falls back safely`, async () => {
    await expectFallback(200, body);
  });
}

test('exact not_found envelope is a confirmed live absence', async () => {
  const result = await verifyCertificate(CERTIFICATE_ID, {
    fetchFn: async () => response(200, publicEnvelope({
      status: 'not_found',
      issued: false,
      agent_name: null,
      certificate_url: null,
    })),
  });

  assert.equal(result.checkMode, 'live');
  assert.equal(result.status, 'not_found');
  assert.equal(result.issued, false);
});
