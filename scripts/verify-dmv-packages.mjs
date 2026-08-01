#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  existsSync,
  copyFileSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertAliasRegistryContract,
  assertArtifactEntries,
  assertCanonicalRegistryContract,
  assertIssuedCliOutput,
  assertProvenanceBundle,
  assertSecretlessGateResponse,
  assertNoSensitiveArtifact,
  assertSourceContracts,
  fetchJsonWithDeadline,
  sha512Integrity,
} from './lib/dmv-package-reproducibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANONICAL_DIR = path.join(ROOT, 'packages/dmv-agent');
const ALIAS_DIR = path.join(ROOT, 'packages/dmv-agent-alias');
const DIST_DIR = path.join(CANONICAL_DIR, 'dist');
const ROOT_LICENSE = path.join(ROOT, 'LICENSE');
const REGISTRY_BASE = 'https://registry.npmjs.org';
const COMMAND_TIMEOUT_MS = 120_000;
const CLI_TIMEOUT_MS = 30_000;
const REGISTRY_TIMEOUT_MS = 10_000;
const REGISTRY_TARBALL_MAX_BYTES = 10_000_000;
const LIVE_ISSUED_CERTIFICATE = 'REEF-068-BD0Q';
const CURRENT_CANONICAL_VERSION = '0.2.2';
const CURRENT_ALIAS_VERSION = '0.1.2';

const sourceModules = [
  'certificate',
  'cli',
  'doctor',
  'index',
  'lookup',
  'mcp-server',
  'package-info',
  'rate-limit',
  'register',
  'text-card',
  'types',
  'ui',
  'urls',
  'validate',
];
const canonicalExpectedFiles = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'package.json',
  'skills/dmv/SKILL.md',
  ...sourceModules.flatMap((moduleName) => [
    `dist/${moduleName}.d.ts`,
    `dist/${moduleName}.js`,
    `dist/${moduleName}.js.map`,
  ]),
].sort();
const aliasExpectedFiles = ['LICENSE', 'README.md', 'bin/dmv-agent.js', 'package.json'];

const options = parseOptions(process.argv.slice(2));
const tempRoot = mkdtempSync(path.join(tmpdir(), 'dmv-package-verifier-'));
const npmEnvironment = createIsolatedNpmEnvironment(tempRoot);
let canonicalPack;
let aliasPack;

if (existsSync(DIST_DIR)) {
  throw new Error('Refusing to verify with a pre-existing packages/dmv-agent/dist; remove stale output first');
}

try {
  const canonicalManifest = readJson(path.join(CANONICAL_DIR, 'package.json'));
  const aliasManifest = readJson(path.join(ALIAS_DIR, 'package.json'));
  assertSourceContracts(canonicalManifest, aliasManifest, {
    expectedGitHead: ['canonical-release', 'release'].includes(options.registryMode)
      ? options.expectedGitHead
      : undefined,
  });
  assertLockfileAuthority();
  assertLicenseCopies();

  run('pnpm', ['--dir', CANONICAL_DIR, 'build'], { env: npmEnvironment });
  canonicalPack = verifyPack({
    directory: CANONICAL_DIR,
    expectedFiles: canonicalExpectedFiles,
    packageName: canonicalManifest.name,
    tempRoot,
    npmEnvironment,
  });
  aliasPack = verifyPack({
    directory: ALIAS_DIR,
    expectedFiles: aliasExpectedFiles,
    packageName: aliasManifest.name,
    tempRoot,
    npmEnvironment,
  });

  assertPackedSourceBytes(canonicalPack.tarball, CANONICAL_DIR, ['package.json', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  assertPackedSourceBytes(aliasPack.tarball, ALIAS_DIR, ['package.json', 'README.md', 'LICENSE']);

  const canonicalConsumer = installConsumer(
    path.join(tempRoot, 'canonical-consumer'),
    [canonicalPack.tarball],
    npmEnvironment,
  );
  const aliasConsumer = installConsumer(
    path.join(tempRoot, 'alias-consumer'),
    [canonicalPack.tarball, aliasPack.tarball],
    npmEnvironment,
  );
  runInstalledCliContracts(canonicalConsumer, aliasConsumer, npmEnvironment);
  await runInstalledMcpContract(canonicalConsumer, npmEnvironment);

  if (options.packOutput) {
    mkdirSync(options.packOutput, { recursive: true });
    copyFileSync(
      canonicalPack.tarball,
      path.join(options.packOutput, path.basename(canonicalPack.tarball)),
      fsConstants.COPYFILE_EXCL,
    );
    copyFileSync(
      aliasPack.tarball,
      path.join(options.packOutput, path.basename(aliasPack.tarball)),
      fsConstants.COPYFILE_EXCL,
    );
  }

  if (options.registryMode !== 'none') {
    await verifyRegistry({
      mode: options.registryMode,
      canonicalManifest,
      aliasManifest,
      canonicalIntegrity: canonicalPack.integrity,
      aliasIntegrity: aliasPack.integrity,
      expectedGitHead: options.expectedGitHead,
    });
  }
  if (!options.skipProduction) {
    await runProductionContracts(canonicalConsumer, npmEnvironment);
  }

  console.log(`DMV package reproducibility verification passed (${options.registryMode})`);
} finally {
  rmSync(DIST_DIR, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
}

function parseOptions(args) {
  let registryMode = 'current';
  let skipProduction = false;
  let expectedGitHead;
  let packOutput;
  for (const arg of args) {
    if (arg === '--') {
      continue;
    } else if (arg.startsWith('--registry-mode=')) {
      registryMode = arg.slice('--registry-mode='.length);
    } else if (arg === '--skip-production') {
      skipProduction = true;
    } else if (arg.startsWith('--expected-git-head=')) {
      expectedGitHead = arg.slice('--expected-git-head='.length);
    } else if (arg.startsWith('--pack-output=')) {
      packOutput = path.resolve(arg.slice('--pack-output='.length));
    } else {
      throw new Error(`Unknown verifier option: ${arg}`);
    }
  }
  if (!['none', 'current', 'canonical-release', 'release'].includes(registryMode)) {
    throw new Error(`Unsupported registry mode: ${registryMode}`);
  }
  if (['canonical-release', 'release'].includes(registryMode) && !expectedGitHead) {
    const result = run('git', ['rev-parse', 'HEAD']);
    expectedGitHead = result.stdout.trim();
  }
  return { registryMode, skipProduction, expectedGitHead, packOutput };
}

function assertLockfileAuthority() {
  assert.equal(existsSync(path.join(CANONICAL_DIR, 'package-lock.json')), false, 'package npm lock must not exist');
  assert.equal(existsSync(path.join(CANONICAL_DIR, 'pnpm-lock.yaml')), false, 'package pnpm lock must not exist');
  const rootLock = readFileSync(path.join(ROOT, 'pnpm-lock.yaml'), 'utf8');
  assert.match(rootLock, /^  packages\/dmv-agent:\n/m, 'root pnpm lock owns canonical importer');
  assert.match(rootLock, /^  packages\/dmv-agent-alias:\n/m, 'root pnpm lock owns alias importer');
  assert.match(rootLock, /specifier: \^0\.3\.0\n\s+version: link:\.\.\/dmv-agent/, 'alias resolves to workspace canonical');
}

function assertLicenseCopies() {
  const rootLicense = readFileSync(ROOT_LICENSE);
  assert.deepEqual(readFileSync(path.join(CANONICAL_DIR, 'LICENSE')), rootLicense, 'canonical license bytes');
  assert.deepEqual(readFileSync(path.join(ALIAS_DIR, 'LICENSE')), rootLicense, 'alias license bytes');
}

function verifyPack({ directory, expectedFiles, packageName, tempRoot, npmEnvironment }) {
  const dryRun = runJson('npm', ['pack', '--dry-run', '--json'], { cwd: directory, env: npmEnvironment });
  assert.equal(dryRun.length, 1, `${packageName} dry-run result count`);
  assertArtifactEntries(dryRun[0].files, expectedFiles, `${packageName} dry run`);

  const destination = path.join(tempRoot, packageName.replaceAll('/', '-').replace('@', ''));
  mkdirSync(destination, { recursive: true });
  const packed = runJson('npm', ['pack', '--json', '--pack-destination', destination], {
    cwd: directory,
    env: npmEnvironment,
  });
  assert.equal(packed.length, 1, `${packageName} pack result count`);
  assertArtifactEntries(packed[0].files, expectedFiles, `${packageName} actual pack`);
  assert.deepEqual(
    packed[0].files.map((file) => file.path).sort(),
    dryRun[0].files.map((file) => file.path).sort(),
    `${packageName} dry run and actual pack must match`,
  );

  const tarball = path.join(destination, packed[0].filename);
  assert.equal(sha512Integrity(readFileSync(tarball)), packed[0].integrity, `${packageName} local integrity`);
  const archiveEntries = run('tar', ['-tzf', tarball]).stdout
    .trim()
    .split('\n')
    .filter((entry) => entry && !entry.endsWith('/'))
    .map((entry) => ({ path: entry }));
  assertArtifactEntries(archiveEntries, expectedFiles, `${packageName} tar archive`);

  for (const entry of expectedFiles) {
    const content = readTarEntry(tarball, entry);
    assertNoSensitiveArtifact(entry, content.toString('utf8'));
  }
  return { tarball, integrity: packed[0].integrity };
}

function assertPackedSourceBytes(tarball, sourceDirectory, filenames) {
  for (const filename of filenames) {
    assert.deepEqual(
      readTarEntry(tarball, filename),
      readFileSync(path.join(sourceDirectory, filename)),
      `${filename} packed bytes`,
    );
  }
}

function installConsumer(directory, tarballs, npmEnvironment) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }, null, 2));
  run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballs], {
    cwd: directory,
    env: npmEnvironment,
  });
  return directory;
}

function runInstalledCliContracts(canonicalConsumer, aliasConsumer, npmEnvironment) {
  const canonicalBin = installedBin(canonicalConsumer);
  const aliasBin = installedBin(aliasConsumer);
  for (const executable of [canonicalBin, aliasBin]) {
    const result = run(executable, ['verify', 'MESA-DD6-660J', '--format-only'], {
      cwd: path.dirname(executable),
      env: { ...npmEnvironment, NO_COLOR: '1' },
      timeoutMs: CLI_TIMEOUT_MS,
    });
    assert.match(result.stderr, /valid check digit/);
    assert.match(result.stderr, /format-only check/);
  }
  const aliasTarget = readFileSync(path.join(
    aliasConsumer,
    'node_modules/dmv-agent/bin/dmv-agent.js',
  ), 'utf8');
  assert.match(aliasTarget, /@agentcommunity\/dmv-agent\/dist\/cli\.js/);
}

async function runInstalledMcpContract(consumer, npmEnvironment) {
  await withReadOnlyDoctorServer(async (baseUrl) => {
    const requireFromConsumer = createRequire(path.join(consumer, 'package.json'));
    const { Client } = await import(pathToFileURL(
      requireFromConsumer.resolve('@modelcontextprotocol/sdk/client/index.js'),
    ).href);
    const { StdioClientTransport } = await import(pathToFileURL(
      requireFromConsumer.resolve('@modelcontextprotocol/sdk/client/stdio.js'),
    ).href);
    const client = new Client({ name: 'dmv-package-verifier', version: '1.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [path.join(consumer, 'node_modules/@agentcommunity/dmv-agent/dist/mcp-server.js')],
      cwd: consumer,
      stderr: 'pipe',
      env: { ...npmEnvironment, NO_COLOR: '1', DMV_BASE_URL: baseUrl },
    });
    try {
      await withPromiseTimeout(client.connect(transport), 'installed MCP connect');
      const tools = await withPromiseTimeout(client.listTools(), 'installed MCP tools/list');
      assert.deepEqual(
        tools.tools.map((tool) => tool.name).sort(),
        ['dmv_doctor', 'register_agent', 'verify_certificate'],
      );
      const result = await withPromiseTimeout(client.callTool({
        name: 'verify_certificate',
        arguments: { certificate_id: 'MESA-DD6-660J', format_only: true },
      }), 'installed MCP offline verify');
      assert.equal(result.isError, false);
      assert.match(result.content.map((item) => item.text ?? '').join('\n'), /format-only check/);
      const doctor = await withPromiseTimeout(
        client.callTool({ name: 'dmv_doctor', arguments: {} }),
        'installed MCP doctor',
      );
      assert.equal(doctor.isError, false);
      assert.match(doctor.content.map((item) => item.text ?? '').join('\n'), /DMV doctor: OK/);
    } finally {
      await client.close();
    }
  });
}

async function verifyRegistry({
  mode,
  canonicalManifest,
  aliasManifest,
  canonicalIntegrity,
  aliasIntegrity,
  expectedGitHead,
}) {
  const canonicalVersion = mode === 'current' ? CURRENT_CANONICAL_VERSION : canonicalManifest.version;
  const aliasVersion = mode === 'release' ? aliasManifest.version : CURRENT_ALIAS_VERSION;
  const [canonical, alias] = await Promise.all([
    registryMetadata('@agentcommunity/dmv-agent', canonicalVersion),
    registryMetadata('dmv-agent', aliasVersion),
  ]);

  if (mode === 'current') {
    assertCurrentCanonical(canonical);
    assertCurrentAlias(alias);
  } else {
    assertCanonicalRegistryContract(canonical, {
      expectedVersion: canonicalManifest.version,
      expectedGitHead,
      requireProvenance: true,
    });
    assert.equal(canonical.dist.integrity, canonicalIntegrity, 'published canonical matches verified pack');
    await verifyAttestation(canonical);
    if (mode === 'canonical-release') {
      assertCurrentAlias(alias);
    } else {
      assertAliasRegistryContract(alias, {
        expectedVersion: aliasManifest.version,
        expectedCanonicalRange: `^${canonicalManifest.version}`,
        expectedGitHead,
        requireProvenance: true,
      });
      assert.equal(alias.dist.integrity, aliasIntegrity, 'published alias matches verified pack');
      await verifyAttestation(alias);
    }
  }

  await Promise.all([verifyRegistryTarball(canonical), verifyRegistryTarball(alias)]);
}

function assertCurrentCanonical(metadata) {
  assert.equal(metadata.name, '@agentcommunity/dmv-agent');
  assert.equal(metadata.version, CURRENT_CANONICAL_VERSION);
  assert.equal(metadata.repository?.directory, 'packages/dmv-agent');
  assert.equal(metadata.homepage, 'https://dmv.agentcommunity.org');
  assert.equal(metadata.license, 'MIT');
  assert.equal(metadata.types?.replace(/^\.\//, ''), 'dist/index.d.ts');
  assert.equal(metadata.engines, undefined, '0.2.2 truthfully has no engines declaration');
  assert.equal(metadata.dist?.attestations, undefined, '0.2.2 truthfully has no provenance attestation');
  assert.match(metadata.dist?.integrity ?? '', /^sha512-/);
}

function assertCurrentAlias(metadata) {
  assert.equal(metadata.name, 'dmv-agent');
  assert.equal(metadata.version, CURRENT_ALIAS_VERSION);
  assert.equal(metadata.repository?.directory, 'packages/dmv-agent-alias');
  assert.deepEqual(metadata.dependencies, { '@agentcommunity/dmv-agent': '^0.2.1' });
  assert.equal(metadata.engines, undefined, '0.1.2 truthfully has no engines declaration');
  assert.equal(metadata.dist?.attestations, undefined, '0.1.2 truthfully has no provenance attestation');
  assert.match(metadata.dist?.integrity ?? '', /^sha512-/);
}

async function registryMetadata(packageName, version) {
  return fetchJsonWithDeadline(
    `${REGISTRY_BASE}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
    { timeoutMs: REGISTRY_TIMEOUT_MS },
  );
}

async function verifyRegistryTarball(metadata) {
  const content = await fetchBufferWithDeadline(metadata.dist.tarball, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    maxBytes: REGISTRY_TARBALL_MAX_BYTES,
  });
  assert.equal(sha512Integrity(content), metadata.dist.integrity, `${metadata.name} registry tarball integrity`);
}

async function verifyAttestation(metadata) {
  const attestation = await fetchJsonWithDeadline(metadata.dist.attestations.url, {
    timeoutMs: REGISTRY_TIMEOUT_MS,
    maxBytes: 5_000_000,
  });
  assertProvenanceBundle(attestation, {
    packageName: metadata.name,
    version: metadata.version,
    integrity: metadata.dist.integrity,
  });
}

async function runProductionContracts(consumer, npmEnvironment) {
  const executable = installedBin(consumer);
  const doctor = run(executable, ['doctor', '--json'], {
    cwd: consumer,
    env: { ...npmEnvironment, NO_COLOR: '1' },
    timeoutMs: CLI_TIMEOUT_MS,
  });
  const doctorResult = JSON.parse(doctor.stdout);
  assert.equal(doctorResult.ok, true, 'production doctor');
  assert.deepEqual(
    doctorResult.checks.map((check) => check.label).sort(),
    ['badge svg', 'card png', 'healthz', 'register validation'],
  );
  const lookup = run(executable, ['verify', LIVE_ISSUED_CERTIFICATE], {
    cwd: consumer,
    env: { ...npmEnvironment, NO_COLOR: '1' },
    timeoutMs: CLI_TIMEOUT_MS,
  });
  assertIssuedCliOutput(lookup.stderr, LIVE_ISSUED_CERTIFICATE);
  await Promise.all([
    verifySecretlessGate(
      'registration',
      'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/register-agent',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
    ),
    verifySecretlessGate(
      'lookup',
      'https://tcymqfwwphacnosnnzxl.supabase.co/functions/v1/lookup-agent?id=REEF-068-BD0Q',
      { method: 'GET' },
    ),
  ]);
}

async function verifySecretlessGate(gateName, url, init) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REGISTRY_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { ...init, redirect: 'error', signal: controller.signal });
    assertSecretlessGateResponse(response.status, gateName);
    await response.body?.cancel();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`${gateName} secretless gate timed out after ${REGISTRY_TIMEOUT_MS}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBufferWithDeadline(url, { timeoutMs, maxBytes }) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetch(url, { redirect: 'error', signal: controller.signal });
    if (!response.ok) throw new Error(`Artifact request failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > maxBytes) throw new Error(`Artifact response exceeds ${maxBytes} bytes`);
    const content = Buffer.from(await response.arrayBuffer());
    if (content.byteLength > maxBytes) throw new Error(`Artifact response exceeds ${maxBytes} bytes`);
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Artifact request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function withReadOnlyDoctorServer(handler) {
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (request.method === 'GET' && url.pathname === '/healthz') {
      return respond(response, 200, 'application/json', JSON.stringify({ worker: 'ok', container: { status: 'ok' } }));
    }
    if (request.method === 'GET' && url.pathname === '/api/card') {
      return respond(response, 200, 'image/png', 'pngbytes', { 'Content-Length': '8' });
    }
    if (request.method === 'GET' && url.pathname === '/badge') {
      return respond(response, 200, 'image/svg+xml', '<svg></svg>');
    }
    if (request.method === 'POST' && url.pathname === '/api/register') {
      return respond(response, 400, 'application/json', JSON.stringify({ error: 'agent_name is required' }));
    }
    return respond(response, 404, 'application/json', JSON.stringify({ error: 'not found' }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await handler(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
}

function respond(response, status, contentType, body, extraHeaders = {}) {
  response.writeHead(status, { 'Content-Type': contentType, ...extraHeaders });
  response.end(body);
}

function withPromiseTimeout(promise, label) {
  let timeout;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error(`${label} timed out after ${CLI_TIMEOUT_MS}ms`)), CLI_TIMEOUT_MS);
      timeout.unref?.();
    }),
  ]).finally(() => clearTimeout(timeout));
}

function readTarEntry(tarball, entry) {
  const result = spawnSync('tar', ['-xOf', tarball, `package/${entry}`], {
    encoding: null,
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(`Unable to read ${entry} from ${path.basename(tarball)}`);
  }
  return result.stdout;
}

function installedBin(consumer) {
  return path.join(consumer, 'node_modules/.bin', process.platform === 'win32' ? 'dmv-agent.cmd' : 'dmv-agent');
}

function readJson(filename) {
  return JSON.parse(readFileSync(filename, 'utf8'));
}

function runJson(command, args, options) {
  const result = run(command, args, options);
  return JSON.parse(result.stdout);
}

function run(command, args, options = {}) {
  const { timeoutMs = COMMAND_TIMEOUT_MS, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...spawnOptions,
    timeout: timeoutMs,
  });
  if (result.error || result.status !== 0) {
    const reason = result.error?.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs}ms`
      : result.error?.message ?? `status ${result.status}`;
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      reason,
      'stdout:',
      result.stdout ?? '',
      'stderr:',
      result.stderr ?? '',
    ].join('\n'));
  }
  return result;
}

function createIsolatedNpmEnvironment(directory) {
  const npmHome = path.join(directory, 'npm-home');
  mkdirSync(npmHome, { recursive: true });
  const userConfig = path.join(npmHome, '.npmrc');
  writeFileSync(userConfig, 'audit=false\nfund=false\n');
  const environment = { ...process.env, HOME: npmHome, USERPROFILE: npmHome, npm_config_userconfig: userConfig };
  for (const key of Object.keys(environment)) {
    if (/^(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_CONFIG__AUTH|npm_config__auth)$/i.test(key)) {
      delete environment[key];
    }
  }
  return environment;
}
