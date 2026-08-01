import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = path.join(ROOT, 'scripts/verify-dmv-packages.mjs');
const DIST = path.join(ROOT, 'packages/dmv-agent/dist');

test('package verifier proves source packs and leaves no generated dist', () => {
  const packOutput = mkdtempSync(path.join(tmpdir(), 'dmv-verified-packs-'));
  assert.equal(existsSync(DIST), false, 'fixture must start without package dist');
  try {
    const result = spawnSync(process.execPath, [
      VERIFIER,
      '--',
      '--registry-mode=none',
      '--skip-production',
      `--pack-output=${packOutput}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 180_000,
    });

    assert.equal(
      result.status,
      0,
      `verifier failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.match(result.stdout, /DMV package reproducibility verification passed/);
    assert.deepEqual(
      readdirSync(packOutput).sort(),
      ['agentcommunity-dmv-agent-0.3.0.tgz', 'dmv-agent-0.1.3.tgz'],
    );
    assert.equal(existsSync(DIST), false, 'verifier must clean generated package dist');
  } finally {
    rmSync(packOutput, { recursive: true, force: true });
  }
});

test('package verifier cleans generated dist when verified-pack export fails', () => {
  const packOutput = mkdtempSync(path.join(tmpdir(), 'dmv-colliding-packs-'));
  const collision = path.join(packOutput, 'agentcommunity-dmv-agent-0.3.0.tgz');
  writeFileSync(collision, 'do-not-overwrite');
  assert.equal(existsSync(DIST), false, 'fixture must start without package dist');

  try {
    const result = spawnSync(process.execPath, [
      VERIFIER,
      '--registry-mode=none',
      '--skip-production',
      `--pack-output=${packOutput}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 180_000,
    });

    assert.notEqual(result.status, 0, 'colliding verified pack export must fail closed');
    assert.equal(readFileSync(collision, 'utf8'), 'do-not-overwrite');
    assert.equal(existsSync(DIST), false, 'failure path must clean generated package dist');
  } finally {
    rmSync(packOutput, { recursive: true, force: true });
  }
});
