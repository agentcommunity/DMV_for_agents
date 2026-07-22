import assert from 'node:assert/strict';
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
  BADGE_CACHE_KV: KVNamespace;
  REGISTER_COOLDOWN_KV: KVNamespace;
  DMV_PROXY_SECRET?: string;
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

function createEnv(options: {
  badgeKv?: TrackedKv;
  cooldownKv?: TrackedKv;
  limiter?: ReturnType<typeof createLimiter>;
  secret?: string;
} = {}): { env: TestEnv; badgeKv: TrackedKv; cooldownKv: TrackedKv } {
  const badgeKv = options.badgeKv ?? createKv();
  const cooldownKv = options.cooldownKv ?? createKv();
  return {
    badgeKv,
    cooldownKv,
    env: {
      RL_CERT_LOOKUP: options.limiter ?? createLimiter(),
      BADGE_CACHE_KV: badgeKv.namespace,
      REGISTER_COOLDOWN_KV: cooldownKv.namespace,
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

test('exports the certificate lookup policy constants', () => {
  assert.equal(LOOKUP_LIMIT, 30);
  assert.equal(LOOKUP_WINDOW_SECONDS, 60);
  assert.equal(LOOKUP_POSITIVE_TTL_SECONDS, 300);
  assert.equal(LOOKUP_NEGATIVE_TTL_SECONDS, 60);
});

test('rejects an invalid check digit without calling upstream', async () => {
  const { env, badgeKv, cooldownKv } = createEnv();
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
  assert.equal(badgeKv.reads.length + cooldownKv.reads.length, 0);
  assertPrivateNoStore(response);
});

test('returns issued with a canonical permalink for an upstream row', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([
    Response.json({
      certificate_id: VALID_ID,
      agent_name: 'mesa agent',
      domain: 'mesa-agent.agent',
      source: 'private-data',
      registered_at: '2026-07-21T00:00:00Z',
      description: 'must not escape',
      metadata: { email: 'private@example.com' },
      email: 'private@example.com',
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

test('maps upstream 404 to a cached 200 not_found result', async () => {
  const { env, badgeKv } = createEnv();
  const upstream = createFetch([new Response('not found', { status: 404 })]);

  const first = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const second = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  for (const response of [first, second]) {
    assert.equal(response.status, 200);
    assert.deepEqual(await readJson(response), {
      certificate_id: VALID_ID,
      status: 'not_found',
      valid_format: true,
      issued: false,
      agent_name: null,
      certificate_url: null,
    });
    assertPrivateNoStore(response);
  }
  assert.equal(upstream.calls.length, 1);
  assert.equal(badgeKv.writes.length, 1);
  assert.equal(badgeKv.writes[0].options?.expirationTtl, LOOKUP_NEGATIVE_TTL_SECONDS);
});

test('does not cache an upstream 500 and returns unavailable', async () => {
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
  const { env, badgeKv, cooldownKv } = createEnv({ limiter });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 429);
  assert.deepEqual(await readJson(response), { error: 'rate_limited', retry_after_seconds: 60 });
  assert.equal(response.headers.get('Retry-After'), '60');
  assert.equal(response.headers.get('RateLimit-Reset'), '60');
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(cooldownKv.reads.length + cooldownKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('continues to the KV limiter when the Cloudflare binding throws', async (t) => {
  const logged: Array<unknown> = [];
  t.mock.method(console, 'error', (...values: Array<unknown>) => logged.push(values));
  const limiter = createLimiter({ throws: true });
  const { env, cooldownKv } = createEnv({ limiter });
  const upstream = createFetch([new Response(null, { status: 404 })]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.equal((await readJson(response)).status, 'not_found');
  assert.equal(logged.length, 1);
  assert.match(String((logged[0] as Array<unknown>)[0]), /limiter/i);
  assert.equal(cooldownKv.reads.length, 1);
  assert.equal(cooldownKv.writes.length, 1);
  assert.equal(upstream.calls.length, 1);
  assertPrivateNoStore(response);
});

test('fails closed when both limiter layers are unavailable', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const limiter = createLimiter({ throws: true });
  const cooldownKv = createKv({ failRead: true });
  const { env, badgeKv } = createEnv({ limiter, cooldownKv });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('fails closed when Cloudflare throws and the stored KV counter is corrupt', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const limiter = createLimiter({ throws: true });
  const cooldownKv = createKv({ readValue: 'not-a-number' });
  const { env, badgeKv } = createEnv({ limiter, cooldownKv });
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
  assertPrivateNoStore(response);
});

test('fails closed when KV is indeterminate even if Cloudflare allows', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  const cooldownKv = createKv({ failRead: true });
  const { env, badgeKv } = createEnv({ cooldownKv });
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
  assertPrivateNoStore(response);
});

test('maps SHA-256 digest rejection to unavailable before cache or upstream', async (t) => {
  t.mock.method(console, 'error', () => undefined);
  t.mock.method(crypto.subtle, 'digest', async () => {
    throw new Error('digest unavailable');
  });
  const { env, badgeKv, cooldownKv } = createEnv();
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
  assert.equal(cooldownKv.reads.length + cooldownKv.writes.length, 0);
  assert.equal(badgeKv.reads.length + badgeKv.writes.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('selects the wall-clock bucket after a delayed SHA-256 digest', async (t) => {
  let now = 1_752_537_659_000;
  const digest = crypto.subtle.digest.bind(crypto.subtle);
  t.mock.method(Date, 'now', () => now);
  t.mock.method(crypto.subtle, 'digest', async (algorithm, data) => {
    now += 1_000;
    return await digest(algorithm, data);
  });
  const { env, cooldownKv } = createEnv();
  const upstream = createFetch([new Response(null, { status: 404 })]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('RateLimit-Reset'), '60');
  assert.equal(cooldownKv.writes.length, 1);
  assert.equal(cooldownKv.writes[0].key.endsWith(`:${Math.floor(now / 60_000)}`), true);
});

test('returns 429 after 30 sequential KV-counted lookups', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_600_000);
  const rawIp = '198.51.100.42';
  const { env, cooldownKv } = createEnv();
  const upstream = createFetch([new Response(null, { status: 404 })]);

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
  assert.ok(cooldownKv.reads.every((key) => !key.includes(rawIp)));
  assert.ok(cooldownKv.writes.every(({ key }) => !key.includes(rawIp)));
  assertPrivateNoStore(denied);
});

test('starts a fresh KV budget at the next wall-clock minute', async (t) => {
  let now = 1_752_537_600_000;
  t.mock.method(Date, 'now', () => now);
  const { env, cooldownKv } = createEnv();
  const upstream = createFetch([new Response(null, { status: 404 })]);

  await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const firstKey = cooldownKv.writes[0].key;
  now += 60_000;
  await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);
  const secondKey = cooldownKv.writes[1].key;

  assert.notEqual(firstKey, secondKey);
  assert.equal(cooldownKv.values.has(firstKey), true);
  assert.equal(cooldownKv.values.has(secondKey), true);
});

test('reports one second until the active minute bucket resets', async (t) => {
  t.mock.method(Date, 'now', () => 1_752_537_659_000);
  const limiter = createLimiter({ success: false });
  const { env } = createEnv({ limiter });

  const response = await handleCertificateLookup(lookupRequest(), env, createFetch([]).fetchImpl);

  assert.deepEqual(await readJson(response), { error: 'rate_limited', retry_after_seconds: 1 });
  assert.equal(response.headers.get('Retry-After'), '1');
  assert.equal(response.headers.get('RateLimit-Reset'), '1');
  assertPrivateNoStore(response);
});

test('maps a wrong Worker secret upstream 403 to unavailable', async () => {
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
  const { env, badgeKv, cooldownKv } = createEnv({ limiter, secret: '' });
  const upstream = createFetch([]);

  const response = await handleCertificateLookup(lookupRequest(), env, upstream.fetchImpl);

  assert.equal(response.status, 503);
  assert.equal((await readJson(response)).status, 'unavailable');
  assert.equal(limiter.calls.length, 0);
  assert.equal(badgeKv.reads.length + cooldownKv.reads.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});

test('allows only GET', async () => {
  const { env, badgeKv, cooldownKv } = createEnv();
  const upstream = createFetch([]);
  const request = new Request(`https://dmv.agentcommunity.org/api/lookup?id=${VALID_ID}`, {
    method: 'POST',
  });

  const response = await handleCertificateLookup(request, env, upstream.fetchImpl);

  assert.equal(response.status, 405);
  assert.equal(response.headers.get('Allow'), 'GET');
  assert.deepEqual(await readJson(response), { error: 'method_not_allowed' });
  assert.equal(badgeKv.reads.length + cooldownKv.reads.length, 0);
  assert.equal(upstream.calls.length, 0);
  assertPrivateNoStore(response);
});
