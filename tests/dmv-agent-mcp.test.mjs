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
