// Supabase Edge Function — register-agent
// Proxy for agent registration. Holds service role key server-side.
// Client packages never see database credentials.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { normalizeAgentName, validateRegistrationFields } from '../_shared/registration-validation.ts'

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

// --- Validation (shared rules live in ../_shared/registration-validation.ts) ---

function validateRequest(body: Record<string, unknown>): string | null {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
  return validateRegistrationFields({
    agent_name: str(body.agent_name),
    email: str(body.email),
    operator_name: str(body.operator_name),
    organization_name: str(body.organization_name),
    description: str(body.description),
    signup_source: str(body.signup_source),
    registration_type: str(body.registration_type),
  })
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

function existingRegistrationPayload(args: {
  certificateId: string
  agentName: string
  domain: string
  registrationType: string
  permalinkUrl: string
  badgeUrl: string
  badgeCardUrl: string
}) {
  return {
    certificate_id: args.certificateId,
    agent_name: args.agentName,
    domain: args.domain,
    registration_type: args.registrationType,
    queue_number: null,
    permalink_url: args.permalinkUrl,
    badge_url: args.badgeUrl,
    badge_card_url: args.badgeCardUrl,
    message: `Pre-registration already recorded for ${args.domain}.`,
    already_recorded: true,
  }
}

// --- Handler ---

// Proxy header gate — only the DMV worker at dmv.agentcommunity.org/api/register
// is allowed to call this function (it is deployed with --no-verify-jwt, so this
// header is its ONLY defense against direct internet callers who would bypass the
// worker's Turnstile + rate limits + KV cooldown). The worker sets the shared
// secret `DMV_PROXY_SECRET` as the `x-dmv-proxy` header on every forwarded request
// (see worker/index.ts handleRegister). Any direct POST to this Supabase URL
// without a matching header value is rejected with 403.
//
// The header value is constant-time compared (timingSafeStrEqual) against the
// shared secret. The legacy public `'v1'` constant was removed once the worker was
// confirmed sending the secret — the zero-downtime rollout completed 2026-05-29, so
// `'v1'` can no longer be replayed to reach this function. If DMV_PROXY_SECRET is
// unset, the gate fails closed (rejects everything). See AUTH_DMV.md.
//
// OPTIONS preflights are exempt (browsers don't send custom headers on preflight,
// and we still want CORS to work for any future debugging).
const DMV_PROXY_HEADER = 'x-dmv-proxy'

// Constant-time string comparison (defense-in-depth against timing oracles on the
// secret branch). Hand-rolled: no early return on first differing char; safely
// returns false on null/undefined or length mismatch instead of throwing.
function timingSafeStrEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

// SHA-256 hex digest — mirrors worker/index.ts's sha256Hex (used there for every
// rate-limit key). The client IP must never be stored raw in the shared
// production DB (PAGE reads this same `registrations` table); this is the only
// writer that wasn't already hashing it.
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, '0'))
    .join('')
}

export async function handleRegisterAgent(
  req: Request,
  dependencies: { createSupabaseClient?: typeof createClient } = {},
): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: getCorsHeaders(req) })
  }

  const proxyHeader = req.headers.get(DMV_PROXY_HEADER)
  const proxySecret = Deno.env.get('DMV_PROXY_SECRET')
  // `!!proxySecret` guard: an unset DMV_PROXY_SECRET can NEVER accept a request
  // (fail closed). Constant-time compare against the shared secret only — the
  // legacy public 'v1' constant is no longer accepted (rollout complete).
  const secretOk = !!proxySecret && timingSafeStrEqual(proxyHeader, proxySecret)
  if (!secretOk) {
    return new Response(
      JSON.stringify({
        error: 'direct_access_deprecated',
        message:
          'Direct access to this edge function is no longer supported. Use ' +
          'https://dmv.agentcommunity.org/api/register (the DMV worker proxy) ' +
          'or update @agentcommunity/dmv-agent to the latest version via ' +
          '`bunx @agentcommunity/dmv-agent register`.',
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

  // Canonicalize agent_name before validation (trim/lowercase/strip trailing
  // `.agent`) — mirrors the Worker, and guards the direct-to-Supabase path so a
  // user-typed "mybot.agent" can never become "mybot.agent.agent" downstream.
  body.agent_name = normalizeAgentName(body.agent_name)

  // Validate
  const validationError = validateRequest(body)
  if (validationError) {
    return new Response(
      JSON.stringify({ error: validationError }),
      { status: 400, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  const agentName = (body.agent_name as string).trim()
  // Normalize email at the data layer (trim + lowercase) — mirrors the Worker's
  // canonicalization. The Worker is the normal ingress, but the only thing
  // guarding the direct-to-Supabase path is the x-dmv-proxy header; without this,
  // a direct call could case-vary the email (Foo@ vs foo@) into separate cap
  // buckets and bypass the lifetime cap, and land mixed-case rows that fragment
  // PAGE's `WHERE email=` joins + the on_dmv_registration user-matching.
  const email = (body.email as string).trim().toLowerCase()
  const operatorName = (body.operator_name as string) || null
  const description = (body.description as string) || null
  const signupSource = (body.signup_source as string) || 'api'
  const registrationType = (body.registration_type as string) || 'AGENT'
  const organizationName = (body.organization_name as string) || null

  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
    || req.headers.get('cf-connecting-ip')
    || null

  // Supabase client with service role key (server-side only — created after rate limit check)
  const createSupabaseClient = dependencies.createSupabaseClient ?? createClient
  const supabase = createSupabaseClient(
    Deno.env.get('SUPABASE_URL')!,
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  )

  // Generate certificate ID before quota checks so an exact retry can recover
  // the already-recorded cert even when the email is at its new-registration cap.
  const certFields = [agentName, email]
  const certificateId = generateCertificateId(certFields, registrationType.toLowerCase())
  const domain = agentName + '.agent'

  // Permalink + badge URLs (badges proxied through the DMV Worker; see worker/index.ts)
  const DMV_BASE = 'https://dmv.agentcommunity.org'
  const permalinkUrl = `${DMV_BASE}/c/${encodeURIComponent(certificateId)}/${encodeURIComponent(agentName)}`
  const badgeUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}`
  const badgeCardUrl = `${DMV_BASE}/badge?id=${encodeURIComponent(certificateId)}&style=card`

  const findExactExistingRegistration = async () => {
    return await supabase
      .from('registrations')
      .select('certificate_id')
      .eq('certificate_id', certificateId)
      .eq('email', email)
      .eq('domain_requested', domain)
      .eq('registration_type', registrationType)
      .maybeSingle()
  }

  const { data: existingRegistration, error: existingRegistrationError } =
    await findExactExistingRegistration()

  if (existingRegistrationError) {
    return new Response(
      JSON.stringify({ error: 'Could not verify your existing pre-registration — please try again.' }),
      { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  if (existingRegistration) {
    return new Response(
      JSON.stringify(existingRegistrationPayload({
        certificateId,
        agentName,
        domain,
        registrationType,
        permalinkUrl,
        badgeUrl,
        badgeCardUrl,
      })),
      { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  // Lifetime cap: 5 unendorsed / 12 endorsed per email.
  // Counts only DMV agent cards (certificate_id IS NOT NULL), not PAGE signups.
  const { count: totalCerts, error: countError } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .eq('email', email)
    .not('certificate_id', 'is', null)

  // Fail CLOSED: a discarded count error would default to 0 and skip the cap
  // entirely. Reject rather than let an unbounded registration through.
  if (countError) {
    return new Response(
      JSON.stringify({ error: 'Could not verify your registration limit — please try again.' }),
      { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  const CAP_UNENDORSED = 5
  const CAP_ENDORSED = 12
  const currentCount = totalCerts ?? 0

  if (currentCount >= CAP_UNENDORSED) {
    // Check if user is endorsed. Signing truth on the shared PAGE schema is
    // `registrations.status = 'complete'` — `endorsement_status` stopped being
    // written and is a dead column there (see PAGE's docs/SUPABASE.md). We
    // deliberately do NOT also join endorsement_requests (status IN
    // ('signed','complete')): that table has no email column, only
    // `registration_id` and an unreliable `signer_email`, and this cap check
    // is keyed by email (no user_id/registration_id available here), so that
    // join would require first resolving every registration_id for the email
    // via `registrations` anyway — status='complete' on `registrations`
    // already gives us that in one query with no extra join.
    const { data: endorsed } = await supabase
      .from('registrations')
      .select('status')
      .eq('email', email)
      .eq('status', 'complete')
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
        // Hashed, never raw — see sha256Hex above. `registrations` is the same
        // production table the PAGE app reads; raw IPs never belong here.
        client_ip_hash: ip ? await sha256Hex(ip) : null,
      },
    })

  if (insertError) {
    const duplicateCert =
      insertError.code === '23505' &&
      `${insertError.message ?? ''} ${insertError.details ?? ''}`.includes('certificate_id')

    // Duplicate certificate_id — exact same pre-registration was already recorded.
    // This is not a "domain taken" state: domain_requested is intentionally not unique,
    // and multiple parties may pre-register the same .agent name.
    if (duplicateCert) {
      const { data: existingAfterConflict, error: existingAfterConflictError } =
        await findExactExistingRegistration()

      if (existingAfterConflictError) {
        return new Response(
          JSON.stringify({ error: 'Could not verify your existing pre-registration — please try again.' }),
          { status: 503, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        )
      }

      if (!existingAfterConflict) {
        return new Response(
          JSON.stringify({
            error: 'Certificate ID collision. Please retry with a different name.',
          }),
          { status: 409, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
        )
      }

      return new Response(
        JSON.stringify(existingRegistrationPayload({
          certificateId,
          agentName,
          domain,
          registrationType,
          permalinkUrl,
          badgeUrl,
          badgeCardUrl,
        })),
        { status: 200, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
      )
    }
    console.error('Supabase insert error:', JSON.stringify(insertError, null, 2))
    return new Response(
      JSON.stringify({ error: 'Registration failed. Please try again.' }),
      { status: 500, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
    )
  }

  // Ticket number — global position in the pre-registration queue ("NOW
  // SERVING" flavor on the kiosk done screen and CLI success screen).
  // Counted after the insert so the new row is included (#1 for the first
  // registrant). Approximate under concurrent inserts, which is fine for a
  // cosmetic counter. Fail OPEN: the registration already succeeded, so a
  // count error just omits the field rather than failing the request.
  let queueNumber: number | null = null
  const { count: globalCount, error: queueCountError } = await supabase
    .from('registrations')
    .select('*', { count: 'exact', head: true })
    .not('certificate_id', 'is', null)
  if (!queueCountError && typeof globalCount === 'number' && globalCount > 0) {
    queueNumber = globalCount
  }

  return new Response(
    JSON.stringify({
      certificate_id: certificateId,
      agent_name: agentName,
      domain,
      registration_type: registrationType,
      queue_number: queueNumber,
      permalink_url: permalinkUrl,
      badge_url: badgeUrl,
      badge_card_url: badgeCardUrl,
      message:
        `Certificate ${certificateId} issued for ${domain}. ` +
        `Check your email for your .agent credentials.`,
    }),
    { status: 201, headers: { ...getCorsHeaders(req), 'Content-Type': 'application/json' } },
  )
}

if (import.meta.main) {
  Deno.serve((req) => handleRegisterAgent(req))
}
