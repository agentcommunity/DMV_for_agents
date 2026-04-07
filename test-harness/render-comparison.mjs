#!/usr/bin/env node
/**
 * Visual fidelity harness.
 *
 * Renders the same set of test cards from two Cloudflare sources and saves
 * them side-by-side in an HTML page so you can eyeball any differences:
 *
 *   1. DEPLOYED  — production worker at https://dmv.agentcommunity.org/api/card
 *   2. LOCAL     — local `wrangler dev` at http://localhost:8787/api/card
 *                  (Worker → Container → @napi-rs/canvas)
 *   3. (optional) — set CF_EXTRA_URL to add a third column, e.g. a staging
 *                   workers.dev subdomain from a PR deploy
 *
 * Both primary sources run the SAME Skia renderer now that the Vercel-era
 * stack is gone, so any visual drift is a red flag — it means either the
 * deployed container is on a different content-hash than the local one, or
 * a change to js/card-draw.js hasn't been mirrored into
 * container/src/card-renderer.js yet.
 *
 * Output:
 *   test-harness/output/<source>/<case>.png
 *   test-harness/output/index.html
 *
 * Usage:
 *   # In one terminal:
 *   pnpm cf:dev
 *   # In another:
 *   pnpm cf:test:render
 *   # Then open test-harness/output/index.html
 */

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, 'output');

const SOURCES = {
  deployed: {
    label: 'Deployed (dmv.agentcommunity.org)',
    baseUrl: 'https://dmv.agentcommunity.org',
  },
  local: {
    label: 'Local (wrangler dev)',
    baseUrl: process.env.CF_LOCAL_URL ?? 'http://localhost:8787',
  },
};

if (process.env.CF_EXTRA_URL) {
  SOURCES.extra = {
    label: `Extra (${process.env.CF_EXTRA_URL})`,
    baseUrl: process.env.CF_EXTRA_URL,
  };
}

// ─────────────────────────────────────────────────────────────────────────────

function buildUrl(baseUrl, params) {
  const url = new URL('/api/card', baseUrl);
  url.searchParams.set('name', params.name);
  if (params.id) url.searchParams.set('id', params.id);
  if (params.type) url.searchParams.set('type', params.type);
  return url.toString();
}

function caseId(c) {
  const parts = [c.name, c.type ?? 'individual'];
  if (c.id) parts.push(c.id);
  return parts.join('--').replace(/[^a-zA-Z0-9-]/g, '_');
}

async function fetchPng(url) {
  const start = Date.now();
  const res = await fetch(url);
  const ms = Date.now() - start;
  if (!res.ok) {
    throw new Error(`${url} → ${res.status} ${res.statusText}`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, ms, headers: Object.fromEntries(res.headers) };
}

async function renderAll() {
  const testCasesPath = join(__dirname, 'test-cases.json');
  const { cases, withExplicitId } = JSON.parse(await readFile(testCasesPath, 'utf8'));
  const allCases = [...cases, ...withExplicitId];

  await mkdir(OUTPUT_DIR, { recursive: true });
  for (const sourceKey of Object.keys(SOURCES)) {
    await mkdir(join(OUTPUT_DIR, sourceKey), { recursive: true });
  }

  const results = [];

  for (const c of allCases) {
    const id = caseId(c);
    const row = { id, case: c, sources: {} };
    console.log(`\n→ ${id}`);

    for (const [sourceKey, source] of Object.entries(SOURCES)) {
      const url = buildUrl(source.baseUrl, c);
      try {
        const { buffer, ms, headers } = await fetchPng(url);
        const filename = `${id}.png`;
        await writeFile(join(OUTPUT_DIR, sourceKey, filename), buffer);
        row.sources[sourceKey] = {
          ok: true,
          path: `${sourceKey}/${filename}`,
          bytes: buffer.length,
          ms,
          cache: headers['x-cache'] ?? null,
        };
        console.log(`   ${sourceKey.padEnd(12)}: ${ms}ms, ${buffer.length}B${headers['x-cache'] ? ` [${headers['x-cache']}]` : ''}`);
      } catch (err) {
        row.sources[sourceKey] = { ok: false, error: err.message };
        console.log(`   ${sourceKey.padEnd(12)}: FAIL ${err.message}`);
      }
    }

    results.push(row);
  }

  await writeIndexHtml(results);
  console.log(`\n✓ Done. Open ${join(OUTPUT_DIR, 'index.html')}`);
}

async function writeIndexHtml(results) {
  const sourceKeys = Object.keys(SOURCES);

  const rows = results.map((row) => {
    const cells = sourceKeys
      .map((key) => {
        const s = row.sources[key];
        if (!s?.ok) {
          return `<td class="cell err"><div class="err-msg">${escapeHtml(s?.error ?? 'no result')}</div></td>`;
        }
        return `
          <td class="cell">
            <img src="${s.path}" alt="${row.id} ${key}">
            <div class="meta">${s.ms}ms · ${(s.bytes / 1024).toFixed(1)} KB${s.cache ? ` · ${s.cache}` : ''}</div>
          </td>`;
      })
      .join('');

    const caseLabel = `<strong>${escapeHtml(row.case.name)}</strong><br><small>${row.case.type ?? 'individual'}${row.case.id ? ` · ${row.case.id}` : ''}</small>`;

    return `<tr><td class="label">${caseLabel}</td>${cells}</tr>`;
  });

  const headerCells = sourceKeys.map((k) => `<th>${escapeHtml(SOURCES[k].label)}</th>`).join('');

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>DMV card render comparison</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, sans-serif; background: #0a0d0a; color: #ddd; padding: 24px; }
    h1 { color: #33ff88; }
    table { border-collapse: collapse; width: 100%; }
    th, td { padding: 12px; vertical-align: top; border-bottom: 1px solid #222; }
    th { text-align: left; color: #33ff88; font-size: 14px; }
    td.label { font-size: 13px; width: 140px; color: #888; }
    td.label strong { color: #fff; font-size: 14px; }
    td.cell img { display: block; width: 440px; height: auto; border: 1px solid #222; }
    td.cell .meta { font-size: 11px; color: #666; margin-top: 6px; }
    td.cell.err { background: #2a0000; color: #ff8888; min-width: 440px; }
    .err-msg { font-size: 12px; word-break: break-all; }
    .legend { color: #888; font-size: 13px; margin-bottom: 24px; }
  </style>
</head>
<body>
  <h1>DMV card render comparison</h1>
  <p class="legend">Generated ${new Date().toISOString()}. ${results.length} test cases. Eyeball each row left-to-right — deployed and local should match pixel-for-pixel (same Skia renderer).</p>
  <table>
    <thead><tr><th>Case</th>${headerCells}</tr></thead>
    <tbody>${rows.join('\n')}</tbody>
  </table>
</body>
</html>`;

  await writeFile(join(OUTPUT_DIR, 'index.html'), html);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[m]));
}

renderAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
