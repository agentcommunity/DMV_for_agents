// Supabase Edge Function — register-agent
// Proxy for agent registration. Holds service role key server-side.
// Client packages never see database credentials.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { Redis } from 'https://esm.sh/@upstash/redis@1.35.1'
import { Ratelimit } from 'https://esm.sh/@upstash/ratelimit@2.0.6'

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

// --- Rate limiting (Redis-backed via Upstash) ---

let _limiters: ReturnType<typeof createRateLimiters> | null = null

function createRateLimiters() {
  const redis = new Redis({
    url: Deno.env.get('UPSTASH_REDIS_REST_URL')!,
    token: Deno.env.get('UPSTASH_REDIS_REST_TOKEN')!,
  })

  return {
    perEmail: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(5, '10 m'),
      prefix: 'dmv:email',
    }),
    perIp: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(10, '10 m'),
      prefix: 'dmv:ip',
    }),
    perIpEmail: new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(3, '10 m'),
      prefix: 'dmv:ip-email',
    }),
  }
}

function getLimiters() {
  if (!_limiters) _limiters = createRateLimiters()
  return _limiters
}

async function hashString(str: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
  return [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('')
}

async function checkRateLimit(
  email: string,
  ip: string,
): Promise<{ error: string | null; retryAfter?: number }> {
  try {
    const limiters = getLimiters()
    const emailHash = await hashString(email)
    const ipHash = await hashString(ip)

    // Tightest limit first: per IP+email combo
    const ipEmailResult = await limiters.perIpEmail.limit(`${ipHash}:${emailHash}`)
    if (!ipEmailResult.success) {
      const retryAfter = Math.ceil((ipEmailResult.reset - Date.now()) / 1000)
      return { error: 'Rate limited: too many registrations from this session', retryAfter }
    }

    // Per-email limit
    const emailResult = await limiters.perEmail.limit(emailHash)
    if (!emailResult.success) {
      const retryAfter = Math.ceil((emailResult.reset - Date.now()) / 1000)
      return { error: 'Rate limited: too many registrations for this email', retryAfter }
    }

    // Per-IP limit (most lenient — shared IPs need headroom)
    const ipResult = await limiters.perIp.limit(ipHash)
    if (!ipResult.success) {
      const retryAfter = Math.ceil((ipResult.reset - Date.now()) / 1000)
      return { error: 'Rate limited: too many registrations from this address', retryAfter }
    }

    return { error: null }
  } catch (err) {
    // Fail-open: if Redis is down, allow the request through.
    // The DB lifetime cap still provides a backstop against abuse.
    console.error('Redis rate limit check failed, allowing request:', err)
    return { error: null }
  }
}

// --- Handler ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) })
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

  // Client IP for rate limiting (before DB connection)
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || 'unknown'

  // Rate limit (Redis — no DB connection needed)
  const rateLimit = await checkRateLimit(email, ip)
  if (rateLimit.error) {
    return new Response(
      JSON.stringify({ error: rateLimit.error }),
      { status: 429, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json', 'Retry-After': String(rateLimit.retryAfter || 600) } },
    )
  }

  // Supabase client with service role key (server-side only — created after rate limit check)
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Lifetime cap: 3 unendorsed / 10 endorsed per email
  const { count: totalCerts } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .not('certificate_id', 'is', null)

  const CAP_UNENDORSED = 3
  const CAP_ENDORSED = 10
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
          error: `Certificate limit reached (${cap} max).${!endorsed?.length ? ' Endorsed members can register up to 10.' : ''}`,
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

  // Permalink + badge URLs (badges routed through our domain via Vercel rewrite)
  const DMV_BASE = 'https://dmv.agentcommunity.org'
  const permalinkUrl = `${DMV_BASE}/c/${encodeURIComponent(certificateId)}/${encodeURIComponent(agentName)}`
  const badgeUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}`
  const badgeCardUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}&style=card`

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
      status: 'provisional_dmv',
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
    console.error('Supabase insert error:', insertError.message)
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
