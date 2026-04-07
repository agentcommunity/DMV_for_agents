#!/usr/bin/env node
/**
 * Build script for the Cloudflare Workers Static Assets deploy.
 *
 * Four responsibilities (run in order):
 *
 *   1. Sync the PPSupplyMono font from fonts/ into container/fonts/ so the
 *      Docker build context has it. This used to be a separate `cf:vendor`
 *      script that also copied api/card-renderer.js + api/qr-encode.js into
 *      container/src/ — those `api/` copies went away after the Vercel
 *      cutover, so the container/src/ files are now canonical. The font is
 *      the one remaining thing that lives outside container/ (because the
 *      browser uses it too) and has to be mirrored in.
 *
 *   2. Drift-check the browser QR encoder against the container copy.
 *      js/qr-encode.js is served to the browser via Workers Static Assets,
 *      and container/src/qr-encode.js runs inside the Skia renderer. Cards
 *      rendered browser-side and server-side must encode the same permalink
 *      into an identical QR matrix, so the two files have to stay byte-
 *      identical. The check aborts the build with a clear error if they
 *      diverge.
 *
 *   3. Copy the DMV SPA's production-facing files into ./dist, which is what
 *      wrangler.jsonc points its `assets.directory` at. Anything not listed
 *      here will NOT be uploaded to Cloudflare — keep it explicit so dev
 *      tools, docs, and node_modules never leak into the deploy.
 *
 *   4. Compute a content hash of all container source files and write it
 *      to worker/container-instance.ts. The Worker uses this hash as the
 *      Durable Object ID when calling getContainer(), which means any
 *      change to the container code (Dockerfile, server.mjs, renderer,
 *      font) automatically spawns a fresh container instance with the new
 *      image. No manual instance-ID bumps required.
 *
 * Run before `wrangler deploy` (or via `pnpm cf:deploy` which chains them).
 */

import { rm, mkdir, cp, copyFile, stat, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
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

// Files at non-root paths — keep separate from FILES (root-only) and DIRS
// (full subtree) so we don't accidentally drag entire `packages/` into dist.
// Each entry is a single file path; parent dirs are created on demand.
const NESTED_FILES = [
  // Fetched by js/app.js line ~603 — the agent welcome packet shown in the
  // "About" panel. Without this, that view 404s in production.
  'packages/dmv-agent/skills/dmv/SKILL.md',
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

// ─────────────────────────────────────────────────────────────────────────────
//  Container instance ID — content hash of container source files
// ─────────────────────────────────────────────────────────────────────────────
//
// The Cloudflare Container behind /api/card and /api/og is bound as a Durable
// Object. The DO is identified by a string passed to getContainer(). If that
// string stays the same across deploys, the existing DO instance keeps
// serving the OLD container image until it sleeps + restarts. Bad for fast
// iteration.
//
// Fix: derive the DO ID from a content hash of every file that goes into
// the container image. If any of those files change, the hash changes, the
// DO ID changes, and the very next request spawns a fresh DO instance using
// the latest image. If nothing in the container changed, the ID is stable
// and we don't pay an unnecessary respawn cost.

const CONTAINER_HASH_INPUTS = [
  'container/Dockerfile',
  'container/package.json',
  'container/server.mjs',
  'container/src/card-renderer.js',
  'container/src/qr-encode.js',
  'container/fonts/PPSupplyMono-Regular.otf',
];

async function hashContainerSources() {
  const hash = createHash('sha256');
  for (const rel of CONTAINER_HASH_INPUTS) {
    const abs = join(ROOT, rel);
    if (!(await exists(abs))) {
      throw new Error(`[cf:build] container hash input missing: ${rel}`);
    }
    const data = await readFile(abs);
    // Include the file path in the hash so renaming a file changes the hash
    // even if its content survives.
    hash.update(`${rel}\0`);
    hash.update(data);
    hash.update('\n');
  }
  return hash.digest('hex').slice(0, 12);
}

async function writeContainerInstanceModule() {
  const id = await hashContainerSources();
  const fullId = `card-renderer-${id}`;
  const target = join(ROOT, 'worker', 'container-instance.ts');
  const body = `// AUTO-GENERATED by scripts/build-cf.mjs — do not edit by hand.
// Gitignored. Regenerated on every \`pnpm cf:build\` (which runs as part of
// cf:dev and cf:deploy). The hash is derived from the container source
// files; bumping it forces Cloudflare to spawn a fresh Container Durable
// Object instance running the latest image.
//
// If TypeScript complains this file is missing, run \`pnpm cf:build\`.

export const CONTAINER_INSTANCE_ID = '${fullId}' as const;
`;
  await writeFile(target, body);
  console.log(`[cf:build]   container hash: ${fullId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Font sync: fonts/PPSupplyMono-Regular.otf → container/fonts/
// ─────────────────────────────────────────────────────────────────────────────
//
// The container Docker build context is ./container, so the font has to sit
// under container/fonts/ for `COPY fonts/PPSupplyMono-Regular.otf ./fonts/`
// in container/Dockerfile to resolve. The browser serves the same font out
// of the repo-root fonts/ directory via Workers Static Assets. Keeping these
// in sync used to be a manual `cf:vendor` step; now it runs automatically as
// part of the build so a font swap on the browser side can never ship a
// stale copy into the container image.

const FONT_SOURCE = 'fonts/PPSupplyMono-Regular.otf';
const FONT_CONTAINER = 'container/fonts/PPSupplyMono-Regular.otf';

async function syncFont() {
  const src = join(ROOT, FONT_SOURCE);
  const dst = join(ROOT, FONT_CONTAINER);
  if (!(await exists(src))) {
    throw new Error(`[cf:build] font source missing: ${FONT_SOURCE}`);
  }
  await mkdir(dirname(dst), { recursive: true });
  await copyFile(src, dst);
  console.log(`[cf:build]   font synced: ${FONT_SOURCE} → ${FONT_CONTAINER}`);
}

// ─────────────────────────────────────────────────────────────────────────────
//  Drift check: js/qr-encode.js ↔ container/src/qr-encode.js
// ─────────────────────────────────────────────────────────────────────────────
//
// The browser and the container both generate QR matrices for the card's
// permalink URL. If the two files diverge — even by a whitespace character
// — the browser-rendered preview and the server-rendered PNG can encode
// subtly different matrices, and users will end up with cards whose QR code
// resolves differently depending on which side drew them.
//
// Abort the build hard if drift is detected. The fix is always to make the
// two files byte-identical (usually by copying one over the other and
// committing the result). No auto-sync here because we don't know which
// side has the intended change.

const QR_BROWSER = 'js/qr-encode.js';
const QR_CONTAINER = 'container/src/qr-encode.js';

async function checkQrDrift() {
  const [a, b] = await Promise.all([
    readFile(join(ROOT, QR_BROWSER)),
    readFile(join(ROOT, QR_CONTAINER)),
  ]);
  if (a.length !== b.length || !a.equals(b)) {
    throw new Error(
      `[cf:build] QR encoder drift detected:\n` +
        `  ${QR_BROWSER} (${a.length} B) ≠ ${QR_CONTAINER} (${b.length} B)\n` +
        `  Both files must be byte-identical. Fix by copying one onto the other\n` +
        `  (pick whichever side holds the intended change) and committing.`,
    );
  }
  console.log(`[cf:build]   qr-encode drift ok (${a.length} B identical)`);
}

async function build() {
  console.log(`[cf:build] dist = ${DIST}`);

  // 1. Sync the font into the container build context so the Docker image
  //    picks up any change to fonts/PPSupplyMono-Regular.otf automatically.
  await syncFont();

  // 2. Hard-fail on QR encoder drift between browser and container.
  await checkQrDrift();

  // 3. Container instance ID (worker/container-instance.ts) — must run before
  //    wrangler/tsc so the Worker import resolves.
  await writeContainerInstanceModule();

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

  for (const rel of NESTED_FILES) {
    const src = join(ROOT, rel);
    const dst = join(DIST, rel);
    if (!(await exists(src))) {
      console.warn(`[cf:build] ⚠ skipping missing nested file: ${rel}`);
      continue;
    }
    await mkdir(dirname(dst), { recursive: true });
    await copyFile(src, dst);
    const s = await stat(dst);
    totalFiles += 1;
    totalBytes += s.size;
    console.log(`[cf:build]   ${rel} → ${formatBytes(s.size)}`);
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
