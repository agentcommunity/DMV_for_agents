import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKED_SMOKE = path.join(ROOT, 'scripts/smoke-packed-dmv-agent.mjs');
const PACKED_SMOKE_TIMEOUT_MS = 180_000;

test('packed @agentcommunity/dmv-agent tarball exposes a working dmv-agent binary', () => {
  const result = spawnSync(process.execPath, [PACKED_SMOKE], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      NO_COLOR: '1',
    },
    timeout: PACKED_SMOKE_TIMEOUT_MS,
  });

  assert.equal(
    result.status,
    0,
    `packed smoke failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /Packed DMV CLI smoke passed/);
});
