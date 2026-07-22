// Supabase Edge Function — lookup-agent
// Internal Worker upstream for certificate-ID lookup. Holds the service role key
// server-side and rejects direct callers before creating a Supabase client.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const DMV_PROXY_HEADER = 'x-dmv-proxy'

export type LookupAgentResult =
  | { status: 'issued'; certificate_id: string; agent_name: string; domain: string }
  | { status: 'not_found'; certificate_id: string }

// Constant-time string comparison copied from register-agent. There is no
// fallback value: an unset secret fails closed.
function timingSafeStrEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

function json(body: Record<string, unknown> | LookupAgentResult, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Certificate check digit verification (offline, no DB needed)
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function verifyCertificateId(id: string): boolean {
  const clean = id.replace(/-/g, '')
  if (clean.length < 5) return false
  const body = clean.slice(0, -1)
  const check = clean.slice(-1)
  let sum = 0
  for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let val = CHARSET.indexOf(body[i])
    if (alt) {
      val *= 2
      if (val >= 36) val -= 35
    }
    sum += val
  }
  return CHARSET[(36 - (sum % 36)) % 36] === check
}

export async function handleLookupAgent(
  req: Request,
  dependencies: { createSupabaseClient?: typeof createClient } = {},
): Promise<Response> {
  const proxySecret = Deno.env.get('DMV_PROXY_SECRET')
  const suppliedSecret = req.headers.get(DMV_PROXY_HEADER)
  if (!proxySecret || !suppliedSecret || !timingSafeStrEqual(suppliedSecret, proxySecret)) {
    return json({ error: 'direct_access_deprecated' }, 403)
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204 })
  }

  if (req.method !== 'GET') {
    return json({ error: 'Method not allowed' }, 405)
  }

  const url = new URL(req.url)
  if (url.searchParams.has('domain')) {
    return json({ error: 'Domain lookup is not supported. Provide ?id=CERT-ID' }, 400)
  }

  const requestedCertId = url.searchParams.get('id')
  if (!requestedCertId) {
    return json({ error: 'Provide ?id=CERT-ID' }, 400)
  }

  const certId = requestedCertId.trim().toUpperCase()

  if (!verifyCertificateId(certId)) {
    return json({ error: 'Invalid certificate ID (check digit failed)', valid: false }, 400)
  }

  const createSupabaseClient = dependencies.createSupabaseClient ?? createClient
  const supabase = createSupabaseClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  const { data, error } = await supabase
    .from('registrations')
    .select('certificate_id, domain_requested')
    .eq('certificate_id', certId)
    .maybeSingle()

  if (error) {
    console.error('Lookup error:', error.message)
    return json({ error: 'Lookup failed' }, 500)
  }

  if (!data) {
    const result: LookupAgentResult = { status: 'not_found', certificate_id: certId }
    return json(result, 200)
  }

  if (data.certificate_id !== certId) {
    console.error('Lookup returned a mismatched certificate ID')
    return json({ error: 'Lookup failed' }, 500)
  }

  const result: LookupAgentResult = {
    status: 'issued',
    certificate_id: data.certificate_id,
    agent_name: data.domain_requested.replace(/\.agent$/, ''),
    domain: data.domain_requested,
  }
  return json(result, 200)
}

if (import.meta.main) {
  Deno.serve((req) => handleLookupAgent(req))
}
