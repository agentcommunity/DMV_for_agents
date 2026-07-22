import { handleLookupAgent } from './index.ts'

const assert = {
  equal(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  },
  notEqual(actual: unknown, expected: unknown): void {
    if (Object.is(actual, expected)) {
      throw new Error(`Expected a value other than ${JSON.stringify(expected)}`)
    }
  },
  deepEqual(actual: unknown, expected: unknown): void {
    const actualJson = JSON.stringify(actual)
    const expectedJson = JSON.stringify(expected)
    if (actualJson !== expectedJson) {
      throw new Error(`Expected ${expectedJson}, got ${actualJson}`)
    }
  },
}

const VALID_CERTIFICATE_ID = 'MESA-DD6-660J'
const PROXY_SECRET = 'worker-secret'

interface QueryCall {
  name: 'from' | 'select' | 'eq' | 'maybeSingle'
  args: Array<unknown>
}

interface MockRow {
  certificate_id: string
  domain_requested: string
  registration_type?: string
  signup_source?: string
  created_at?: string
  metadata?: Record<string, unknown>
}

function createSupabaseMock(result: { data: MockRow | null; error: { message: string } | null }) {
  const calls: Array<QueryCall> = []
  const query = {
    from(...args: Array<unknown>) {
      calls.push({ name: 'from', args })
      return query
    },
    select(...args: Array<unknown>) {
      calls.push({ name: 'select', args })
      return query
    },
    eq(...args: Array<unknown>) {
      calls.push({ name: 'eq', args })
      return query
    },
    async maybeSingle(...args: Array<unknown>) {
      calls.push({ name: 'maybeSingle', args })
      return result
    },
  }
  const clientFactoryCalls: Array<Array<unknown>> = []
  const createSupabaseClient = (...args: Array<unknown>) => {
    clientFactoryCalls.push(args)
    return query
  }

  return { calls, clientFactoryCalls, createSupabaseClient }
}

async function withEnv(
  values: Record<string, string | undefined>,
  operation: () => Promise<void>,
): Promise<void> {
  const previous = new Map<string, string | undefined>()
  for (const [key, value] of Object.entries(values)) {
    previous.set(key, Deno.env.get(key))
    if (value === undefined) Deno.env.delete(key)
    else Deno.env.set(key, value)
  }

  try {
    await operation()
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) Deno.env.delete(key)
      else Deno.env.set(key, value)
    }
  }
}

function lookupRequest(
  query = `id=${encodeURIComponent(VALID_CERTIFICATE_ID)}`,
  options: RequestInit = {},
): Request {
  return new Request(`https://example.test/lookup-agent?${query}`, options)
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>
}

Deno.test('fails closed for every method when DMV_PROXY_SECRET is unset', async () => {
  await withEnv({ DMV_PROXY_SECRET: undefined }, async () => {
    const mock = createSupabaseMock({ data: null, error: null })

    for (const method of ['GET', 'POST', 'OPTIONS']) {
      const response = await handleLookupAgent(
        lookupRequest(undefined, { method, headers: { 'x-dmv-proxy': PROXY_SECRET } }),
        { createSupabaseClient: mock.createSupabaseClient as never },
      )

      assert.equal(response.status, 403)
      assert.deepEqual(await readJson(response), { error: 'direct_access_deprecated' })
    }
    assert.equal(mock.clientFactoryCalls.length, 0)
  })
})

Deno.test('rejects missing and wrong proxy secrets before creating a client', async () => {
  await withEnv({ DMV_PROXY_SECRET: PROXY_SECRET }, async () => {
    const mock = createSupabaseMock({ data: null, error: null })

    for (const headers of [undefined, { 'x-dmv-proxy': 'wrong-secret' }]) {
      const response = await handleLookupAgent(
        lookupRequest(undefined, { headers }),
        { createSupabaseClient: mock.createSupabaseClient as never },
      )

      assert.equal(response.status, 403)
      assert.deepEqual(await readJson(response), { error: 'direct_access_deprecated' })
    }
    assert.equal(mock.clientFactoryCalls.length, 0)
  })
})

Deno.test('allows a certificate-ID lookup with the correct proxy secret', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock({
      data: {
        certificate_id: VALID_CERTIFICATE_ID,
        domain_requested: 'mesa-agent.agent',
      },
      error: null,
    })

    const response = await handleLookupAgent(
      lookupRequest(undefined, { headers: { 'x-dmv-proxy': PROXY_SECRET } }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(mock.clientFactoryCalls, [[
      'https://project.supabase.test',
      'service-role-key',
    ]])
    assert.deepEqual(mock.calls, [
      { name: 'from', args: ['registrations'] },
      { name: 'select', args: ['certificate_id, domain_requested'] },
      { name: 'eq', args: ['certificate_id', VALID_CERTIFICATE_ID] },
      { name: 'maybeSingle', args: [] },
    ])
  })
})

Deno.test('returns the exact typed not_found envelope with HTTP 200', async () => {
  await withEnv({ DMV_PROXY_SECRET: PROXY_SECRET }, async () => {
    const mock = createSupabaseMock({ data: null, error: null })

    const response = await handleLookupAgent(
      lookupRequest(undefined, { headers: { 'x-dmv-proxy': PROXY_SECRET } }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      status: 'not_found',
      certificate_id: VALID_CERTIFICATE_ID,
    })
  })
})

Deno.test('returns only the public certificate fields on success', async () => {
  await withEnv({ DMV_PROXY_SECRET: PROXY_SECRET }, async () => {
    const mock = createSupabaseMock({
      data: {
        certificate_id: VALID_CERTIFICATE_ID,
        domain_requested: 'mesa-agent.agent',
        registration_type: 'AGENT',
        signup_source: 'private-source',
        created_at: '2026-07-21T00:00:00Z',
        metadata: { agent_description: 'private description' },
      },
      error: null,
    })

    const response = await handleLookupAgent(
      lookupRequest(undefined, { headers: { 'x-dmv-proxy': PROXY_SECRET } }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 200)
    assert.deepEqual(await readJson(response), {
      status: 'issued',
      certificate_id: VALID_CERTIFICATE_ID,
      agent_name: 'mesa-agent',
      domain: 'mesa-agent.agent',
    })
  })
})

Deno.test('rejects domain lookup without creating a client', async () => {
  await withEnv({ DMV_PROXY_SECRET: PROXY_SECRET }, async () => {
    const mock = createSupabaseMock({ data: null, error: null })

    const response = await handleLookupAgent(
      lookupRequest('domain=mesa-agent.agent', {
        headers: { 'x-dmv-proxy': PROXY_SECRET },
      }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 400)
    assert.equal(mock.clientFactoryCalls.length, 0)
  })
})

Deno.test('OPTIONS does not disclose permissive public CORS', async () => {
  await withEnv({ DMV_PROXY_SECRET: PROXY_SECRET }, async () => {
    const mock = createSupabaseMock({ data: null, error: null })

    const response = await handleLookupAgent(
      lookupRequest(undefined, {
        method: 'OPTIONS',
        headers: { 'x-dmv-proxy': PROXY_SECRET },
      }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 204)
    assert.notEqual(response.headers.get('Access-Control-Allow-Origin'), '*')
    assert.equal(mock.clientFactoryCalls.length, 0)
  })
})
