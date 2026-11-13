// Tests for the DMV edge key loader (key migration plan 2026-11-08, holders H17-H19).
// No real key is used anywhere: every value below is a fixture string.

import {
  apikeyOnlyFetch,
  createDmvSupabaseClient,
  DMV_SUPABASE_CLIENT_OPTIONS,
  resolveDmvSupabaseKey,
} from './supabase-key.ts'

const assert = {
  equal(actual: unknown, expected: unknown): void {
    if (!Object.is(actual, expected)) {
      throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    }
  },
  ok(value: unknown, message: string): void {
    if (!value) throw new Error(message)
  },
  async rejects(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
      await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!pattern.test(message)) throw new Error(`Rejected with unexpected message: ${message}`)
      return
    }
    throw new Error('Expected a rejection')
  },
}

const NEW_READ_KEY = 'sb_secret_fixtureReadKey000000000000'
const NEW_REGISTER_KEY = 'sb_secret_fixtureRegisterKey00000000'
const DEFAULT_KEY = 'sb_secret_fixtureDefaultKey000000000'
const LEGACY_KEY = 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.fixture'

function envOf(values: Record<string, string | undefined>): (name: string) => string | undefined {
  return (name) => values[name]
}

function captureLogs(): { lines: Array<string>; log: (line: string) => void } {
  const lines: Array<string> = []
  return { lines, log: (line) => lines.push(line) }
}

const dictionary = JSON.stringify({
  default: DEFAULT_KEY,
  dmv_read: NEW_READ_KEY,
  dmv_register: NEW_REGISTER_KEY,
})

Deno.test('reads the named key from SUPABASE_SECRET_KEYS, never the default entry', async () => {
  const logs = captureLogs()
  const read = await resolveDmvSupabaseKey('dmv_read', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
    log: logs.log,
  })
  assert.equal(read.key, NEW_READ_KEY)
  assert.equal(read.kind, 'sb_secret')
  assert.equal(read.source, 'SUPABASE_SECRET_KEYS')

  const register = await resolveDmvSupabaseKey('dmv_register', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
    log: logs.log,
  })
  assert.equal(register.key, NEW_REGISTER_KEY)
})

Deno.test('logs key_name, key_kind and a 12-hex fingerprint, never the key', async () => {
  const logs = captureLogs()
  await resolveDmvSupabaseKey('dmv_read', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
    log: logs.log,
  })
  assert.equal(logs.lines.length, 1)
  const line = logs.lines[0]
  assert.ok(/^supabase_key key_name=dmv_read key_kind=sb_secret key_source=SUPABASE_SECRET_KEYS key_fp=[0-9a-f]{12}$/.test(line), line)
  assert.ok(!line.includes(NEW_READ_KEY), 'log line must not contain the key')
  assert.ok(!line.includes('fixtureReadKey'), 'log line must not contain any part of the key')
})

Deno.test('fingerprint is the first 12 hex of sha256(key), as recorded in the wave ledger', async () => {
  const logs = captureLogs()
  await resolveDmvSupabaseKey('dmv_read', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
    log: logs.log,
  })
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(NEW_READ_KEY))
  const expected = Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12)
  assert.ok(logs.lines[0].endsWith(`key_fp=${expected}`), logs.lines[0])
})

Deno.test('fails closed when the named entry is not an sb_secret_ key', async () => {
  for (const bad of [LEGACY_KEY, 'sb_publishable_fixture000000000000', '', '   ']) {
    await assert.rejects(
      () =>
        resolveDmvSupabaseKey('dmv_read', {
          env: envOf({ SUPABASE_SECRET_KEYS: JSON.stringify({ dmv_read: bad }), SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
          log: () => {},
        }),
      /dmv_read.*sb_secret_/,
    )
  }
})

Deno.test('cut-over: never falls back to the legacy key, even with only the default entry present', async () => {
  const logs = captureLogs()
  await assert.rejects(
    () =>
      resolveDmvSupabaseKey('dmv_read', {
        env: envOf({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: DEFAULT_KEY }), SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
        log: logs.log,
      }),
    /dmv_read.*not configured/,
  )
  assert.equal(logs.lines.length, 0)
})

Deno.test('cut-over: a missing or malformed dictionary fails closed, the injected legacy key is ignored', async () => {
  for (const raw of [undefined, '', 'not json', '[]', '"x"', 'null']) {
    await assert.rejects(
      () =>
        resolveDmvSupabaseKey('dmv_register', {
          env: envOf({ SUPABASE_SECRET_KEYS: raw, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
          log: () => {},
        }),
      /dmv_register.*not configured/,
    )
  }
})

Deno.test('fails closed when no key is present at all', async () => {
  await assert.rejects(
    () => resolveDmvSupabaseKey('dmv_read', { env: envOf({}), log: () => {} }),
    /dmv_read.*not configured/,
  )
})

Deno.test('fails closed on a bare sb_secret_ prefix', async () => {
  await assert.rejects(
    () => resolveDmvSupabaseKey('dmv_read', { env: envOf({ SUPABASE_SECRET_KEYS: JSON.stringify({ dmv_read: 'sb_secret_' }) }), log: () => {} }),
    /dmv_read.*sb_secret_/,
  )
})

Deno.test('apikeyOnlyFetch drops a Bearer equal to the key and keeps apikey', async () => {
  const seen: Array<Headers> = []
  const base = (_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return Promise.resolve(new Response('[]'))
  }
  const wrapped = apikeyOnlyFetch(NEW_READ_KEY, base as typeof fetch)
  await wrapped('https://project.supabase.test/rest/v1/registrations', {
    headers: { apikey: NEW_READ_KEY, Authorization: `Bearer ${NEW_READ_KEY}`, 'X-Other': '1' },
  })
  assert.equal(seen[0].get('authorization'), null)
  assert.equal(seen[0].get('apikey'), NEW_READ_KEY)
  assert.equal(seen[0].get('x-other'), '1')

  // A user token that differs from the key is not the API key and is left alone.
  await wrapped('https://project.supabase.test/rest/v1/x', { headers: { Authorization: 'Bearer user-jwt' } })
  assert.equal(seen[1].get('authorization'), 'Bearer user-jwt')
  assert.equal(seen[1].get('apikey'), NEW_READ_KEY)
})

Deno.test('apikeyOnlyFetch also strips a Bearer carried by a Request input', async () => {
  const seen: Array<{ input: RequestInfo | URL; headers: Headers }> = []
  const base = (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ input, headers: new Headers(init?.headers) })
    return Promise.resolve(new Response('[]'))
  }
  const wrapped = apikeyOnlyFetch(NEW_READ_KEY, base as typeof fetch)
  const request = new Request('https://project.supabase.test/rest/v1/registrations', {
    headers: { Authorization: `Bearer ${NEW_READ_KEY}`, 'X-From-Request': '1' },
  })
  await wrapped(request, { headers: { 'X-From-Init': '1' } })
  // The base fetch gets explicit init headers, which replace the Request's own.
  assert.equal(seen[0].headers.get('authorization'), null)
  assert.equal(seen[0].headers.get('apikey'), NEW_READ_KEY)
  assert.equal(seen[0].headers.get('x-from-request'), '1')
  assert.equal(seen[0].headers.get('x-from-init'), '1')
})

Deno.test('createDmvSupabaseClient passes the named key, no-session options and the apikey-only fetch', async () => {
  const calls: Array<Array<unknown>> = []
  const factory = (...args: Array<unknown>) => {
    calls.push(args)
    return { marker: true }
  }
  const client = await createDmvSupabaseClient('dmv_read', {
    createClient: factory as never,
    env: envOf({ SUPABASE_URL: 'https://project.supabase.test', SUPABASE_SECRET_KEYS: dictionary }),
    log: () => {},
  })
  assert.equal((client as unknown as { marker: boolean }).marker, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://project.supabase.test')
  assert.equal(calls[0][1], NEW_READ_KEY)
  const options = calls[0][2] as { auth: unknown; global: { fetch: unknown } }
  assert.equal(JSON.stringify(options.auth), JSON.stringify(DMV_SUPABASE_CLIENT_OPTIONS.auth))
  assert.equal(typeof options.global.fetch, 'function')
})

Deno.test('cut-over: no client is created from the legacy key', async () => {
  const calls: Array<Array<unknown>> = []
  const factory = (...args: Array<unknown>) => {
    calls.push(args)
    return {}
  }
  await assert.rejects(
    () =>
      createDmvSupabaseClient('dmv_register', {
        createClient: factory as never,
        env: envOf({ SUPABASE_URL: 'https://project.supabase.test', SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
        log: () => {},
      }),
    /dmv_register.*not configured/,
  )
  assert.equal(calls.length, 0)
})

Deno.test('fails closed when SUPABASE_URL is missing', async () => {
  await assert.rejects(
    () =>
      createDmvSupabaseClient('dmv_read', {
        createClient: (() => ({})) as never,
        env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
        log: () => {},
      }),
    /SUPABASE_URL/,
  )
})

Deno.test('end to end: the real pinned supabase-js client sends the named key on apikey only, no Bearer', async () => {
  const seen: Array<Headers> = []
  const originalFetch = globalThis.fetch
  globalThis.fetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(new Headers(init?.headers))
    return Promise.resolve(new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }))
  }) as typeof fetch
  try {
    const client = await createDmvSupabaseClient('dmv_read', {
      env: envOf({ SUPABASE_URL: 'https://project.supabase.test', SUPABASE_SECRET_KEYS: dictionary }),
      log: () => {},
    })
    await client.from('registrations').select('certificate_id').limit(1)
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.equal(seen.length, 1)
  assert.equal(seen[0].get('apikey'), NEW_READ_KEY)
  assert.equal(seen[0].get('authorization'), null)
})
