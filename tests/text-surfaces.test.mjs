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

test('canonical agent surfaces use the scoped package command', () => {
  const report = runAudit();
  const surfaces = Object.fromEntries(report.surfaces.map((surface) => [surface.id, surface]));
  const canonicalSurfaceIds = [
    'web_crt',
    'web_share',
    'web_metadata',
    'root_readme',
    'llms_manifest',
    'cli_runtime',
    'agent_readme',
    'register_api',
  ];

  for (const surfaceId of canonicalSurfaceIds) {
    const text = surfaces[surfaceId]?.combinedText ?? '';
    assert.doesNotMatch(
      text,
      /bunx dmv-agent(?:\s|['"`]|$)/,
      `${surfaceId} must not present the compatibility alias as the primary command`,
    );
    assert.doesNotMatch(
      text,
      /"args"\s*:\s*\[\s*"dmv-agent"\s*\]/,
      `${surfaceId} must not configure the compatibility alias as the primary MCP package`,
    );
  }

  assert.match(surfaces.root_readme?.combinedText ?? '', /bunx @agentcommunity\/dmv-agent/);
  assert.match(surfaces.llms_manifest?.combinedText ?? '', /bunx @agentcommunity\/dmv-agent/);
  assert.match(surfaces.cli_runtime?.combinedText ?? '', /bunx @agentcommunity\/dmv-agent/);
});

test('operator authentication docs use the canonical scoped package', () => {
  const authDmv = readFileSync('AUTH_DMV.md', 'utf8');

  assert.match(authDmv, /bunx @agentcommunity\/dmv-agent register/);
  assert.match(authDmv, /"args"\s*:\s*\["@agentcommunity\/dmv-agent"\]/);
  assert.doesNotMatch(authDmv, /bunx dmv-agent(?:\s|['"`]|$)/);
  assert.doesNotMatch(authDmv, /"args"\s*:\s*\["dmv-agent"\]/);
});

test('package release docs distinguish registry releases from source versions', () => {
  const canonicalManifest = JSON.parse(
    readFileSync('packages/dmv-agent/package.json', 'utf8'),
  );
  const aliasManifest = JSON.parse(
    readFileSync('packages/dmv-agent-alias/package.json', 'utf8'),
  );
  const releaseDocs = [
    readFileSync('packages/dmv-agent/CHANGELOG.md', 'utf8'),
    readFileSync('AGENT_HANDOFF.md', 'utf8'),
  ].join('\n');

  assert.equal(canonicalManifest.version, '0.3.0');
  assert.equal(aliasManifest.version, '0.1.3');
  assert.equal(aliasManifest.dependencies['@agentcommunity/dmv-agent'], '^0.3.0');
  assert.match(releaseDocs, /published[\s\S]{0,80}@agentcommunity\/dmv-agent@0\.2\.2/i);
  assert.match(releaseDocs, /published[\s\S]{0,80}dmv-agent@0\.1\.2/i);
  assert.match(releaseDocs, /source[\s\S]{0,80}0\.3\.0/i);
  assert.match(releaseDocs, /alias source[\s\S]{0,80}0\.1\.3/i);
  assert.doesNotMatch(releaseDocs, /@agentcommunity\/dmv-agent@0\.2\.1/);
  assert.doesNotMatch(releaseDocs, /dmv-agent@0\.1\.1/);
  assert.doesNotMatch(releaseDocs, /@agentcommunity\/dmv-agent@\^0\.2\.1/);
});

test('live lookup docs retain evidence without stale rollout status', () => {
  const lookupDocs = [
    readFileSync('AGENT_HANDOFF.md', 'utf8'),
    readFileSync('README.md', 'utf8'),
    readFileSync('packages/dmv-agent/README.md', 'utf8'),
  ].join('\n');

  assert.doesNotMatch(lookupDocs, /Task 8/i);
  assert.doesNotMatch(lookupDocs, /record-keeping outstanding/i);
  assert.match(lookupDocs, /fabafe6/);
  assert.match(lookupDocs, /d9755e66-3883-4970-be84-a59307011f14/);
  assert.match(lookupDocs, /v3/i);
  assert.match(lookupDocs, /(?:live|deployed)/i);
  assert.doesNotMatch(lookupDocs, /v3 (?:is )?not deployed/i);
});

test('database guidance permits only hashed client IP metadata', () => {
  const databaseDocs = [
    readFileSync('AUTH_DMV.md', 'utf8'),
    readFileSync('packages/dmv-agent/DEPLOY.md', 'utf8'),
  ].join('\n');

  assert.match(databaseDocs, /client_ip_hash/);
  assert.doesNotMatch(databaseDocs, /metadata[^\n]*\bclient_ip\b/);
  assert.doesNotMatch(databaseDocs, /metadata->>'client_ip'/);
  assert.doesNotMatch(databaseDocs, /idx_registrations_client_ip/);
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

test('active DMV copy keeps proposed .agent names conditional and AID non-binding', () => {
  const skill = readFileSync('packages/dmv-agent/skills/dmv/SKILL.md', 'utf8');
  const aboutPoster = readFileSync('js/AboutPoster.js', 'utf8');
  const architecture = readFileSync('ARCHITECTURE.md', 'utf8');

  assert.doesNotMatch(skill, /reserve an agent name/i);
  assert.doesNotMatch(skill, /(?:your|their) own [`"]?\.agent(?:`|")? identity/i);
  assert.doesNotMatch(aboutPoster, /pre-registrations[\s\S]{0,80}feed into the official/i);
  assert.doesNotMatch(architecture, /registrations feed into the official DNS-based AID system/i);
  assert.match(skill, /requested .*\.agent.*does not allocate/i);
  assert.match(aboutPoster, /if \.agent is approved/i);
  assert.match(architecture, /if `?\.agent`? is approved/i);
});

test('llms.txt repository links use the canonical DMV_for_agents repository', () => {
  const llms = readFileSync('llms.txt', 'utf8');

  assert.doesNotMatch(llms, /github\.com\/agentcommunity\/dmv(?:\/|\))/i);
  assert.match(
    llms,
    /github\.com\/agentcommunity\/DMV_for_agents\/tree\/main\/packages\/dmv-agent/,
  );
});

test('package docs distinguish fallback from typed live unavailability and rate limits', () => {
  const docs = [
    readFileSync('AGENT_HANDOFF.md', 'utf8'),
    readFileSync('packages/dmv-agent/CHANGELOG.md', 'utf8'),
    readFileSync('packages/dmv-agent/README.md', 'utf8'),
    readFileSync('ARCHITECTURE.md', 'utf8'),
  ].join('\n');

  assert.match(docs, /typed HTTP 503 [`"]?unavailable[`"]?.*live.*inconclusive/is);
  assert.match(docs, /HTTP 429.*live.*inconclusive/is);
  assert.match(docs, /unexpected HTTP.*partial.*inconsistent.*format-only/is);
  assert.doesNotMatch(
    docs,
    /(?:service|Worker) (?:reporting itself )?unavailable[^.]{0,120}falls? back/is,
  );
});
