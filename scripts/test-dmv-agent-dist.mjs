#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'packages/dmv-agent/dist');

try {
  rmSync(DIST, { recursive: true, force: true });
  run('pnpm', ['--dir', 'packages/dmv-agent', 'build']);
  run(process.execPath, [
    '--test',
    'tests/dmv-agent-cli.test.mjs',
    'tests/dmv-agent-mcp.test.mjs',
    'tests/packed-dmv-smoke-utils.test.mjs',
  ]);
} finally {
  rmSync(DIST, { recursive: true, force: true });
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw result.error ?? new Error(`${command} failed with status ${result.status}`);
  }
}
