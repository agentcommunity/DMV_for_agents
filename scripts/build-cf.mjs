#!/usr/bin/env node
/**
 * Build script for the Cloudflare Workers Static Assets deploy.
 *
 * Copies the DMV SPA's production-facing files into ./dist, which is what
 * wrangler.jsonc points its `assets.directory` at. Anything not listed here
 * will NOT be uploaded to Cloudflare — keep it explicit so dev tools, docs,
 * and node_modules never leak into the deploy.
 *
 * Run before `wrangler deploy` (or via `pnpm cf:deploy` which chains them).
 */

import { rm, mkdir, cp, copyFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

// ─────────────────────────────────────────────────────────────────────────────
//  What gets shipped to Workers Static Assets
// ─────────────────────────────────────────────────────────────────────────────

// Whole directories — everything inside is recursively copied.
const DIRS = [
  'js',       // ES modules: app.js, TV.js, CRTTerminal.js, HoloCard.js, etc.
  'css',      // Stylesheets
  'fonts',    // PPSupplyMono + PPSupplySans (browser-served, also vendored to container/)
  'images',   // Static images
  'audio',    // Sound effects (~6 MB — free on CF static assets)
  'models',   // tv1.glb (2.2 MB — free on CF static assets, immutable cache)
];

// Individual root-level files.
const FILES = [
  'index.html',
  'llms.txt',
  'robots.txt',
  'sitemap.xml',
];

// Things explicitly NOT shipped (documented for clarity, no enforcement):
//   - card-lab.html, card-lab-v2.html  → dev tools
//   - *.md                              → docs
//   - api/, container/, worker/         → server code
//   - test-harness/, scripts/           → dev tooling
//   - vercel.json, .vercelignore        → Vercel-only
//   - middleware.js                     → ported into worker/index.ts
//   - node_modules/, .git/              → never

// ─────────────────────────────────────────────────────────────────────────────

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function build() {
  console.log(`[cf:build] dist = ${DIST}`);
  if (await exists(DIST)) {
    await rm(DIST, { recursive: true, force: true });
  }
  await mkdir(DIST, { recursive: true });

  let totalFiles = 0;
  let totalBytes = 0;

  for (const dir of DIRS) {
    const src = join(ROOT, dir);
    const dst = join(DIST, dir);
    if (!(await exists(src))) {
      console.warn(`[cf:build] ⚠ skipping missing dir: ${dir}`);
      continue;
    }
    await cp(src, dst, { recursive: true });
    const { count, bytes } = await measure(dst);
    totalFiles += count;
    totalBytes += bytes;
    console.log(`[cf:build]   ${dir.padEnd(10)} → ${count} files, ${formatBytes(bytes)}`);
  }

  for (const file of FILES) {
    const src = join(ROOT, file);
    const dst = join(DIST, file);
    if (!(await exists(src))) {
      console.warn(`[cf:build] ⚠ skipping missing file: ${file}`);
      continue;
    }
    await copyFile(src, dst);
    const s = await stat(dst);
    totalFiles += 1;
    totalBytes += s.size;
    console.log(`[cf:build]   ${file.padEnd(10)} → ${formatBytes(s.size)}`);
  }

  // Optional: copy public/_headers if it exists. CF Workers Static Assets
  // honours the same _headers format as CF Pages.
  const headers = join(ROOT, 'public', '_headers');
  if (await exists(headers)) {
    await copyFile(headers, join(DIST, '_headers'));
    console.log('[cf:build]   _headers   → copied');
  }

  console.log(`[cf:build] done. ${totalFiles} files, ${formatBytes(totalBytes)} total`);
}

async function measure(dir) {
  const { readdir } = await import('node:fs/promises');
  let count = 0;
  let bytes = 0;
  async function walk(p) {
    const entries = await readdir(p, { withFileTypes: true });
    for (const e of entries) {
      const full = join(p, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else {
        const s = await stat(full);
        count += 1;
        bytes += s.size;
      }
    }
  }
  await walk(dir);
  return { count, bytes };
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

build().catch((err) => {
  console.error('[cf:build] FAILED:', err);
  process.exit(1);
});
