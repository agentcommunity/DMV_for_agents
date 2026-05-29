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
  if (name.length > 63) return 'agent_name must be at most 63 characters'
  if (!AGENT_NAME_REGEX.test(name)) {
    return 'agent_name must be lowercase alphanumeric (hyphens allowed in middle)'
  }

  const email = body.email as string
  if (!email) return 'email is required'
  if (!EMAIL_REGEX.test(email)) return 'Invalid email format'
  if (email.length > 254) return 'email must be 254 characters or fewer'

  const operatorName = body.operator_name as string
  if (operatorName && operatorName.length > 100) {
    return 'operator_name must be 100 characters or fewer'
  }

  const orgName = body.organization_name as string
  if (orgName && orgName.length > 100) {
    return 'organization_name must be 100 characters or fewer'
  }

  const description = body.description as string
  if (description && description.length > 500) {
    return 'description must be 500 characters or fewer'
  }

  const source = body.signup_source as string
  if (source && !['ui', 'cli', 'mcp', 'api'].includes(source)) {
    return 'signup_source must be ui, cli, mcp, or api'
  }

  const regType = body.registration_type as string
  if (regType && !['AGENT', 'INDIVIDUAL', 'ORGANIZATION'].includes(regType)) {
    return 'registration_type must be AGENT, INDIVIDUAL, or ORGANIZATION'
  }

  // full_name required for INDIVIDUAL and ORGANIZATION
  if ((regType === 'INDIVIDUAL' || regType === 'ORGANIZATION') && !body.operator_name) {
    return 'operator_name (full_name) is required for INDIVIDUAL and ORGANIZATION registrations'
  }

  // organization_name required for ORGANIZATION
  if (regType === 'ORGANIZATION' && !body.organization_name) {
    return 'organization_name is required for ORGANIZATION registrations'
  }

  return null
}

// --- CORS ---

const ALLOWED_ORIGINS = [
  'https://dmv.agentcommunity.org',
  'https://agentcommunity.org',
]

function getCorsHeaders(req: Request) {
  const origin = req.headers.get('origin') || ''
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  }
}

// --- Handler ---

// Proxy header gate — only the DMV worker at dmv.agentcommunity.org/api/register
// is allowed to call this function. The worker sets `x-dmv-proxy: v1` on every
// forwarded request (see worker/index.ts handleRegister). Any direct POST to
// this Supabase URL without that header is rejected with 403.
//
// This closes the direct-Supabase bypass that existed during the 2026-04-08
// migration window for legacy CLI versions. Adoption of the worker-proxied
// @agentcommunity/dmv-agent CLI is complete, so there are no known legitimate
// direct callers anymore. OPTIONS preflights are exempt (browsers don't send
// custom headers on preflight, and we still want CORS to work for any future
// debugging).
const DMV_PROXY_HEADER = 'x-dmv-proxy'
const DMV_PROXY_VERSION = 'v1'

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) })
  }

  const proxyHeader = req.headers.get(DMV_PROXY_HEADER)
  if (proxyHeader !== DMV_PROXY_VERSION) {
    return new Response(
      JSON.stringify({
        error: 'direct_access_deprecated',
        message:
          'Direct access to this edge function is no longer supported. Use ' +
          'https://dmv.agentcommunity.org/api/register (the DMV worker proxy) ' +
          'or update @agentcommunity/dmv-agent to the latest version via ' +
          '`bunx dmv-agent register`.',
      }),
      { status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  if (req.method !== 'POST') {
    return new Response(
      JSON.stringify({ error: 'Method not allowed' }),
      { status: 405, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return new Response(
      JSON.stringify({ error: 'Invalid JSON' }),
      { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  // Validate
  const validationError = validateRequest(body)
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  const agentName = body.agent_name as string
  const email = body.email as string
  const operatorName = (body.operator_name as string) || null
  const description = (body.description as string) || null
  const signupSource = (body.signup_source as string) || 'api'
  const registrationType = (body.registration_type as string) || 'AGENT'
  const organizationName = (body.organization_name as string) || null

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown'

  // Supabase client with service role key (server-side only — created after rate limit check)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Lifetime cap: 5 unendorsed / 12 endorsed per email.
  // Counts only DMV agent cards (certificate_id IS NOT NULL), not PAGE signups.
  const { count: totalCerts } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .not('certificate_id', 'is', null)

  const CAP_UNENDORSED = 5
  const CAP_ENDORSED = 12
  const currentCount = totalCerts ?? 0

  if (currentCount >= CAP_UNENDORSED) {
    // Check if user is endorsed (has endorsement_status = 'signed' on any registration)
    const { data: endorsed } = await supabase
      .from('registrations')
      .select('endorsement_status')
      .eq('email', email)
      .eq('endorsement_status', 'signed')
      .limit(1)

    const cap = endorsed?.length ? CAP_ENDORSED : CAP_UNENDORSED
    if (currentCount >= cap) {
      return new Response(
        JSON.stringify({
          error: `You've maxed out your quota on this email: up to ${cap} agent identities.${!endorsed?.length ? ` Members who've signed the endorsement letter can pre-register up to ${CAP_ENDORSED}.` : ''}`,
          current: currentCount,
          limit: cap,
          endorsed: !!endorsed?.length,
        }),
        { status: 403, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      )
    }
  }

  // Generate certificate ID (server-side — authoritative)
  const certFields = [agentName, email]
  const certificateId = generateCertificateId(certFields, registrationType.toLowerCase())
  const domain = agentName + '.agent'

  // Permalink + badge URLs (badges proxied through the DMV Worker; see worker/index.ts)
  const DMV_BASE = 'https://dmv.agentcommunity.org'
  const permalinkUrl = `${DMV_BASE}/c/${encodeURIComponent(certificateId)}/${encodeURIComponent(agentName)}`
  const badgeUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}`
  const badgeCardUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}&style=card`

  // Insert
  //
  // We intentionally DO NOT set `status` here. The PAGE-side schema
  // (agentCommunity_PAGE/supabase/migrations/20260203000000_baseline.sql:3345)
  // declares status as `DEFAULT 'pending_profile'::registration_status NOT NULL`,
  // and PAGE's DMV integration identifies DMV rows by `certificate_id IS NOT NULL`,
  // not by any status value. PAGE's registration_status enum never had a
  // `provisional_dmv` value — the earlier AUTH_DMV.md plan that assumed one
  // was superseded by the actual PAGE design shipped in migrations
  // 20260210999999 + 20260211000000 + 20260211000100.
  //
  // DMV rows are safe at `pending_profile` because:
  //   - Welcome email trigger skips `certificate_id IS NOT NULL` rows
  //   - Endorsement email trigger skips `certificate_id IS NOT NULL` rows
  //   - `on_dmv_registration` trigger fires specifically on
  //     `certificate_id IS NOT NULL` rows and handles the DMV lifecycle
  //   - `handle-dmv-registration` edge function creates/links the auth user
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
    // Duplicate certificate_id — same user already registered this agent
    if (insertError.code === '23505') {
      return new Response(
        JSON.stringify({
          error: 'Agent already registered',
          certificate_id: certificateId,
          permalink_url: permalinkUrl,
        }),
        { status: 409, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      )
    }
    console.error('Supabase insert error:', JSON.stringify(insertError, null, 2))
    return new Response(
      JSON.stringify({ error: 'Registration failed. Please try again.' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  return new Response(
    JSON.stringify({
      certificate_id: certificateId,
      agent_name: agentName,
      domain,
      registration_type: registrationType,
      permalink_url: permalinkUrl,
      badge_url: badgeUrl,
      badge_card_url: badgeCardUrl,
      message:
        `Certificate ${certificateId} issued for ${domain}. ` +
        `Check your email for your .agent credentials.`,
    }),
    { status: 201, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
  )
})
