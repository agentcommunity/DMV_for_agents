// Supabase Edge Function — lookup-agent
// Public read-only API to look up a registered agent by certificate ID or domain.
// Returns agent info if found, 404 if not.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=60',
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
    if (alt) { val *= 2; if (val >= 36) val -= 35 }
    sum += val
  }
  return CHARSET[(36 - (sum % 36)) % 36] === check
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const url = new URL(req.url)

  // Accept ?id=CERT-ID or ?domain=name.agent
  const certId = url.searchParams.get('id')
  const domain = url.searchParams.get('domain')

  if (!certId && !domain) {
    return new Response(
      JSON.stringify({ error: 'Provide ?id=CERT-ID or ?domain=name.agent' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // If cert ID provided, verify check digit first (free, no DB)
  if (certId && !verifyCertificateId(certId)) {
    return new Response(
      JSON.stringify({ error: 'Invalid certificate ID (check digit failed)', valid: false }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  let query = supabase
    .from('registrations')
    .select('certificate_id, domain_requested, registration_type, signup_source, created_at, metadata')

  if (certId) {
    query = query.eq('certificate_id', certId)
  } else {
    // Normalize: accept "name" or "name.agent"
    const normalized = domain!.endsWith('.agent') ? domain! : domain + '.agent'
    query = query.eq('domain_requested', normalized)
  }

  const { data, error } = await query.maybeSingle()

  if (error) {
    console.error('Lookup error:', error.message)
    return new Response(
      JSON.stringify({ error: 'Lookup failed' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  if (!data) {
    return new Response(
      JSON.stringify({
        error: 'Not found',
        valid: certId ? true : undefined, // check digit was valid, just not registered
      }),
      { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Strip internal fields, return public info only
  const agentName = data.domain_requested.replace(/\.agent$/, '')

  return new Response(
    JSON.stringify({
      certificate_id: data.certificate_id,
      agent_name: agentName,
      domain: data.domain_requested,
      type: data.registration_type,
      source: data.signup_source,
      registered_at: data.created_at,
      description: data.metadata?.agent_description || null,
      // No email, no IP, no operator name — public API only shows public info
    }),
    { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
