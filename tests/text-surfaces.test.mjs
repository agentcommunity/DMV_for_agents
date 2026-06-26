import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runAudit } from '../scripts/text-surfaces/audit-lib.mjs';

test('text surface audit loads expected surface inventory', () => {
  const report = runAudit();
  assert.ok(report.summary.surfaces >= 10, 'expected at least 10 text surfaces');
  assert.ok(report.surfaces.every((s) => s.filesLoaded.length > 0), 'all surfaces should resolve files');
});

test('critical alignment checks pass', () => {
  const report = runAudit();
  assert.equal(
    report.checks.errors.length,
    0,
    `critical checks failed: ${JSON.stringify(report.checks.errors, null, 2)}`,
  );
});

test('card renderer field labels stay aligned across client and server', () => {
  const report = runAudit();
  assert.equal(
    report.checks.cardFieldParity.matches,
    true,
    `card field mismatch: ${JSON.stringify(report.checks.cardFieldParity, null, 2)}`,
  );
});

test('CRT and CLI launch copy does not imply exclusive domain ownership', () => {
  const report = runAudit();
  const surfaces = Object.fromEntries(report.surfaces.map((surface) => [surface.id, surface]));
  const runtimeText = [
    surfaces.web_crt?.combinedText ?? '',
    surfaces.cli_runtime?.combinedText ?? '',
    surfaces.mcp_runtime?.combinedText ?? '',
  ].join('\n');

  assert.doesNotMatch(runtimeText, /registered agent identity is non-transferable/i);
  assert.doesNotMatch(runtimeText, /verified member of the DMV community/i);
  assert.doesNotMatch(runtimeText, /every pre-registration strengthens our claim/i);
  assert.doesNotMatch(runtimeText, /agent registered successfully/i);
  assert.doesNotMatch(runtimeText, /\b(taken|unavailable|available)\b.*\.agent/i);
  assert.match(runtimeText, /duplicates? (are )?allowed|multiple parties can pre-register/i);
});

test('CRT and CLI ask for legal name and explain email validation', () => {
  const report = runAudit();
  const surfaces = Object.fromEntries(report.surfaces.map((surface) => [surface.id, surface]));
  const webCrtText = surfaces.web_crt?.combinedText ?? '';
  const cliText = surfaces.cli_runtime?.combinedText ?? '';

  assert.match(webCrtText, /Full legal name/);
  assert.doesNotMatch(webCrtText, /prompt: ['"]Your name['"]/);
  assert.doesNotMatch(webCrtText, /placeholder: ['"]full name['"]/);
  assert.match(webCrtText, /Verify your email to validate/);
  assert.match(cliText, /Verify your email to validate/);
});

test('register-agent only treats certificate-id conflicts as pre-registration recovery', () => {
  const source = readFileSync('supabase/functions/register-agent/index.ts', 'utf8');

  assert.doesNotMatch(source, /if\s*\(\s*insertError\.code\s*===\s*['"]23505['"]\s*\)/);
  assert.match(source, /includes\(['"]certificate_id['"]\)/);
  assert.match(source, /already_recorded/);
  assert.match(source, /domain_requested is intentionally not\s+unique/);
});

test('register-agent recovers exact existing certificates before lifetime-cap checks', () => {
  const source = readFileSync('supabase/functions/register-agent/index.ts', 'utf8');
  const certificateIndex = source.indexOf('const certificateId = generateCertificateId');
  const existingLookupIndex = source.indexOf(".eq('certificate_id', certificateId)");
  const lifetimeCapIndex = source.indexOf('// Lifetime cap:');

  assert.ok(certificateIndex > -1, 'certificate ID generation not found');
  assert.ok(existingLookupIndex > -1, 'existing certificate lookup not found');
  assert.ok(lifetimeCapIndex > -1, 'lifetime cap block not found');
  assert.ok(
    certificateIndex < lifetimeCapIndex,
    'certificate ID must be available before lifetime cap enforcement',
  );
  assert.ok(
    existingLookupIndex < lifetimeCapIndex,
    'exact existing certificate recovery must run before lifetime cap enforcement',
  );
});
