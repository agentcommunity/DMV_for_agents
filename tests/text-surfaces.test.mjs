import test from 'node:test';
import assert from 'node:assert/strict';
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
