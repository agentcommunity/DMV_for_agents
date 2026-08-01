import { handleRegisterAgent, sha256Hex } from './index.ts'

const assert = {
  equal(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  },
  ok(value: unknown, message: string): void {
    if (!value) throw new Error(message)
  },
  match(value: string, pattern: RegExp, message: string): void {
    if (!pattern.test(value)) throw new Error(`${message}: ${JSON.stringify(value)} does not match ${pattern}`)
  },
}

const PROXY_SECRET = 'worker-secret'
const HASH_RE = /^[0-9a-f]{64}$/

interface MockResponse {
  data?: unknown
  error?: { message: string; code?: string; details?: string } | null
  count?: number | null
}

interface QueryStep {
  name: string
  args: Array<unknown>
}

function createSupabaseMock(responses: Array<MockResponse>) {
  const calls: Array<{ table: string; steps: Array<QueryStep> }> = []
  const insertedRows: Array<Record<string, unknown>> = []
  let callIndex = 0

  const createSupabaseClient = (..._clientArgs: Array<unknown>) => {
    return {
      from(table: string) {
        const response = responses[callIndex] ?? { data: null, error: null, count: null }
        callIndex += 1
        const steps: Array<QueryStep> = []
        const record = () => calls.push({ table, steps })

        const builder: Record<string, unknown> = {
          select(...args: Array<unknown>) {
            steps.push({ name: 'select', args })
            return builder
          },
          eq(...args: Array<unknown>) {
            steps.push({ name: 'eq', args })
            return builder
          },
          not(...args: Array<unknown>) {
            steps.push({ name: 'not', args })
            return builder
          },
          limit(...args: Array<unknown>) {
            steps.push({ name: 'limit', args })
            return builder
          },
          insert(row: Record<string, unknown>) {
            steps.push({ name: 'insert', args: [row] })
            insertedRows.push(row)
            return builder
          },
          async maybeSingle() {
            record()
            return { data: response.data ?? null, error: response.error ?? null }
          },
          then(
            resolve: (value: unknown) => void,
            reject: (reason: unknown) => void,
          ) {
            record()
            return Promise.resolve({
              data: response.data ?? null,
              error: response.error ?? null,
              count: response.count ?? null,
            }).then(resolve, reject)
          },
        }
        return builder
      },
    }
  }

  return { calls, insertedRows, createSupabaseClient }
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

function registerRequest(
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Request {
  return new Request('https://example.test/register-agent', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dmv-proxy': PROXY_SECRET, ...headers },
    body: JSON.stringify(body),
  })
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_name: 'mesa-agent',
    email: 'agent@example.test',
    signup_source: 'api',
    registration_type: 'AGENT',
    ...overrides,
  }
}

// A successful registration makes 4 sequential Supabase round trips, in order:
//   1. findExactExistingRegistration -> maybeSingle (not found)
//   2. lifetime-cap count           -> below CAP_UNENDORSED, no endorsed check
//   3. insert
//   4. queue-position count
function freshRegistrationResponses(): Array<MockResponse> {
  return [
    { data: null, error: null },
    { count: 0, error: null },
    { error: null },
    { count: 1, error: null },
  ]
}

// Cap-check round trips (currentCount >= CAP_UNENDORSED path), in order:
//   1. findExactExistingRegistration -> maybeSingle (not found)
//   2. lifetime-cap count           -> at/above CAP_UNENDORSED, triggers endorsed check
//   3. endorsed check               -> registrations.status = 'complete'
//   4. insert (only reached if under the resolved cap)
//   5. queue-position count (only reached if under the resolved cap)
function capCheckResponses(
  currentCount: number,
  endorsedRows: Array<MockResponse['data']>,
): Array<MockResponse> {
  return [
    { data: null, error: null },
    { count: currentCount, error: null },
    { data: endorsedRows, error: null },
    { error: null },
    { count: currentCount + 1, error: null },
  ]
}

Deno.test('endorsed cap check reads registrations.status, never endorsement_status', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    // Row has status='complete' (signed) but endorsement_status is null — the
    // dead-column bug would have missed this and wrongly capped at 5.
    const mock = createSupabaseMock(capCheckResponses(5, [{ status: 'complete' }]))

    const response = await handleRegisterAgent(
      registerRequest(validBody({ agent_name: 'endorsed-agent' })),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 201)

    const endorsedCall = mock.calls[2]
    assert.equal(endorsedCall.table, 'registrations')
    const eqSteps = endorsedCall.steps.filter((step) => step.name === 'eq')
    const eqOnEndorsementStatus = eqSteps.some((step) => step.args[0] === 'endorsement_status')
    const eqOnStatusComplete = eqSteps.some(
      (step) => step.args[0] === 'status' && step.args[1] === 'complete',
    )
    assert.equal(eqOnEndorsementStatus, false)
    assert.ok(eqOnStatusComplete, 'expected an eq("status", "complete") step')
  })
})

Deno.test('unendorsed user (no status=complete row) is capped at CAP_UNENDORSED', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock(capCheckResponses(5, []))

    const response = await handleRegisterAgent(
      registerRequest(validBody({ agent_name: 'unendorsed-agent' })),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 403)
    const payload = await response.json()
    assert.equal(payload.limit, 5)
    assert.equal(payload.endorsed, false)
    assert.equal(mock.insertedRows.length, 0)
  })
})

Deno.test('endorsed user is allowed up to CAP_ENDORSED, then capped at 12', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock(capCheckResponses(12, [{ status: 'complete' }]))

    const response = await handleRegisterAgent(
      registerRequest(validBody({ agent_name: 'maxed-endorsed-agent' })),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 403)
    const payload = await response.json()
    assert.equal(payload.limit, 12)
    assert.equal(payload.endorsed, true)
    assert.equal(mock.insertedRows.length, 0)
  })
})

Deno.test('sha256Hex produces a stable 64-char lowercase hex digest', async () => {
  const digest = await sha256Hex('203.0.113.7')
  assert.match(digest, HASH_RE, 'sha256Hex output')
  assert.equal(await sha256Hex('203.0.113.7'), digest)
  assert.equal(digest === await sha256Hex('203.0.113.8'), false)
})

Deno.test('stores a hashed client IP and never the raw value', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock(freshRegistrationResponses())
    const rawIp = '203.0.113.42'

    const response = await handleRegisterAgent(
      registerRequest(validBody(), { 'x-forwarded-for': `${rawIp}, 10.0.0.1` }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    assert.equal(response.status, 201)
    assert.equal(mock.insertedRows.length, 1)
    const metadata = mock.insertedRows[0].metadata as Record<string, unknown>

    assert.ok(!('client_ip' in metadata), 'metadata must not contain a raw client_ip key')
    assert.ok(typeof metadata.client_ip_hash === 'string', 'metadata.client_ip_hash must be a string')
    assert.match(metadata.client_ip_hash as string, HASH_RE, 'metadata.client_ip_hash')
    assert.equal(metadata.client_ip_hash, await sha256Hex(rawIp))
  })
})

Deno.test('falls back to cf-connecting-ip when x-forwarded-for is absent', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock(freshRegistrationResponses())
    const rawIp = '198.51.100.9'

    await handleRegisterAgent(
      registerRequest(validBody({ agent_name: 'cf-ip-agent' }), { 'cf-connecting-ip': rawIp }),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    const metadata = mock.insertedRows[0].metadata as Record<string, unknown>
    assert.equal(metadata.client_ip_hash, await sha256Hex(rawIp))
    assert.ok(!('client_ip' in metadata), 'metadata must not contain a raw client_ip key')
  })
})

Deno.test('stores a null client_ip_hash when no IP header is present', async () => {
  await withEnv({
    DMV_PROXY_SECRET: PROXY_SECRET,
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  }, async () => {
    const mock = createSupabaseMock(freshRegistrationResponses())

    await handleRegisterAgent(
      registerRequest(validBody({ agent_name: 'no-ip-agent' })),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )

    const metadata = mock.insertedRows[0].metadata as Record<string, unknown>
    assert.equal(metadata.client_ip_hash, null)
    assert.ok(!('client_ip' in metadata), 'metadata must not contain a raw client_ip key')
  })
})
