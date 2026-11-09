import { handleBadge } from './index.ts'

function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(message)
}

const VALID_CERTIFICATE_ID = 'MESA-DD6-660J'

async function withEnv(values: Record<string, string | undefined>, operation: () => Promise<void>): Promise<void> {
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

function createSupabaseMock(row: { certificate_id: string; domain_requested: string } | null) {
  const clientFactoryCalls: Array<Array<unknown>> = []
  const query = {
    from: () => query,
    select: () => query,
    eq: () => query,
    maybeSingle: () => Promise.resolve({ data: row, error: null }),
  }
  const createSupabaseClient = (...args: Array<unknown>) => {
    clientFactoryCalls.push(args)
    return query
  }
  return { clientFactoryCalls, createSupabaseClient }
}

Deno.test('H17: badge uses the dmv_read named secret key when present', async () => {
  const namedKey = 'sb_secret_fixtureBadgeRead00000000000'
  await withEnv({
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_SECRET_KEYS: JSON.stringify({ default: 'sb_secret_fixtureDefault000000000000', dmv_read: namedKey }),
  }, async () => {
    const mock = createSupabaseMock({ certificate_id: VALID_CERTIFICATE_ID, domain_requested: 'mesa-agent.agent' })
    const response = await handleBadge(
      new Request(`https://example.test/badge?id=${VALID_CERTIFICATE_ID}`),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )
    check(response.status === 200, `status ${response.status}`)
    check(mock.clientFactoryCalls.length === 1, 'expected one client')
    check(mock.clientFactoryCalls[0][1] === namedKey, 'expected the dmv_read key')
    const svg = await response.text()
    check(svg.includes('mesa-agent'), 'badge should carry the registered agent name')
  })
})

Deno.test('H17: badge falls back to the check-digit badge when the key is misconfigured', async () => {
  await withEnv({
    SUPABASE_URL: 'https://project.supabase.test',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
    SUPABASE_SECRET_KEYS: JSON.stringify({ dmv_read: 'not-a-secret-key' }),
  }, async () => {
    const mock = createSupabaseMock(null)
    const response = await handleBadge(
      new Request(`https://example.test/badge?id=${VALID_CERTIFICATE_ID}`),
      { createSupabaseClient: mock.createSupabaseClient as never },
    )
    check(response.status === 200, `status ${response.status}`)
    check(mock.clientFactoryCalls.length === 0, 'no client may be created with a misconfigured key')
  })
})
