import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MCP_SERVER_PATH = path.join(ROOT, 'packages/dmv-agent/dist/mcp-server.js');
const requireFromPackage = createRequire(path.join(ROOT, 'packages/dmv-agent/package.json'));
const MCP_TEST_TIMEOUT_MS = 30_000;

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

async function withDoctorServer(handler) {
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
    if (request.method === 'POST' && url.pathname === '/api/register') {
      const body = await readRequestBody(request);
      assert.equal(body, '{}');
      response.writeHead(400, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: 'agent_name is required' }));
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

async function withLookupServer(responseFor, handler) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/api/lookup') {
      const id = url.searchParams.get('id') ?? '';
      const config = responseFor(id);
      response.writeHead(config.status, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(config.body));
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

async function withMcpClient(env, handler) {
  const { Client } = await import(
    pathToFileURL(requireFromPackage.resolve('@modelcontextprotocol/sdk/client/index.js')).href
  );
  const { StdioClientTransport } = await import(
    pathToFileURL(requireFromPackage.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
  );
  const client = new Client({ name: 'dmv-agent-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [MCP_SERVER_PATH],
    cwd: ROOT,
    stderr: 'pipe',
    env: { ...process.env, NO_COLOR: '1', ...env },
  });

  try {
    await withTimeout(client.connect(transport), 'MCP connect');
    await handler(client);
  } finally {
    await client.close();
  }
}

function textOf(result) {
  return result.content
    .filter((item) => item.type === 'text')
    .map((item) => item.text)
    .join('\n');
}

async function withTimeout(promise, label) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after ${MCP_TEST_TIMEOUT_MS}ms`)),
          MCP_TEST_TIMEOUT_MS,
        );
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

test('MCP server exposes and runs the read-only DMV doctor tool', async () => {
  await withDoctorServer(async (baseUrl) => {
    const { Client } = await import(
      pathToFileURL(requireFromPackage.resolve('@modelcontextprotocol/sdk/client/index.js')).href
    );
    const { StdioClientTransport } = await import(
      pathToFileURL(requireFromPackage.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
    );
    const client = new Client({ name: 'dmv-agent-test', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [MCP_SERVER_PATH],
      cwd: ROOT,
      stderr: 'pipe',
      env: {
        ...process.env,
        DMV_BASE_URL: baseUrl,
        NO_COLOR: '1',
      },
    });

    try {
      await withTimeout(client.connect(transport), 'MCP connect');
      const tools = await withTimeout(client.listTools(), 'MCP listTools');
      assert.ok(tools.tools.some((tool) => tool.name === 'dmv_doctor'));
      assert.ok(tools.tools.some((tool) => tool.name === 'register_agent'));
      assert.ok(tools.tools.some((tool) => tool.name === 'verify_certificate'));

      const result = await withTimeout(
        client.callTool({ name: 'dmv_doctor', arguments: {} }),
        'MCP dmv_doctor',
      );
      const text = result.content
        .filter((item) => item.type === 'text')
        .map((item) => item.text)
        .join('\n');

      assert.equal(result.isError, false);
      assert.match(text, /DMV doctor: OK/);
      assert.match(text, /healthz/);
      assert.match(text, /card png/);
      assert.match(text, /badge svg/);
      assert.match(text, /register validation/);
    } finally {
      await client.close();
    }
  });
});

test('MCP verify_certificate: format_only skips the network call entirely', async () => {
  await withMcpClient(
    { DMV_BASE_URL: 'http://127.0.0.1:9/dmv-smoke-should-not-be-called' },
    async (client) => {
      const result = await withTimeout(
        client.callTool({
          name: 'verify_certificate',
          arguments: { certificate_id: 'MESA-DD6-660J', format_only: true },
        }),
        'MCP verify_certificate format_only',
      );
      const text = textOf(result);

      assert.equal(result.isError, false);
      assert.match(text, /has a valid check digit/);
      assert.match(text, /format-only check/);
    },
  );
});

test('MCP verify_certificate: default live check reports issuance', async () => {
  await withLookupServer(
    (id) => ({
      status: 200,
      body: {
        certificate_id: id,
        status: 'issued',
        valid_format: true,
        issued: true,
        agent_name: 'smoke-agent',
        certificate_url: 'https://dmv.agentcommunity.org/c/MESA-DD6-660J/smoke-agent',
      },
    }),
    async (baseUrl) => {
      await withMcpClient({ DMV_BASE_URL: baseUrl }, async (client) => {
        const result = await withTimeout(
          client.callTool({
            name: 'verify_certificate',
            arguments: { certificate_id: 'MESA-DD6-660J' },
          }),
          'MCP verify_certificate issued',
        );
        const text = textOf(result);

        assert.equal(result.isError, false);
        assert.match(text, /is issued \(live check\)/);
        assert.match(text, /smoke-agent\.agent/);
      });
    },
  );
});

test('MCP verify_certificate: default live check reports not_found as an error result', async () => {
  await withLookupServer(
    (id) => ({
      status: 200,
      body: {
        certificate_id: id,
        status: 'not_found',
        valid_format: true,
        issued: false,
        agent_name: null,
        certificate_url: null,
      },
    }),
    async (baseUrl) => {
      await withMcpClient({ DMV_BASE_URL: baseUrl }, async (client) => {
        const result = await withTimeout(
          client.callTool({
            name: 'verify_certificate',
            arguments: { certificate_id: 'MESA-DD6-660J' },
          }),
          'MCP verify_certificate not_found',
        );
        const text = textOf(result);

        assert.equal(result.isError, true);
        assert.match(text, /not registered in the DMV database \(live check\)/);
      });
    },
  );
});

test('MCP verify_certificate: a Worker 429 is reported as rate limited, not malformed', async () => {
  await withLookupServer(
    () => ({
      // Exact Worker rate-limit envelope — worker/certificate-lookup.ts:248-253/265-270.
      // Deliberately has no `status` field.
      status: 429,
      body: { error: 'rate_limited', retry_after_seconds: 42 },
    }),
    async (baseUrl) => {
      await withMcpClient({ DMV_BASE_URL: baseUrl }, async (client) => {
        const result = await withTimeout(
          client.callTool({
            name: 'verify_certificate',
            arguments: { certificate_id: 'MESA-DD6-660J' },
          }),
          'MCP verify_certificate rate limited',
        );
        const text = textOf(result);

        // Rate limited is inconclusive, not a tool error.
        assert.equal(result.isError, false);
        assert.match(text, /rate limited/);
        assert.match(text, /Retry after 42s/);
        assert.doesNotMatch(text, /malformed/);
        assert.doesNotMatch(text, /not issued/);
      });
    },
  );
});

test('MCP verify_certificate: network failure falls back to format-only and labels it', async () => {
  await withMcpClient(
    { DMV_BASE_URL: 'http://127.0.0.1:9' },
    async (client) => {
      const result = await withTimeout(
        client.callTool({
          name: 'verify_certificate',
          arguments: { certificate_id: 'MESA-DD6-660J' },
        }),
        'MCP verify_certificate fallback',
      );
      const text = textOf(result);

      // Fallback to an offline-valid check digit is not itself an MCP tool error —
      // it's an inconclusive live result, clearly labeled, not a false "not issued".
      assert.equal(result.isError, false);
      assert.match(text, /has a valid check digit/);
      assert.match(text, /format-only — live issuance check unavailable/);
      assert.match(text, /Live check could not run/);
    },
  );
});
