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
    legacyFallback: true,
  })
  assert.equal(read.key, NEW_READ_KEY)
  assert.equal(read.kind, 'sb_secret')
  assert.equal(read.source, 'SUPABASE_SECRET_KEYS')

  const register = await resolveDmvSupabaseKey('dmv_register', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
    log: logs.log,
    legacyFallback: false,
  })
  assert.equal(register.key, NEW_REGISTER_KEY)
})

Deno.test('logs key_name, key_kind and a 12-hex fingerprint, never the key', async () => {
  const logs = captureLogs()
  await resolveDmvSupabaseKey('dmv_read', {
    env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
    log: logs.log,
    legacyFallback: false,
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
    legacyFallback: false,
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
          legacyFallback: true,
        }),
      /dmv_read.*sb_secret_/,
    )
  }
})

Deno.test('falls back to the legacy key only while the switch is on', async () => {
  const logs = captureLogs()
  const resolved = await resolveDmvSupabaseKey('dmv_read', {
    env: envOf({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: DEFAULT_KEY }), SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
    log: logs.log,
    legacyFallback: true,
  })
  assert.equal(resolved.key, LEGACY_KEY)
  assert.equal(resolved.kind, 'legacy_jwt')
  assert.equal(resolved.source, 'legacy')
  assert.ok(/key_kind=legacy_jwt key_source=legacy key_fp=[0-9a-f]{12}$/.test(logs.lines[0]), logs.lines[0])

  await assert.rejects(
    () =>
      resolveDmvSupabaseKey('dmv_read', {
        env: envOf({ SUPABASE_SECRET_KEYS: JSON.stringify({ default: DEFAULT_KEY }), SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
        log: () => {},
        legacyFallback: false,
      }),
    /dmv_read.*not configured/,
  )
})

Deno.test('missing or malformed dictionary falls back while on, fails closed when off', async () => {
  for (const raw of [undefined, '', 'not json', '[]', '"x"']) {
    const resolved = await resolveDmvSupabaseKey('dmv_register', {
      env: envOf({ SUPABASE_SECRET_KEYS: raw, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
      log: () => {},
      legacyFallback: true,
    })
    assert.equal(resolved.source, 'legacy')
    await assert.rejects(
      () =>
        resolveDmvSupabaseKey('dmv_register', {
          env: envOf({ SUPABASE_SECRET_KEYS: raw, SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
          log: () => {},
          legacyFallback: false,
        }),
      /dmv_register.*not configured/,
    )
  }
})

Deno.test('fails closed when neither the named key nor the legacy key is present', async () => {
  await assert.rejects(
    () => resolveDmvSupabaseKey('dmv_read', { env: envOf({}), log: () => {}, legacyFallback: true }),
    /dmv_read.*not configured/,
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
    legacyFallback: true,
  })
  assert.equal((client as unknown as { marker: boolean }).marker, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'https://project.supabase.test')
  assert.equal(calls[0][1], NEW_READ_KEY)
  const options = calls[0][2] as { auth: unknown; global: { fetch: unknown } }
  assert.equal(JSON.stringify(options.auth), JSON.stringify(DMV_SUPABASE_CLIENT_OPTIONS.auth))
  assert.equal(typeof options.global.fetch, 'function')
})

Deno.test('legacy fallback client keeps the default supabase-js header behaviour', async () => {
  const calls: Array<Array<unknown>> = []
  const factory = (...args: Array<unknown>) => {
    calls.push(args)
    return {}
  }
  await createDmvSupabaseClient('dmv_register', {
    createClient: factory as never,
    env: envOf({ SUPABASE_URL: 'https://project.supabase.test', SUPABASE_SERVICE_ROLE_KEY: LEGACY_KEY }),
    log: () => {},
    legacyFallback: true,
  })
  assert.equal(calls[0][1], LEGACY_KEY)
  const options = calls[0][2] as { global?: unknown }
  assert.equal(options.global, undefined)
})

Deno.test('fails closed when SUPABASE_URL is missing', async () => {
  await assert.rejects(
    () =>
      createDmvSupabaseClient('dmv_read', {
        createClient: (() => ({})) as never,
        env: envOf({ SUPABASE_SECRET_KEYS: dictionary }),
        log: () => {},
        legacyFallback: true,
      }),
    /SUPABASE_URL/,
  )
})
