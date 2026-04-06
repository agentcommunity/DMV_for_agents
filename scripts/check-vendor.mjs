#!/usr/bin/env node
/**
 * cf:vendor:check — fail fast if the committed vendored container files have
 * drifted from their api/ + fonts/ sources.
 *
 * Why this exists (I-1 in 2026-04-06-dmv-cf-fix-sprint.md):
 *   The cloudflare-migration branch ships a copy of api/card-renderer.js +
 *   api/qr-encode.js + fonts/PPSupplyMono-Regular.otf inside container/. The
 *   pnpm cf:vendor script copies them in. If a contributor edits the api/
 *   source file but forgets to run cf:vendor + git add the container/ copy,
 *   `main` (Vercel) and `cloudflare-migration` (Workers + Container) silently
 *   diverge: Vercel renders the new code, CF renders the old code, and the
 *   bake-off MD5 check would catch it but only after deploy.
 *
 *   This script runs at build time (wired into pnpm cf:dev and pnpm cf:deploy
 *   chains BEFORE cf:vendor) and exits non-zero on any byte-difference. The
 *   error message tells the dev exactly what to do: re-run pnpm cf:vendor and
 *   commit the result.
 *
 * Used by:
 *   pnpm cf:dev    →  cf:vendor:check && cf:vendor && cf:build && wrangler dev
 *   pnpm cf:deploy →  cf:vendor:check && cf:vendor && cf:build && wrangler deploy
 *
 * Manual override: if you intentionally want to skip the check (e.g. you're
 * mid-edit and the diff is expected), run cf:vendor and cf:build directly.
 */

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// (source on disk, vendored copy inside container/) pairs.
const VENDOR_PAIRS = [
  ['api/card-renderer.js', 'container/src/card-renderer.js'],
  ['api/qr-encode.js', 'container/src/qr-encode.js'],
  ['fonts/PPSupplyMono-Regular.otf', 'container/fonts/PPSupplyMono-Regular.otf'],
];

async function readBytes(rel) {
  try {
    return await readFile(join(ROOT, rel));
  } catch (err) {
    throw new Error(`[cf:vendor:check] cannot read ${rel}: ${err.message}`);
  }
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

async function main() {
  const drifted = [];
  for (const [source, copy] of VENDOR_PAIRS) {
    const [srcBytes, copyBytes] = await Promise.all([readBytes(source), readBytes(copy)]);
    if (!bytesEqual(srcBytes, copyBytes)) {
      drifted.push({ source, copy, srcSize: srcBytes.length, copySize: copyBytes.length });
    }
  }

  if (drifted.length > 0) {
    console.error('[cf:vendor:check] DRIFT DETECTED — committed container copies do not match api/ + fonts/ sources:');
    for (const d of drifted) {
      console.error(`  - ${d.source} (${d.srcSize}B) ≠ ${d.copy} (${d.copySize}B)`);
    }
    console.error('');
    console.error('Fix: pnpm cf:vendor && git add container/ && commit');
    console.error('     (or, if you really meant to skip the check, run cf:vendor + cf:build directly)');
    process.exit(1);
  }

  console.log(`[cf:vendor:check] ok — ${VENDOR_PAIRS.length} vendored files match sources`);
}

main().catch((err) => {
  console.error('[cf:vendor:check] FAILED:', err);
  process.exit(1);
});
