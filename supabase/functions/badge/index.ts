// Supabase Edge Function — badge
// Generates SVG badges for agent identities.
//
// Usage:
//   /badge?id=MESA-DD6-660J              → flat badge (default)
//   /badge?id=MESA-DD6-660J&style=flat   → shields.io-style for READMEs
//   /badge?id=MESA-DD6-660J&style=card   → larger branded badge for websites
//
// Note: ?domain= is deprecated (ambiguous with multiple pre-registrations per domain).
// Use ?id=CERT-ID instead.
//
// Badge always links back to dmv.agentcommunity.org for SEO.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
const DMV_BASE = 'https://dmv.agentcommunity.org'

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

// Estimate text width using monospace character width
function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * 0.6 + 10
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// --- Flat badge (shields.io style) ---
// ┌─────────┬──────────────────────────────┐
// │  .agent │  my-assistant · MESA-DD6-660J │
// └─────────┴──────────────────────────────┘

function flatBadge(agentName: string | null, certId: string, status: 'registered' | 'valid' | 'invalid'): string {
  const label = '.agent'
  const labelFontSize = 11
  const valueFontSize = 11

  let value: string
  let color: string

  if (status === 'invalid') {
    value = `${certId} · invalid`
    color = '#e05d44' // red
  } else if (agentName) {
    value = `${agentName} · ${certId}`
    color = '#33ff88' // DMV green
  } else {
    value = certId
    color = '#97ca00' // yellow-green (valid but not found in DB)
  }

  const labelWidth = textWidth(label, labelFontSize)
  const valueWidth = textWidth(value, valueFontSize)
  const totalWidth = labelWidth + valueWidth
  const height = 20
  const permalink = agentName
    ? `${DMV_BASE}/#/${encodeURIComponent(certId)}/${encodeURIComponent(agentName)}`
    : DMV_BASE

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${totalWidth}" height="${height}" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <title>${escapeXml(label)}: ${escapeXml(value)}</title>
  <a href="${escapeXml(permalink)}" target="_blank">
    <linearGradient id="s" x2="0" y2="100%">
      <stop offset="0" stop-color="#bbb" stop-opacity=".1"/>
      <stop offset="1" stop-opacity=".1"/>
    </linearGradient>
    <clipPath id="r">
      <rect width="${totalWidth}" height="${height}" rx="3" fill="#fff"/>
    </clipPath>
    <g clip-path="url(#r)">
      <rect width="${labelWidth}" height="${height}" fill="#1a1a2e"/>
      <rect x="${labelWidth}" width="${valueWidth}" height="${height}" fill="${color}"/>
      <rect width="${totalWidth}" height="${height}" fill="url(#s)"/>
    </g>
    <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" text-rendering="geometricPrecision" font-size="${labelFontSize}">
      <text aria-hidden="true" x="${labelWidth / 2}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(labelWidth - 10) * 10}">${escapeXml(label)}</text>
      <text x="${labelWidth / 2}" y="140" transform="scale(.1)" fill="#fff" textLength="${(labelWidth - 10) * 10}">${escapeXml(label)}</text>
      <text aria-hidden="true" x="${(labelWidth + valueWidth / 2) * 10}" y="150" fill="#010101" fill-opacity=".3" transform="scale(.1)" textLength="${(valueWidth - 10) * 10}">${escapeXml(value)}</text>
      <text x="${(labelWidth + valueWidth / 2) * 10}" y="140" transform="scale(.1)" fill="${status === 'invalid' ? '#fff' : '#111'}" textLength="${(valueWidth - 10) * 10}">${escapeXml(value)}</text>
    </g>
  </a>
</svg>`
}

// --- Card badge (branded, for websites) ---

function cardBadge(agentName: string | null, certId: string, status: 'registered' | 'valid' | 'invalid'): string {
  const displayName = agentName ? `${agentName}.agent` : 'unknown.agent'
  const width = 280
  const height = 72
  const permalink = agentName
    ? `${DMV_BASE}/#/${encodeURIComponent(certId)}/${encodeURIComponent(agentName)}`
    : DMV_BASE

  const statusColor = status === 'invalid' ? '#e05d44' : '#33ff88'
  const statusText = status === 'registered' ? 'Registered' : status === 'valid' ? 'Valid ID' : 'Invalid'
  const checkmark = status !== 'invalid' ? '✓' : '✗'

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <title>${escapeXml(displayName)} — DMV Certificate ${escapeXml(certId)}</title>
  <a href="${escapeXml(permalink)}" target="_blank">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0d0d1a"/>
        <stop offset="100%" stop-color="#1a1a2e"/>
      </linearGradient>
    </defs>
    <rect width="${width}" height="${height}" rx="6" fill="url(#bg)" stroke="${statusColor}" stroke-opacity="0.4" stroke-width="1"/>

    <!-- Left accent bar -->
    <rect x="0" y="0" width="4" height="${height}" rx="2" fill="${statusColor}"/>

    <!-- Agent name -->
    <text x="16" y="28" font-family="monospace" font-size="15" font-weight="bold" fill="${statusColor}">${escapeXml(displayName)}</text>

    <!-- Certificate ID -->
    <text x="16" y="46" font-family="monospace" font-size="11" fill="#888">${escapeXml(certId)}</text>

    <!-- Status pill -->
    <rect x="16" y="54" width="${(statusText.length + 2) * 7}" height="14" rx="3" fill="${statusColor}" fill-opacity="0.15"/>
    <text x="20" y="64" font-family="monospace" font-size="9" fill="${statusColor}">${checkmark} ${escapeXml(statusText)}</text>

    <!-- DMV branding -->
    <text x="${width - 8}" y="64" font-family="monospace" font-size="8" fill="#555" text-anchor="end">dmv.agentcommunity.org</text>
  </a>
</svg>`
}

// --- Handler ---

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
      },
    })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { status: 405 })
  }

  const url = new URL(req.url)
  const certId = url.searchParams.get('id')
  const domain = url.searchParams.get('domain')
  const style = url.searchParams.get('style') || 'flat'

  if (domain && !certId) {
    return new Response(
      'badge?domain= is deprecated (ambiguous with multiple pre-registrations). Use ?id=CERT-ID instead.',
      { status: 400, headers: { 'Content-Type': 'text/plain', 'Access-Control-Allow-Origin': '*' } },
    )
  }

  if (!certId) {
    return new Response('Provide ?id=CERT-ID', { status: 400 })
  }

  // If cert ID provided, verify check digit
  if (certId && !verifyCertificateId(certId)) {
    const svg = style === 'card'
      ? cardBadge(null, certId, 'invalid')
      : flatBadge(null, certId, 'invalid')

    return new Response(svg, {
      status: 200, // Return 200 even for invalid — it's a badge, not an API
      headers: {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=300',
        'Access-Control-Allow-Origin': '*',
      },
    })
  }

  // Try to look up in DB for agent name
  let agentName: string | null = null
  let status: 'registered' | 'valid' = 'valid'

  try {
    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    const { data } = await supabase
      .from('registrations')
      .select('certificate_id, domain_requested')
      .eq('certificate_id', certId)
      .maybeSingle()

    if (data) {
      agentName = data.domain_requested.replace(/\.agent$/, '')
      status = 'registered'
    }
  } catch {
    // DB unavailable — fall back to check-digit-only badge
  }

  const svg = style === 'card'
    ? cardBadge(agentName, certId, status)
    : flatBadge(agentName, certId, status)

  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml',
      'Cache-Control': 'public, max-age=300',
      'Access-Control-Allow-Origin': '*',
    },
  })
})
