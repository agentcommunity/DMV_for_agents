// G-CODE static gate for DMV edge holders H17 (badge), H18 (lookup-agent) and
// H19 (register-agent). Supabase key migration plan 2026-11-08, section 6.
//
// The platform keeps injecting the legacy service_role env var into every edge
// function until step F2, so a working call proves nothing. This check is the
// proof that the holder no longer reads a legacy key and never sends a key as a
// Bearer token. It scans each holder's whole relative import graph.
//
// The scan is line-based and textual. Besides legacy names and Bearer keys it
// rejects any `default` index (the plan forbids the `default` entry of
// SUPABASE_SECRET_KEYS) and any Deno.env.toObject (which could assemble a
// legacy name from pieces). It does not try to defeat deliberate obfuscation.
//
// Modes:
// - Transition (today): DMV_LEGACY_KEY_FALLBACK is true. The single fallback read
//   in _shared/supabase-key.ts is allow-listed; every other legacy read fails.
// - Enforcing (cut-over): set DMV_LEGACY_KEY_FALLBACK = false in
//   _shared/supabase-key.ts (or run with DMV_GCODE_ENFORCE=1 to preview). The
//   fallback allow-list entry stops applying, so this test fails until the
//   fallback line is deleted.

import { DMV_LEGACY_KEY_FALLBACK, SUPABASE_JS_PINNED_URL } from './supabase-key.ts'

const FUNCTIONS_DIR = new URL('../', import.meta.url)

// Holder -> function directory -> the named secret key it must use.
const HOLDERS: Array<{ id: string; dir: string; keyName: string }> = [
  { id: 'H17', dir: 'badge', keyName: 'dmv_read' },
  { id: 'H18', dir: 'lookup-agent', keyName: 'dmv_read' },
  { id: 'H19', dir: 'register-agent', keyName: 'dmv_register' },
]

// The holder's legacy names (plan section 6, G-CODE regex, restricted to the
// names an edge runtime can provide).
const LEGACY_NAME = /SUPABASE_SERVICE_ROLE_KEY|SUPABASE_ANON_KEY|SUPABASE_SERVICE_KEY|MAIN_SUPABASE_KEY|\bSUPABASE_KEY\b/
const BEARER = /authorization.{0,20}bearer/i
// The plan forbids the `default` entry of SUPABASE_SECRET_KEYS; the loader only
// ever reads a named entry. Any `['default']` / `.default` index fails.
const DEFAULT_ENTRY = /\[\s*['"`]default['"`]\s*\]|\.default\b/
// Dumping the environment lets a legacy name be assembled from pieces and read
// past the LEGACY_NAME scan, so Deno.env.toObject fails anywhere in the graph.
const ENV_DUMP = /Deno\s*\.\s*env\s*\.\s*toObject\b/

type Rule = 'legacy' | 'bearer' | 'default-entry' | 'env-dump'
const RULES: Array<[Rule, RegExp]> = [
  ['legacy', LEGACY_NAME],
  ['bearer', BEARER],
  ['default-entry', DEFAULT_ENTRY],
  ['env-dump', ENV_DUMP],
]

interface AllowEntry {
  file: string // relative to supabase/functions/
  marker: string // must appear on the allowed line; each entry must match exactly one line
  rule: Rule
  reason: string
  transitionOnly: boolean
}

const ALLOW_LIST: Array<AllowEntry> = [
  {
    file: '_shared/supabase-key.ts',
    marker: 'g-code-allow: legacy-fallback',
    rule: 'legacy',
    reason: 'the one legacy fallback read, behind DMV_LEGACY_KEY_FALLBACK; must be deleted at cut-over',
    transitionOnly: true,
  },
  {
    file: '_shared/supabase-key.ts',
    marker: 'g-code-allow: strips-bearer',
    rule: 'bearer',
    reason: 'this line removes a Bearer equal to the API key (plan U2); it never adds one',
    transitionOnly: false,
  },
]

export interface Violation {
  file: string
  line: number
  rule: Rule
  text: string
}

export function scanSource(
  file: string,
  source: string,
  enforcing: boolean,
  allowList: Array<AllowEntry> = ALLOW_LIST,
): Array<Violation> {
  const violations: Array<Violation> = []
  source.split('\n').forEach((text, index) => {
    for (const [rule, pattern] of RULES) {
      if (!pattern.test(text)) continue
      const allowed = allowList.some((entry) =>
        entry.file === file && entry.rule === rule && text.includes(entry.marker) &&
        (!entry.transitionOnly || !enforcing)
      )
      if (!allowed) violations.push({ file, line: index + 1, rule, text: text.trim() })
    }
  })
  return violations
}

const IMPORT_SPEC = /(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

async function importGraph(entry: URL): Promise<Map<string, string>> {
  const seen = new Map<string, string>()
  const queue: Array<URL> = [entry]
  while (queue.length > 0) {
    const current = queue.pop()!
    const rel = current.pathname.slice(FUNCTIONS_DIR.pathname.length)
    if (seen.has(rel)) continue
    const source = await Deno.readTextFile(current)
    seen.set(rel, source)
    for (const match of source.matchAll(IMPORT_SPEC)) {
      const spec = match[1] ?? match[2] ?? match[3]
      if (spec && (spec.startsWith('./') || spec.startsWith('../'))) queue.push(new URL(spec, current))
    }
  }
  return seen
}

function enforcingMode(): boolean {
  return DMV_LEGACY_KEY_FALLBACK === false || Deno.env.get('DMV_GCODE_ENFORCE') === '1'
}

function fail(violations: Array<Violation>, enforcing: boolean): never {
  const mode = enforcing ? 'enforcing' : 'transition'
  throw new Error(
    `G-CODE (${mode}) found ${violations.length} violation(s):\n` +
      violations.map((v) => `  ${v.file}:${v.line} [${v.rule}] ${v.text}`).join('\n'),
  )
}

for (const holder of HOLDERS) {
  Deno.test(`G-CODE ${holder.id} ${holder.dir}: no legacy key read and no Bearer key in the import graph`, async () => {
    const enforcing = enforcingMode()
    const graph = await importGraph(new URL(`${holder.dir}/index.ts`, FUNCTIONS_DIR))
    const violations: Array<Violation> = []
    for (const [file, source] of graph) violations.push(...scanSource(file, source, enforcing))
    if (violations.length > 0) fail(violations, enforcing)
  })

  Deno.test(`G-CODE ${holder.id} ${holder.dir}: creates its client only through the named key ${holder.keyName}`, async () => {
    const source = await Deno.readTextFile(new URL(`${holder.dir}/index.ts`, FUNCTIONS_DIR))
    if (!source.includes(`createDmvSupabaseClient('${holder.keyName}'`)) {
      throw new Error(`${holder.dir}/index.ts must call createDmvSupabaseClient('${holder.keyName}', ...)`)
    }
    if (/esm\.sh\/@supabase\/supabase-js/.test(source)) {
      throw new Error(`${holder.dir}/index.ts imports supabase-js directly; import it via _shared/supabase-key.ts (one pinned version)`)
    }
    if (/Deno\.env\.get\(\s*['"]SUPABASE_/.test(source)) {
      throw new Error(`${holder.dir}/index.ts reads a SUPABASE_* env var directly; the key loader owns that`)
    }
  })
}

Deno.test('G-CODE: supabase-js is pinned to an exact version', () => {
  if (!/^https:\/\/esm\.sh\/@supabase\/supabase-js@\d+\.\d+\.\d+$/.test(SUPABASE_JS_PINNED_URL)) {
    throw new Error(`supabase-js import is not pinned: ${SUPABASE_JS_PINNED_URL}`)
  }
})

Deno.test('G-CODE: the key loader imports exactly the pinned supabase-js URL', async () => {
  const source = await Deno.readTextFile(new URL('_shared/supabase-key.ts', FUNCTIONS_DIR))
  const imports = [...source.matchAll(/from '(https:\/\/esm\.sh\/@supabase\/supabase-js[^']*)'/g)].map((m) => m[1])
  if (imports.length !== 1 || imports[0] !== SUPABASE_JS_PINNED_URL) {
    throw new Error(`expected one import of ${SUPABASE_JS_PINNED_URL}, got ${JSON.stringify(imports)}`)
  }
})

Deno.test('G-CODE: every allow-list entry matches exactly one line', async () => {
  for (const entry of ALLOW_LIST) {
    const source = await Deno.readTextFile(new URL(entry.file, FUNCTIONS_DIR))
    const hits = source.split('\n').filter((line) => line.includes(entry.marker)).length
    if (hits !== 1) throw new Error(`${entry.file} marker "${entry.marker}" matched ${hits} lines, expected 1`)
  }
})

// Self-tests: the scanner must catch what it claims to catch (a gate that
// passes on broken code is not a gate).
Deno.test('G-CODE scanner catches a direct legacy read and a Bearer key', () => {
  const mutant = [
    "const k = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!",
    "headers.set('Authorization', `Bearer ${k}`)",
    "const a = Deno.env.get('SUPABASE_ANON_KEY')",
  ].join('\n')
  const found = scanSource('badge/index.ts', mutant, false)
  if (found.length !== 3) throw new Error(`expected 3 violations, got ${JSON.stringify(found)}`)
})

Deno.test('G-CODE scanner catches a default-entry read and an env dump', () => {
  const mutant = [
    "const k = JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')!)['default']",
    "const k2 = keys.default",
    "const k3 = keys[\"default\"]",
    "const all = Deno.env.toObject()",
    "const k4 = Deno.env.toObject()['SUPABASE_' + 'SERVICE_ROLE_KEY']",
  ].join('\n')
  const found = scanSource('badge/index.ts', mutant, false)
  const rules = found.map((v) => v.rule).sort().join(',')
  if (rules !== 'default-entry,default-entry,default-entry,env-dump,env-dump') {
    throw new Error(`expected 3 default-entry and 2 env-dump violations, got ${JSON.stringify(found)}`)
  }
})

Deno.test('G-CODE scanner: the fallback allow-list stops applying in enforcing mode', () => {
  const line = "  const legacy = env('SUPABASE_SERVICE_ROLE_KEY') // g-code-allow: legacy-fallback"
  if (scanSource('_shared/supabase-key.ts', line, false).length !== 0) {
    throw new Error('transition mode should allow the marked fallback line')
  }
  if (scanSource('_shared/supabase-key.ts', line, true).length !== 1) {
    throw new Error('enforcing mode must reject the fallback line')
  }
  if (scanSource('badge/index.ts', line, false).length !== 1) {
    throw new Error('the marker must only count in its own file')
  }
})
