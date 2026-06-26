import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI_PATH = path.join(ROOT, 'packages/dmv-agent/dist/cli.js');
const CLI_TEST_TIMEOUT_MS = 30_000;

function runCli(args, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dmv-agent-cli-test-'));
  try {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: options.timeoutMs ?? CLI_TEST_TIMEOUT_MS,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...options.env,
      },
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

function runCliAsync(args, options = {}) {
  const home = mkdtempSync(path.join(tmpdir(), 'dmv-agent-cli-test-'));
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(process.execPath, [CLI_PATH, ...args], {
      cwd: ROOT,
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        ...options.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rmSync(home, { recursive: true, force: true });
      resolve({
        status: null,
        stdout,
        stderr: `${stderr}\nCLI timed out after ${options.timeoutMs ?? CLI_TEST_TIMEOUT_MS}ms`,
      });
    }, options.timeoutMs ?? CLI_TEST_TIMEOUT_MS);
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('close', (status) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rmSync(home, { recursive: true, force: true });
      resolve({ status, stdout, stderr });
    });
  });
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
    capturedBody = await readRequestBody(request);
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({
      certificate_id: 'MESA-DD6-660J',
      agent_name: 'smoke-agent',
      domain: 'smoke-agent.agent',
      message: 'Certificate MESA-DD6-660J issued',
      permalink_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/smoke-agent',
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

async function withRegistrationResponseServer(responseConfig, handler) {
  let capturedBody;
  const server = http.createServer(async (request, response) => {
    capturedBody = await readRequestBody(request);
    response.writeHead(responseConfig.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseConfig.body));
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

async function withDoctorServer(handler, options = {}) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      response.writeHead(options.healthStatus ?? 200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(options.healthBody ?? { worker: 'ok', container: { status: 'ok' } }));
      return;
    }
    if (request.method === 'GET' && url.pathname === '/api/card') {
      response.writeHead(options.cardStatus ?? 200, {
        'Content-Type': options.cardContentType ?? 'image/png',
        'Content-Length': '8',
      });
      response.end('pngbytes');
      return;
    }
    if (request.method === 'GET' && url.pathname === '/badge') {
      response.writeHead(options.badgeStatus ?? 200, { 'Content-Type': options.badgeContentType ?? 'image/svg+xml' });
      response.end('<svg></svg>');
      return;
    }
    if (request.method === 'POST' && url.pathname === '/api/register') {
      const body = await readRequestBody(request);
      assert.equal(body, '{}');
      response.writeHead(options.registerStatus ?? 400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(options.registerBody ?? { error: 'agent_name is required' }));
      return;
    }

    response.writeHead(404, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: 'not found' }));
  });

  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

test('verify accepts a valid DMV certificate ID', () => {
  const result = runCli(['verify', 'MESA-DD6-660J']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /has a valid check digit/);
});

test('verify rejects an invalid DMV certificate ID', () => {
  const result = runCli(['verify', 'FAKE-000-0000']);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /has an invalid check digit/);
});

test('non-interactive registration validates fields before network submission', () => {
  const result = runCli(
    [
      'register',
      '--name',
      'smoke-agent',
      '--email',
      'operator@example.com',
      '--operator',
      'A'.repeat(101),
    ],
    {
      env: {
        DMV_API_ENDPOINT: 'http://127.0.0.1:9/dmv-smoke-should-not-be-called',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operator/i);
  assert.match(result.stderr, /100/);
  assert.doesNotMatch(result.stderr, /Network error|ECONNREFUSED|fetch failed/i);
});

test('non-interactive registration rejects whitespace-only operator before network submission', () => {
  const result = runCli(
    [
      'register',
      '--name',
      'smoke-agent',
      '--email',
      'operator@example.com',
      '--operator',
      '   ',
    ],
    {
      env: {
        DMV_API_ENDPOINT: 'http://127.0.0.1:9/dmv-smoke-should-not-be-called',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /operator/i);
  assert.doesNotMatch(result.stderr, /Network error|ECONNREFUSED|fetch failed/i);
});

test('non-interactive registration rejects over-limit description before network submission', () => {
  const result = runCli(
    [
      'register',
      '--name',
      'smoke-agent',
      '--email',
      'operator@example.com',
      '--operator',
      'Smoke Operator',
      '--description',
      'D'.repeat(501),
    ],
    {
      env: {
        DMV_API_ENDPOINT: 'http://127.0.0.1:9/dmv-smoke-should-not-be-called',
      },
    },
  );

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /description/i);
  assert.match(result.stderr, /500/);
  assert.doesNotMatch(result.stderr, /Network error|ECONNREFUSED|fetch failed/i);
});

test('non-interactive registration normalizes whitespace-only description before submission', async () => {
  await withCaptureServer(async (endpoint, getCapturedBody) => {
    const result = await runCliAsync(
      [
        'register',
        '--name',
        'smoke-agent',
        '--email',
        'operator@example.com',
        '--operator',
        'Smoke Operator',
        '--description',
        '   ',
      ],
      {
        env: {
          DMV_API_ENDPOINT: endpoint,
        },
      },
    );

    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(getCapturedBody());
    assert.equal(body.description, null);
  });
});

test('non-interactive registration treats an existing pre-registration response as success', async () => {
  await withRegistrationResponseServer(
    {
      status: 409,
      body: {
        error: 'Agent already registered',
        certificate_id: 'MESA-DD6-660J',
        permalink_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/shared-agent',
      },
    },
    async (endpoint, getCapturedBody) => {
      const result = await runCliAsync(
        [
          'register',
          '--name',
          'shared-agent',
          '--email',
          'operator@example.com',
          '--operator',
          'Smoke Operator',
        ],
        {
          env: {
            DMV_API_ENDPOINT: endpoint,
          },
        },
      );

      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /PRE-REGISTRATION COMPLETE/);
      assert.match(result.stderr, /MESA-DD6-660J/);
      assert.match(result.stderr, /shared-agent\.agent/);
      assert.doesNotMatch(result.stderr, /taken|unavailable|failed/i);

      const body = JSON.parse(getCapturedBody());
      assert.equal(body.agent_name, 'shared-agent');
      assert.equal(body.email, 'operator@example.com');
    },
  );
});

test('public registration validation preserves optional operator compatibility', async () => {
  const { validateAgentRegistration } = await import('../packages/dmv-agent/dist/validate.js');

  assert.deepEqual(
    validateAgentRegistration({
      agentName: 'api-agent',
      email: 'operator@example.com',
    }),
    [],
  );

  const errors = validateAgentRegistration({
    agentName: 'api-agent',
    email: 'operator@example.com',
    operatorName: 'A'.repeat(101),
    description: 'B'.repeat(501),
  });

  assert.deepEqual(errors.map((error) => error.field), ['operatorName', 'description']);
});

test('doctor passes against read-only DMV endpoints', async () => {
  await withDoctorServer(async (baseUrl) => {
    const result = await runCliAsync(['doctor', '--base-url', baseUrl], {
      env: { NO_COLOR: '1' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /DMV doctor/);
    assert.match(result.stderr, /OK/);
    assert.match(result.stderr, /healthz/);
    assert.match(result.stderr, /card png/);
    assert.match(result.stderr, /badge svg/);
    assert.match(result.stderr, /register validation/);
  });
});

test('doctor --json emits machine-readable readiness output', async () => {
  await withDoctorServer(async (baseUrl) => {
    const result = await runCliAsync(['doctor', '--base-url', baseUrl, '--json'], {
      env: { NO_COLOR: '1' },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.baseUrl, baseUrl);
    assert.deepEqual(
      payload.checks.map((check) => check.label),
      ['healthz', 'card png', 'badge svg', 'register validation'],
    );
    assert.ok(payload.checks.every((check) => check.status === 'pass'));
    assert.ok(payload.checks.some((check) =>
      check.label === 'healthz' &&
      check.detail === 'worker=ok container=ok'
    ));
    assert.ok(payload.checks.some((check) =>
      check.label === 'register validation' &&
      check.detail === 'empty payload rejected with agent_name validation'
    ));
  });
});

test('doctor fails when healthz reports a degraded worker or container', async () => {
  await withDoctorServer(
    async (baseUrl) => {
      const result = await runCliAsync(['doctor', '--base-url', baseUrl, '--json'], {
        env: { NO_COLOR: '1' },
      });

      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.ok(payload.checks.some((check) =>
        check.label === 'healthz' &&
        check.status === 'fail' &&
        check.detail === 'worker=ok container=degraded'
      ));
    },
    { healthBody: { worker: 'ok', container: { status: 'degraded' } } },
  );
});

test('doctor fails when the card endpoint stops returning PNGs', async () => {
  await withDoctorServer(
    async (baseUrl) => {
      const result = await runCliAsync(['doctor', '--base-url', baseUrl], {
        env: { NO_COLOR: '1' },
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /DMV doctor/);
      assert.match(result.stderr, /FAILED/);
      assert.match(result.stderr, /expected image\/png/);
    },
    { cardContentType: 'text/plain' },
  );
});

test('doctor --json preserves non-zero status and reports failed checks', async () => {
  await withDoctorServer(
    async (baseUrl) => {
      const result = await runCliAsync(['doctor', '--base-url', baseUrl, '--json'], {
        env: { NO_COLOR: '1' },
      });

      assert.notEqual(result.status, 0);
      assert.equal(result.stderr, '');
      const payload = JSON.parse(result.stdout);
      assert.equal(payload.ok, false);
      assert.ok(payload.checks.some((check) =>
        check.label === 'card png' &&
        check.status === 'fail' &&
        check.detail.includes('expected image/png')
      ));
    },
    { cardContentType: 'text/plain' },
  );
});
