import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  handleCertificateLookup,
  LOOKUP_LIMIT,
  LOOKUP_NEGATIVE_TTL_SECONDS,
  LOOKUP_POSITIVE_TTL_SECONDS,
  LOOKUP_WINDOW_SECONDS,
} from '../worker/certificate-lookup.ts';
import { verifyCertificateId } from '../worker/certificate.ts';

const VALID_ID = 'MESA-DD6-660J';
assert.equal(verifyCertificateId(VALID_ID), true);

interface TrackedKv {
  namespace: KVNamespace;
  values: Map<string, string>;
  reads: Array<string>;
  writes: Array<{ key: string; value: string; options?: KVNamespacePutOptions }>;
}

interface TestEnv {
  RL_CERT_LOOKUP: {
    calls: Array<string>;
    limit(options: { key: string }): Promise<{ success: boolean }>;
  };
  CERT_LOOKUP_LIMITER: DurableObjectNamespace;
  BADGE_CACHE_KV: KVNamespace;
  DMV_PROXY_SECRET?: string;
}

interface TrackedDurableLimiter {
  namespace: DurableObjectNamespace;
  names: Array<string>;
  requests: Array<Request>;
}

function createKv(options: {
  failRead?: boolean;
  failWrite?: boolean;
  readValue?: string;
} = {}): TrackedKv {
  const values = new Map<string, string>();
  const reads: Array<string> = [];
  const writes: Array<{ key: string; value: string; options?: KVNamespacePutOptions }> = [];

  return {
    values,
    reads,
    writes,
    namespace: {
      async get(key: string) {
        reads.push(key);
        if (options.failRead) throw new Error('KV read unavailable');
        if (options.readValue !== undefined) return options.readValue;
        return values.get(key) ?? null;
      },
      async put(key: string, value: string, putOptions?: KVNamespacePutOptions) {
        writes.push({ key, value, options: putOptions });
        if (options.failWrite) throw new Error('KV write unavailable');
        values.set(key, value);
      },
    } as KVNamespace,
  };
}

function createLimiter(options: { success?: boolean; throws?: boolean } = {}) {
  const calls: Array<string> = [];
  return {
    calls,
    async limit({ key }: { key: string }) {
      calls.push(key);
      if (options.throws) throw new Error('Cloudflare limiter unavailable');
      return { success: options.success ?? true };
    },
  };
}

function createDurableLimiter(options: {
  throws?: boolean;
  invalidResponse?: boolean;
  decision?: { allowed: boolean; remaining: number; reset: number };
} = {}): TrackedDurableLimiter {
  const names: Array<string> = [];
  const requests: Array<Request> = [];
  const counts = new Map<string, number>();
  let activeName = '';

  return {
    names,
    requests,
    namespace: {
      idFromName(name: string) {
        names.push(name);
        activeName = name;
        return { toString: () => name } as DurableObjectId;
      },
      get() {
        const objectName = activeName;
        return {
          async fetch(request: Request) {
            requests.push(request.clone());
            if (options.throws) throw new Error('Durable Object unavailable');
            if (options.invalidResponse) return Response.json({ allowed: 'yes' });
            if (options.decision) return Response.json(options.decision);
            const count = (counts.get(objectName) ?? 0) + 1;
            counts.set(objectName, count);
            return Response.json({
              allowed: count <= LOOKUP_LIMIT,
              remaining: Math.max(0, LOOKUP_LIMIT - count),
              reset: 60,
            });
          },
        };
      },
    } as unknown as DurableObjectNamespace,
  };
}

function createEnv(options: {
  badgeKv?: TrackedKv;
  limiter?: ReturnType<typeof createLimiter>;
  durableLimiter?: TrackedDurableLimiter;
  secret?: string;
} = {}): { env: TestEnv; badgeKv: TrackedKv; durableLimiter: TrackedDurableLimiter } {
  const badgeKv = options.badgeKv ?? createKv();
  const durableLimiter = options.durableLimiter ?? createDurableLimiter();
  return {
    badgeKv,
    durableLimiter,
    env: {
      RL_CERT_LOOKUP: options.limiter ?? createLimiter(),
      CERT_LOOKUP_LIMITER: durableLimiter.namespace,
      BADGE_CACHE_KV: badgeKv.namespace,
      DMV_PROXY_SECRET: options.secret ?? 'worker-secret',
    },
  };
}

function lookupRequest(
  id = VALID_ID,
  headers: Record<string, string> = { 'cf-connecting-ip': '203.0.113.7' },
): Request {
  return new Request(`https://dmv.agentcommunity.org/api/lookup?id=${encodeURIComponent(id)}`, {
    headers,
  });
}

function createFetch(responses: Array<Response>) {
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    const response = responses.shift();
    assert.ok(response, 'fetch mock received an unexpected call');
    return response;
  }) as typeof fetch;
  return { calls, fetchImpl };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function assertPrivateNoStore(response: Response): void {
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
}

function assertNoExactRateLimitTelemetry(response: Response): void {
  assert.equal(response.headers.get('RateLimit-Remaining'), null);
  assert.equal(response.headers.get('RateLimit-Reset'), null);
}

test('exports the certificate lookup policy constants', () => {
  assert.equal(LOOKUP_LIMIT, 30);
  assert.equal(LOOKUP_WINDOW_SECONDS, 60);
  assert.equal(LOOKUP_POSITIVE_TTL_SECONDS, 300);
  assert.equal(LOOKUP_NEGATIVE_TTL_SECONDS, 60);
});

test('Worker imports and dispatches /api/lookup before static assets', async () => {
  const source = await readFile(new URL('../worker/index.ts', import.meta.url), 'utf8');

  assert.match(source, /import \{ handleCertificateLookup \} from '\.\/certificate-lookup';/);
  assert.match(
    source,
    /if \(url\.pathname === '\/api\/lookup'\) return handleCertificateLookup\(request, env\);/,
  );
  assert.ok(
    source.indexOf("if (url.pathname === '/api/lookup')")
    < source.indexOf('return env.ASSETS.fetch(request);'),
  );
});

test('rejects an invalid check digit without calling upstream', async () => {
  const { env, badgeKv, durableLimiter } = createEnv();
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(
    lookupRequest('MESA-DD6-660K'),
    env,
    upstream.fetchImpl,
  );

  assert.equal(response.status, 400);
  assert.deepEqual(await readJson(response), {
    certificate_id: 'MESA-DD6-660K',
    status: 'invalid_format',
    valid_format: false,
    issued: false,
    agent_name: null,
    certificate_url: null,
  });
  assert.equal(upstream.calls.length, 0);
  assert.equal(badgeKv.reads.length + durableLimiter.requests.length, 0);
  assertNoExactRateLimitTelemetry(response);
  assertPrivateNoStore(response);
});

test('returns issued with a canonical permalink for an upstream row', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({
      status: 'issued',
      certificate_id: VALID_ID,
      agent_name: 'mesa agent',
      domain: 'mesa-agent.agent',
    }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.deepEqual(await readJson(response), {
    certificate_id: VALID_ID,
    status: 'issued',
    valid_format: true,
    issued: true,
    agent_name: 'mesa agent',
    certificate_url: `https://dmv.agentcommunity.org/c/${VALID_ID}/mesa%20agent`,
  });
  assert.equal(upstream.calls.length, 1);
  assert.equal(
    upstream.calls[0].input,
    `https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/lookup-agent?id=${VALID_ID}`,
  );
  assert.equal(new Headers(upstream.calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
  assert.equal(badgeKv.writes[0].key, `lookup:v1:${VALID_ID}`);
  assert.equal(badgeKv.writes[0].options?.expirationTtl, LOOKUP_POSITIVE_TTL_SECONDS);
  assertPrivateNoStore(response);
});

test('rejects an upstream certificate ID mismatch without caching it', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({
      status: 'issued',
      certificate_id: 'MESA-DD6-660K',
      agent_name: 'mesa-agent',
      domain: 'mesa-agent.agent',
    }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
  assertPrivateNoStore(response);
});

test('rejects a whitespace-only upstream agent name without caching it', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({
      status: 'issued',
      certificate_id: VALID_ID,
      agent_name: '   ',
      domain: 'mesa-agent.agent',
    }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
  assertPrivateNoStore(response);
});

test('fails closed for an upstream redirect without following it or forwarding the secret', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { env, badgeKv } = createEnv();
  const redirectTarget = 'https://redirect.example.test/collect-secret';
  const upstream = createFetch([
    new Response(null, {
      status: 302,
      headers: { Location: redirectTarget },
    }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(upstream.calls.length, 1);
  assert.equal(upstream.calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(upstream.calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
  assert.ok(upstream.calls.every(({ input }) => input !== redirectTarget));
  assert.equal(badgeKv.writes.length, 0);
  assertPrivateNoStore(response);
});

test('maps an upstream fetch rejection to unavailable with manual redirect mode', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { env, badgeKv } = createEnv();
  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ input, init });
    throw new TypeError('network fetch failed');
  }) as typeof fetch;

  const response = await handleCertificateLookup(lookupRequest(), env, fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init?.redirect, 'manual');
  assert.equal(new Headers(calls[0].init?.headers).get('x-dmv-proxy'), 'worker-secret');
  assert.equal(badgeKv.writes.length, 0);
  assertPrivateNoStore(response);
});

test('logs a safe upstream failure class when the upstream fetch rejects', async (t) => {
  const logged: Array<Array<unknown>> = [];
  t.mock.method(console, 'error', (...values: Array<unknown>) => logged.push(values));
  const secret = 'worker-secret-must-not-appear-in-logs';
  const { env } = createEnv({ secret });
  const upstreamUrl = 'https://upstream.example.test/lookup-agent?id=MESA-DD6-660J';
  const fetchImpl = (async () => {
    throw new TypeError(`network failure for ${upstreamUrl} using ${secret}`);
  }) as typeof fetch;

  const response = await handleCertificateLookup(lookupRequest(), env, fetchImpl);

  assert.equal(response.status, 503);
  assert.deepEqual(logged, [
    [
      '[certificate-lookup] upstream fetch failed',
      { error_name: 'TypeError' },
    ],
  ]);
  assert.equal(JSON.stringify(logged).includes(secret), false);
  assert.equal(JSON.stringify(logged).includes(upstreamUrl), false);
});

test('logs only the upstream status for a non-200 upstream response', async (t) => {
  const logged: Array<Array<unknown>> = [];
  t.mock.method(console, 'error', (...values: Array<unknown>) => logged.push(values));
  const { env } = createEnv();
  const upstream = createFetch([
    new Response('do-not-log-this-body', { status: 502 }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.deepEqual(logged, [
    [
      '[certificate-lookup] upstream returned non-200',
      { upstream_status: 502 },
    ],
  ]);
  assert.equal(JSON.stringify(logged).includes('do-not-log-this-body'), false);
});

test('maps a platform-style upstream 404 to unavailable twice without caching', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    new Response('function not found', { status: 404 }),
    new Response('function not found', { status: 404 }),
  ]);

  const first = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const second = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  for (const response of [first, second]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await readJson(response), {
      certificate_id: VALID_ID,
      status: 'unavailable',
      valid_format: true,
      issued: null,
      agent_name: null,
      certificate_url: null,
    });
    assertPrivateNoStore(response);
  }
  assert.equal(upstream.calls.length, 2);
  assert.equal(badgeKv.writes.length, 0);
});

test('maps a typed not_found envelope to public absence and caches it', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID }),
  ]);

  const first = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const second = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    assert.equal((await readJson(response)).status, 'not_found');
  }
  assert.equal(upstream.calls.length, 1);
  assert.equal(badgeKv.writes.length, 1);
  assert.equal(badgeKv.writes[0].options?.expirationTtl, LOOKUP_NEGATIVE_TTL_SECONDS);
});

test('rejects a mismatched typed not_found certificate ID without caching it', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: 'MESA-DD6-660K' }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
});

test('rejects an unknown typed upstream status without caching it', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({ status: 'pending', certificate_id: VALID_ID }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
});

test('maps malformed HTTP-200 JSON to uncached unavailable', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    new Response('{', { status: 200, headers: { 'Content-Type': 'application/json' } }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
});

test('maps extra-field typed envelopes to uncached unavailable', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID, extra: true }),
    Response.json({
      status: 'issued',
      certificate_id: VALID_ID,
      agent_name: 'mesa-agent',
      domain: 'mesa-agent.agent',
      extra: true,
    }),
  ]);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
    assert.equal(response.status, 503);
    assert.equal((await readJson(response)).status, 'unavailable');
  }
  assert.equal(upstream.calls.length, 2);
  assert.equal(badgeKv.writes.length, 0);
});

test('does not cache an upstream 500 and returns unavailable', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({ error: 'database details' }, { status: 500 }),
    Response.json({ error: 'database details' }, { status: 500 }),
  ]);

  const first = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const second = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  for (const response of [first, second]) {
    assert.equal(response.status, 503);
    assert.deepEqual(await readJson(response), {
      certificate_id: VALID_ID,
      status: 'unavailable',
      valid_format: true,
      issued: null,
      agent_name: null,
      certificate_url: null,
    });
    assertPrivateNoStore(response);
  }
  assert.equal(upstream.calls.length, 2);
  assert.equal(badgeKv.writes.length, 0);
});

test('returns 429 when the Cloudflare limiter rejects', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const limiter = createLimiter({ success: false });
  const { env, badgeKv, durableLimiter } = createEnv({ limiter });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 429);
  assert.deepEqual(await readJson(response), { error: 'rate_limited', retry_after_seconds: 60 });
  assert.equal(response.headers.get('Retry-After'), '60');
  assertNoExactRateLimitTelemetry(response);
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(durableLimiter.requests.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('continues to the exact Durable Object when the Cloudflare binding throws', async (t) => {
  const logged: Array<unknown> = [];
  t.mock.method(console, 'error', (...values: Array<unknown>) => logged.push(values));
  const limiter = createLimiter({ throws: true });
  const { env, durableLimiter } = createEnv({ limiter });
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).status, 'not_found');
  assert.equal(logged.length, 1);
  assert.match(String((logged[0] as Array<unknown>)[0]), /limiter/i);
  assert.equal(durableLimiter.requests.length, 1);
  assert.equal(upstream.calls.length, 1);
  assertPrivateNoStore(response);
});

test('fails closed before cache or upstream when the Durable Object throws', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const durableLimiter = createDurableLimiter({ throws: true });
  const { env, badgeKv } = createEnv({ durableLimiter });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assertNoExactRateLimitTelemetry(response);
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('fails closed before cache or upstream for an invalid Durable Object response', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const durableLimiter = createDurableLimiter({ invalidResponse: true });
  const { env, badgeKv } = createEnv({ durableLimiter });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.deepEqual(await readJson(response), {
    certificate_id: VALID_ID,
    status: 'unavailable',
    valid_format: true,
    issued: null,
    agent_name: null,
    certificate_url: null,
  });
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertNoExactRateLimitTelemetry(response);
  assertPrivateNoStore(response);
});

test('maps SHA-256 digest rejection to unavailable before cache or upstream', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(crypto.subtle, 'digest', async () => {
    throw new Error('digest unavailable');
  });
  const { env, badgeKv, durableLimiter } = createEnv();
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.deepEqual(await readJson(response), {
    certificate_id: VALID_ID,
    status: 'unavailable',
    valid_format: true,
    issued: null,
    agent_name: null,
    certificate_url: null,
  });
  assert.equal(durableLimiter.requests.length, 0);
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertNoExactRateLimitTelemetry(response);
  assertPrivateNoStore(response);
});

test('sends a bodyless POST so the Durable Object owns the processing clock', async () => {
  const { env, durableLimiter } = createEnv();
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('RateLimit-Reset'), '60');
  assert.equal(durableLimiter.requests.length, 1);
  assert.equal(durableLimiter.requests[0].method, 'POST');
  assert.equal(durableLimiter.requests[0].body, null);
  assert.equal(durableLimiter.requests[0].headers.get('Content-Type'), null);
});

test('returns 429 after 30 exact Durable Object-counted lookups without exposing raw IP', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const rawIp = '198.51.100.42';
  const limiter = createLimiter();
  const { env, badgeKv, durableLimiter } = createEnv({ limiter });
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID }),
  ]);

  for (let count = 0; count < LOOKUP_LIMIT; count += 1) {
    const response = await handleCertificateLookup(
      lookupRequest(VALID_ID, { 'cf-connecting-ip': rawIp }),
      env,
      upstream.fetchImpl,
    );
    assert.equal(response.status, 200);
  }

  const denied = await handleCertificateLookup(
    lookupRequest(VALID_ID, { 'cf-connecting-ip': rawIp }),
    env,
    upstream.fetchImpl,
  );

  assert.equal(denied.status, 429);
  assert.deepEqual(await readJson(denied), { error: 'rate_limited', retry_after_seconds: 60 });
  assert.equal(denied.headers.get('RateLimit-Remaining'), '0');
  assert.equal(denied.headers.get('Retry-After'), '60');
  assert.equal(durableLimiter.requests.length, 31);
  assert.ok(durableLimiter.names.every((name) => !name.includes(rawIp)));
  assert.ok(limiter.calls.every((key) => !key.includes(rawIp)));
  assert.ok(badgeKv.reads.every((key) => !key.includes(rawIp)));
  assert.ok(badgeKv.writes.every(({ key }) => !key.includes(rawIp)));
  assert.ok(durableLimiter.requests.every((request) => !request.url.includes(rawIp)));
  assert.equal(upstream.calls.length, 1);
  assertPrivateNoStore(denied);
});

test('uses exact Durable Object remaining and reset values in public headers', async () => {
  const durableLimiter = createDurableLimiter({
    decision: { allowed: true, remaining: 12, reset: 7 },
  });
  const { env } = createEnv({ durableLimiter });
  const upstream = createFetch([
    Response.json({ status: 'not_found', certificate_id: VALID_ID }),
  ]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('RateLimit-Remaining'), '12');
  assert.equal(response.headers.get('RateLimit-Reset'), '7');
  assertPrivateNoStore(response);
});

test('uses an exact Durable Object denial for the public 429 response', async () => {
  const durableLimiter = createDurableLimiter({
    decision: { allowed: false, remaining: 0, reset: 1 },
  });
  const { env } = createEnv({ durableLimiter });
  const response = await handleCertificateLookup(lookupRequest(), env, createFetch([]).fetchImpl);

  assert.deepEqual(await readJson(response), { error: 'rate_limited', retry_after_seconds: 1 });
  assert.equal(response.headers.get('Retry-After'), '1');
  assert.equal(response.headers.get('RateLimit-Reset'), '1');
});

test('maps a wrong Worker secret upstream 403 to unavailable', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([Response.json({ error: 'secret mismatch' }, { status: 403 })]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.writes.length, 0);
  assertPrivateNoStore(response);
});

test('fails loud when DMV_PROXY_SECRET is absent', async () => {
  const limiter = createLimiter();
  const { env, badgeKv, durableLimiter } = createEnv({ limiter, secret: '' });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(limiter.calls.length, 0);
  assert.equal(badgeKv.reads.length + durableLimiter.requests.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertNoExactRateLimitTelemetry(response);
  assertPrivateNoStore(response);
});

test('allows only GET', async () => {
  const { env, badgeKv, durableLimiter } = createEnv();
  const upstream = createFetch([]);
  const request = new Request(`https://dmv.agentcommunity.org/api/lookup?id=${VALID_ID}`, {
    method: 'POST',
  });

  const response = await handleCertificateLookup(request, env, upstream.fetchImpl);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
  assert.deepEqual(await readJson(response), { error: 'method_not_allowed' });
  assertNoExactRateLimitTelemetry(response);
  assert.equal(badgeKv.reads.length + durableLimiter.requests.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});
