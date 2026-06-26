#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requireFromCliPkg = createRequire(path.join(ROOT, 'packages/dmv-agent/package.json'));

function runStep(label, command, args, options = {}) {
  console.log(`[build] ${label}`);
  const result = spawnSync(command, args, {
    cwd: ROOT,
    stdio: 'inherit',
    ...options,
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

runStep('Running root checks', process.execPath, ['--test', 'tests/text-surfaces.test.mjs']);
runStep('Running web registration client tests', process.execPath, ['--test', 'tests/web-registration-client.test.mjs']);

let tscBin;
try {
  tscBin = requireFromCliPkg.resolve('typescript/bin/tsc');
} catch (err) {
  console.error('[build] Could not resolve TypeScript for packages/dmv-agent.');
  console.error('[build] Install workspace dependencies first with `pnpm install` or `bun install` at the repo root.');
  process.exit(1);
}

runStep(
  'Building @agentcommunity/dmv-agent',
  process.execPath,
  [tscBin, '-p', path.join(ROOT, 'packages/dmv-agent/tsconfig.json')],
);

runStep('Running DMV CLI smoke tests', process.execPath, ['--test', 'tests/dmv-agent-cli.test.mjs']);

runStep('Running DMV MCP smoke tests', process.execPath, ['--test', 'tests/dmv-agent-mcp.test.mjs']);

runStep('Running packed DMV CLI smoke helper tests', process.execPath, ['--test', 'tests/packed-dmv-smoke-utils.test.mjs']);

runStep('Running packed DMV CLI install smoke', process.execPath, ['--test', 'tests/dmv-agent-packed-cli.test.mjs']);

console.log('[build] Complete');
