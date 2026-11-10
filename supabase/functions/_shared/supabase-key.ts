// One key loader for every DMV edge function that talks to Supabase
// (holders H17 badge, H18 lookup-agent, H19 register-agent; Supabase key
// migration plan 2026-11-08). See supabase/functions/SWITCH.md.
//
// New key: a named secret key in the platform-injected SUPABASE_SECRET_KEYS
// JSON dictionary (keyed by key name; https://supabase.com/docs/guides/functions/secrets,
// read 2026-11-08). The `default` entry is never used.
// Legacy key: read only while DMV_LEGACY_KEY_FALLBACK is true.

import { createClient, type SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2.53.0'

export const SUPABASE_JS_PINNED_URL = 'https://esm.sh/@supabase/supabase-js@2.53.0'

// THE SWITCH. true = transition: use the named key when present, else the
// legacy service_role key. Set to false at cut-over (and delete the line
// marked legacy-fallback below); the G-CODE test then enforces.
export const DMV_LEGACY_KEY_FALLBACK: boolean = true

export type DmvKeyName = 'dmv_read' | 'dmv_register'
export type KeyKind = 'sb_secret' | 'legacy_jwt' | 'unknown'
export type SupabaseCreateClient = typeof createClient

export interface ResolvedKey {
  name: DmvKeyName
  key: string
  kind: KeyKind
  source: 'SUPABASE_SECRET_KEYS' | 'legacy'
}

export interface KeyLoaderOptions {
  env?: (name: string) => string | undefined
  log?: (line: string) => void
  legacyFallback?: boolean
}

export const DMV_SUPABASE_CLIENT_OPTIONS = {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
} as const

const SECRET_PREFIX = 'sb_secret_'

function defaultEnv(name: string): string | undefined {
  return Deno.env.get(name)
}

function classify(key: string): KeyKind {
  if (key.startsWith(SECRET_PREFIX)) return 'sb_secret'
  if (key.startsWith('eyJ')) return 'legacy_jwt'
  return 'unknown'
}

async function fingerprint(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key))
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 12)
}

function readNamedEntry(raw: string | undefined, name: DmvKeyName): { present: boolean; value: unknown } {
  if (!raw) return { present: false, value: undefined }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { present: false, value: undefined }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { present: false, value: undefined }
  const dictionary = parsed as Record<string, unknown>
  if (!Object.hasOwn(dictionary, name)) return { present: false, value: undefined }
  return { present: true, value: dictionary[name] }
}

export async function resolveDmvSupabaseKey(name: DmvKeyName, options: KeyLoaderOptions = {}): Promise<ResolvedKey> {
  const env = options.env ?? defaultEnv
  const log = options.log ?? ((line: string) => console.log(line))
  const legacyFallback = options.legacyFallback ?? DMV_LEGACY_KEY_FALLBACK

  let resolved: ResolvedKey | null = null
  const entry = readNamedEntry(env('SUPABASE_SECRET_KEYS'), name)
  if (entry.present) {
    // Fail closed: a configured entry that is not a secret key is an operator
    // error, never a reason to fall back silently.
    if (typeof entry.value !== 'string' || !entry.value.startsWith(SECRET_PREFIX)) {
      throw new Error(`Supabase key ${name} in SUPABASE_SECRET_KEYS must start with ${SECRET_PREFIX}`)
    }
    resolved = { name, key: entry.value, kind: 'sb_secret', source: 'SUPABASE_SECRET_KEYS' }
  } else if (legacyFallback) {
    const legacy = env('SUPABASE_SERVICE_ROLE_KEY') // g-code-allow: legacy-fallback
    if (legacy) resolved = { name, key: legacy, kind: classify(legacy), source: 'legacy' }
  }

  if (!resolved) throw new Error(`Supabase key ${name} is not configured`)
  log(`supabase_key key_name=${name} key_kind=${resolved.kind} key_source=${resolved.source} key_fp=${await fingerprint(resolved.key)}`)
  return resolved
}

// supabase-js 2.53.0 adds the key as a Bearer token when there is no session
// (lib/fetch.js fetchWithAuth). The API keys guide says to send new keys on
// `apikey`, not as a Bearer (https://supabase.com/docs/guides/api/api-keys,
// read 2026-11-08), so the Bearer copy of the API key is removed here.
export function apikeyOnlyFetch(key: string, baseFetch: typeof fetch = fetch): typeof fetch {
  const bearerOfKey = `Bearer ${key}`
  return (input: RequestInfo | URL, init?: RequestInit) => {
    // supabase-js 2.53.0 passes a URL string plus init, but a Request input can
    // carry its own headers: merge them first so its Bearer is stripped too.
    // Explicit init headers replace a Request's headers in fetch, so passing the
    // merged set on init is what the base fetch sends.
    const headers = new Headers(input instanceof Request ? input.headers : undefined)
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value))
    if (headers.get('authorization') === bearerOfKey) headers.delete('authorization') // g-code-allow: strips-bearer
    headers.set('apikey', key)
    return baseFetch(input, { ...init, headers })
  }
}

export interface ClientFactoryOptions extends KeyLoaderOptions {
  createClient?: SupabaseCreateClient
}

export async function createDmvSupabaseClient(
  name: DmvKeyName,
  options: ClientFactoryOptions = {},
): Promise<SupabaseClient> {
  const env = options.env ?? defaultEnv
  const url = env('SUPABASE_URL')
  if (!url) throw new Error('SUPABASE_URL is not configured')
  const resolved = await resolveDmvSupabaseKey(name, { ...options, env })
  const factory = options.createClient ?? createClient
  if (resolved.kind === 'sb_secret') {
    return factory(url, resolved.key, {
      ...DMV_SUPABASE_CLIENT_OPTIONS,
      global: { fetch: apikeyOnlyFetch(resolved.key) },
    }) as SupabaseClient
  }
  // Legacy JWT: unchanged header behaviour (apikey + Bearer) until cut-over.
  return factory(url, resolved.key, { ...DMV_SUPABASE_CLIENT_OPTIONS }) as SupabaseClient
}
