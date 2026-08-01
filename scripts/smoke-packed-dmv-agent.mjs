#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertPackedRegistrationBody,
  PACKED_SMOKE_CLI_TIMEOUT_MS,
  PACKED_SMOKE_NPM_TIMEOUT_MS,
  runAsyncWithTimeout,
  runSyncWithTimeout,
} from './lib/packed-dmv-smoke-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PACKAGE_DIR = path.join(ROOT, 'packages/dmv-agent');

const keepTemp = process.env.DMV_PACKED_SMOKE_KEEP === '1';
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dmv-agent-packed-smoke-'));
const packDir = path.join(tempRoot, 'pack');
const projectDir = path.join(tempRoot, 'consumer');
const homeDir = path.join(tempRoot, 'home');

try {
  mkdirSync(packDir, { recursive: true });
  mkdirSync(projectDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  const tarball = packTarball();
  installTarball(tarball);
  runInstalledVerify();
  await runInstalledDoctor();
  await runInstalledRegistration();
  console.log('Packed DMV CLI smoke passed');
} finally {
  if (keepTemp) {
    console.log(`[packed-smoke] kept temp dir: ${tempRoot}`);
  } else {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function packTarball() {
  const result = runSyncWithTimeout('npm', ['pack', '--pack-destination', packDir], {
    cwd: PACKAGE_DIR,
    env: process.env,
    timeoutMs: PACKED_SMOKE_NPM_TIMEOUT_MS,
  });
  const filename = result.stdout
    .trim()
    .split('\n')
    .find((line) => line.endsWith('.tgz'));

  if (!filename) {
    throw new Error(`npm pack did not report a tarball:\n${result.stdout}\n${result.stderr}`);
  }

  return path.join(packDir, filename);
}

function installTarball(tarball) {
  writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ private: true, type: 'module' }, null, 2),
  );

  runSyncWithTimeout('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', tarball], {
    cwd: projectDir,
    env: process.env,
    timeoutMs: PACKED_SMOKE_NPM_TIMEOUT_MS,
  });
}

function runInstalledVerify() {
  // --format-only: this smoke test proves the packed binary works end-to-end
  // (pack, install, invoke), not that dmv.agentcommunity.org/api/lookup is
  // reachable or has published the lookup upstream (see AGENT_HANDOFF.md
  // Task 8). The default live-check path is covered against a local mock
  // server in tests/dmv-agent-cli.test.mjs.
  const result = runSyncWithTimeout(installedBin(), ['verify', 'MESA-DD6-660J', '--format-only'], {
    cwd: projectDir,
    env: smokeEnv(),
    timeoutMs: PACKED_SMOKE_CLI_TIMEOUT_MS,
  });

  assert.match(result.stderr, /has a valid check digit/);
}

async function runInstalledDoctor() {
  await withCaptureServer(async (endpoint) => {
    const baseUrl = endpoint.replace(/\/api\/register$/, '');
    const result = await runAsyncWithTimeout(
      installedBin(),
      ['doctor', '--base-url', baseUrl],
      {
        cwd: projectDir,
        env: smokeEnv(),
        timeoutMs: PACKED_SMOKE_CLI_TIMEOUT_MS,
      },
    );

    assert.match(result.stderr, /DMV doctor/);
    assert.match(result.stderr, /OK/);
    assert.match(result.stderr, /register validation/);
  });
}

async function runInstalledRegistration() {
  await withCaptureServer(async (endpoint, getCapturedBody) => {
    const result = await runAsyncWithTimeout(
      installedBin(),
      [
        'register',
        '--name',
        'packed-smoke-agent',
        '--email',
        'operator@example.com',
        '--operator',
        'Packed Smoke Operator',
        '--description',
        '   ',
      ],
      {
        cwd: projectDir,
        env: {
          ...smokeEnv(),
          DMV_API_ENDPOINT: endpoint,
        },
        timeoutMs: PACKED_SMOKE_CLI_TIMEOUT_MS,
      },
    );

    assert.match(result.stderr, /Certificate:\s+MESA-DD6-660J/);
    const body = JSON.parse(getCapturedBody());
    assertPackedRegistrationBody(body);
  });
}

function installedBin() {
  const name = process.platform === 'win32' ? 'dmv-agent.cmd' : 'dmv-agent';
  return path.join(projectDir, 'node_modules', '.bin', name);
}

function smokeEnv() {
  return {
    ...process.env,
    HOME: homeDir,
    USERPROFILE: homeDir,
    NO_COLOR: '1',
  };
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => {
      body += chunk;
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });
}

async function withCaptureServer(handler) {
  let capturedBody;
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ worker: 'ok', container: { status: 'ok' } }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/card') {
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '8' });
      response.end('pngbytes');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/badge') {
      response.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      response.end('<svg></svg>');
      return;
    }

    capturedBody = await readRequestBody(request);
    if (request.method === 'POST' && url.pathname === '/api/register' && capturedBody === '{}') {
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'agent_name is required' }));
      return;
    }

    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      certificate_id: 'MESA-DD6-660J',
      agent_name: 'packed-smoke-agent',
      domain: 'packed-smoke-agent.agent',
      message: 'Certificate MESA-DD6-660J issued',
      permalink_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/packed-smoke-agent',
      badge_url: 'https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J',
      badge_card_url: 'https://dmv.agentcommunity.org/badge?id=MESA-DD6-660J&style=card',
    }));
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await handler(`http://127.0.0.1:${address.port}/api/register`, () => capturedBody);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}
