// Supabase Edge Function — register-agent
// Proxy for agent registration. Holds service role key server-side.
// Client packages never see database credentials.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// --- Certificate ID generation (duplicated from package — ~50 lines, no deps) ---

const ID_WORDS = [
  'NOVA', 'APEX', 'FLUX', 'NEON', 'VOID', 'BYTE', 'CORE', 'DART',
  'ECHO', 'GRID', 'HALO', 'IRON', 'JADE', 'KILO', 'LYNX', 'MESA',
  'NODE', 'ONYX', 'PEAK', 'QUAD', 'REEF', 'SYNC', 'TRON', 'UNIT',
  'VOLT', 'WARP', 'XRAY', 'ZERO', 'ZETA', 'OMNI', 'AURA', 'BOLT',
]

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

function luhnCheck(body: string): string {
  let sum = 0
  for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let val = CHARSET.indexOf(body[i])
    if (alt) {
      val *= 2
      if (val >= 36) val -= 35
    }
    sum += val
  }
  return CHARSET[(36 - (sum % 36)) % 36]
}

function generateCertificateId(fields: string[], accountType: string): string {
  const content = fields.join('|') + '|' + accountType
  const hash = fnv1a(content)
  const word = ID_WORDS[hash & 0x1f]
  const hex = ((hash >>> 5) & 0xffffff).toString(16).toUpperCase().padStart(6, '0')
  const body = word + hex
  const check = luhnCheck(body)
  return `${word}-${hex.slice(0, 3)}-${hex.slice(3)}${check}`
}

// --- Validation ---

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const AGENT_NAME_REGEX = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/

function validateRequest(body: Record<string, unknown>): string | null {
  const name = body.agent_name as string
  if (!name) return 'agent_name is required'
  if (name.length < 3) return 'agent_name must be at least 3 characters'
  if (name.length > 32) return 'agent_name must be at most 32 characters'
  if (!AGENT_NAME_REGEX.test(name)) {
    return 'agent_name must be lowercase alphanumeric (hyphens allowed in middle)'
  }

  const email = body.email as string
  if (!email) return 'email is required'
  if (!EMAIL_REGEX.test(email)) return 'Invalid email format'

  const source = body.signup_source as string
  if (source && !['ui', 'mcp', 'api'].includes(source)) {
    return 'signup_source must be ui, mcp, or api'
  }

  return null
}

// --- CORS ---

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// --- Rate limiting (database-backed) ---

async function checkRateLimit(
  supabase: ReturnType<typeof createClient>,
  email: string,
  ip: string,
): Promise<string | null> {
  // Max 3 registrations per email per hour
  const { count: emailCount } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .gte('created_at', new Date(Date.now() - 3600_000).toISOString())

  if ((emailCount ?? 0) >= 3) {
    return 'Rate limited: max 3 registrations per email per hour'
  }

  // Max 10 registrations per IP per hour (stored in metadata)
  const { count: ipCount } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('metadata->>client_ip', ip)
    .gte('created_at', new Date(Date.now() - 3600_000).toISOString())

  if ((ipCount ?? 0) >= 10) {
    return 'Rate limited: too many registrations from this address'
  }

  return null
}

// --- Handler ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders })
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Validate
  const validationError = validateRequest(body)
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  const agentName = body.agent_name as string
  const email = body.email as string
  const operatorName = (body.operator_name as string) || null
  const description = (body.description as string) || null
  const signupSource = (body.signup_source as string) || 'api'
  const registrationType = (body.registration_type as string) || 'AGENT'
  const organizationName = (body.organization_name as string) || null

  // Supabase client with service role key (server-side only)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Client IP for rate limiting
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown'

  // Rate limit
  const rateLimitError = await checkRateLimit(supabase, email, ip)
  if (rateLimitError) {
    return new Response(
      JSON.stringify({ error: rateLimitError }),
      { status: 429, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  // Generate certificate ID (server-side — authoritative)
  const certFields = [agentName, email]
  const certificateId = generateCertificateId(certFields, registrationType.toLowerCase())
  const domain = agentName + '.agent'

  // Insert
  const { error: insertError } = await supabase
    .from('registrations')
    .insert({
      registration_type: registrationType,
      full_name: operatorName,
      organization_name: organizationName,
      domain_requested: domain,
      email,
      certificate_id: certificateId,
      signup_source: signupSource,
      metadata: {
        agent_description: description,
        client_ip: ip,
      },
    })

  if (insertError) {
    // Duplicate domain → friendly message
    if (insertError.code === '23505') {
      return new Response(
        JSON.stringify({ error: `Domain ${domain} is already registered` }),
        { status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
      )
    }
    console.error('Supabase insert error:', insertError.message)
    return new Response(
      JSON.stringify({ error: 'Registration failed. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({
      certificate_id: certificateId,
      agent_name: agentName,
      domain,
      message:
        `Certificate ${certificateId} issued for ${domain}. ` +
        `A verification email will be sent to ${email}. ` +
        `Please click the link to complete verification.`,
    }),
    { status: 201, headers: { ...corsHeaders, 'Content-Type': 'application/json' } },
  )
})
