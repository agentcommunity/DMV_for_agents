import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERIFIER = path.join(ROOT, 'scripts/verify-dmv-packages.mjs');
const DIST = path.join(ROOT, 'packages/dmv-agent/dist');

test('package verifier proves source packs and leaves no generated dist', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'dmv-verified-packs-'));
  const packOutput = path.join(parent, 'artifacts');
  assert.equal(existsSync(DIST), false, 'fixture must start without package dist');
  try {
    const result = spawnSync(process.execPath, [
      VERIFIER,
      '--',
      '--registry-mode=none',
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
    rmSync(parent, { recursive: true, force: true });
  }
});

test('package verifier leaves no partial export when the second artifact collides', () => {
  const packOutput = mkdtempSync(path.join(tmpdir(), 'dmv-colliding-packs-'));
  const collision = path.join(packOutput, 'dmv-agent-0.1.3.tgz');
  writeFileSync(collision, 'do-not-overwrite');
  assert.equal(existsSync(DIST), false, 'fixture must start without package dist');

  try {
    const result = spawnSync(process.execPath, [
      VERIFIER,
      '--registry-mode=none',
      `--pack-output=${packOutput}`,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 180_000,
    });

    assert.notEqual(result.status, 0, 'colliding verified pack export must fail closed');
    assert.equal(readFileSync(collision, 'utf8'), 'do-not-overwrite');
    assert.equal(
      existsSync(path.join(packOutput, 'agentcommunity-dmv-agent-0.3.0.tgz')),
      false,
      'canonical output must not be left behind when alias export collides',
    );
    assert.equal(existsSync(DIST), false, 'failure path must clean generated package dist');
  } finally {
    rmSync(packOutput, { recursive: true, force: true });
  }
});

test('pre-existing source dist fails before verifier temp creation and is preserved', () => {
  const marker = path.join(DIST, 'user-owned.txt');
  mkdirSync(DIST, { recursive: true });
  writeFileSync(marker, 'preserve me');
  const before = new Set(
    readdirSync(tmpdir()).filter((name) => name.startsWith('dmv-package-verifier-')),
  );
  try {
    const result = spawnSync(process.execPath, [
      VERIFIER,
      '--',
      '--registry-mode=none',
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
      timeout: 30_000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /pre-existing.*dist/i);
    assert.equal(readFileSync(marker, 'utf8'), 'preserve me');
    const after = readdirSync(tmpdir()).filter((name) => name.startsWith('dmv-package-verifier-'));
    assert.deepEqual(after.filter((name) => !before.has(name)), []);
  } finally {
    rmSync(DIST, { recursive: true, force: true });
  }
});
