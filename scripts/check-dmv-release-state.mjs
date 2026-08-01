#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assertAliasRegistryContract,
  assertCanonicalRegistryContract,
  assertProvenanceBundle,
  assertSourceContracts,
  classifyReleasePackageState,
  classifyReleaseSequence,
  createVerifierChildEnvironment,
  fetchJsonWithDeadline,
  sha512Integrity,
} from './lib/dmv-package-reproducibility.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_BASE = 'https://registry.npmjs.org';
const REQUEST_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 120_000;
const MAX_TARBALL_BYTES = 10_000_000;
const PACKAGE_DEFINITIONS = {
  canonical: {
    name: '@agentcommunity/dmv-agent',
    filename: 'agentcommunity-dmv-agent-0.3.0.tgz',
  },
  alias: {
    name: 'dmv-agent',
    filename: 'dmv-agent-0.1.3.tgz',
  },
};

const options = parseOptions(process.argv.slice(2));
const canonicalTarball = path.join(options.artifactDirectory, PACKAGE_DEFINITIONS.canonical.filename);
const aliasTarball = path.join(options.artifactDirectory, PACKAGE_DEFINITIONS.alias.filename);
const canonicalManifest = readPackedManifest(canonicalTarball);
const aliasManifest = readPackedManifest(aliasTarball);
assertSourceContracts(canonicalManifest, aliasManifest, { expectedGitHead: options.expectedGitHead });

const definition = PACKAGE_DEFINITIONS[options.packageKind];
const manifest = options.packageKind === 'canonical' ? canonicalManifest : aliasManifest;
const tarball = options.packageKind === 'canonical' ? canonicalTarball : aliasTarball;
const localIntegrity = sha512Integrity(readFileSync(tarball));
const metadata = await registryMetadataOrNull(definition.name, manifest.version);
const state = classifyReleasePackageState(metadata, {
  packageName: definition.name,
  expectedIntegrity: localIntegrity,
});

if (options.packageKind === 'canonical') {
  const aliasMetadata = await registryMetadataOrNull(PACKAGE_DEFINITIONS.alias.name, aliasManifest.version);
  const aliasState = classifyReleasePackageState(aliasMetadata, {
    packageName: PACKAGE_DEFINITIONS.alias.name,
    expectedIntegrity: sha512Integrity(readFileSync(aliasTarball)),
  });
  classifyReleaseSequence(state, aliasState);
}

if (options.requiredState === 'exact' && state !== 'exact') {
  throw new Error(`${definition.name}@${manifest.version} is absent; exact release proof required`);
}

if (state === 'exact') {
  await proveExactRelease({
    packageKind: options.packageKind,
    metadata,
    manifest,
    localIntegrity,
    expectedGitHead: options.expectedGitHead,
    canonicalVersion: canonicalManifest.version,
  });
}

if (options.stateOutput) {
  writeFileSync(options.stateOutput, `state=${state}\n`, { flag: 'a' });
}
console.log(`${definition.name}@${manifest.version} release state: ${state}`);

function parseOptions(args) {
  let packageKind;
  let artifactDirectory;
  let expectedGitHead;
  let stateOutput;
  let requiredState;
  for (const arg of args) {
    if (arg.startsWith('--package=')) packageKind = arg.slice('--package='.length);
    else if (arg.startsWith('--artifact-dir=')) artifactDirectory = path.resolve(arg.slice('--artifact-dir='.length));
    else if (arg.startsWith('--expected-git-head=')) expectedGitHead = arg.slice('--expected-git-head='.length);
    else if (arg.startsWith('--state-output=')) stateOutput = path.resolve(arg.slice('--state-output='.length));
    else if (arg.startsWith('--require=')) requiredState = arg.slice('--require='.length);
    else throw new Error(`Unknown release-state option: ${arg}`);
  }
  if (!Object.hasOwn(PACKAGE_DEFINITIONS, packageKind)) {
    throw new Error('Provide --package=canonical or --package=alias');
  }
  if (!artifactDirectory) throw new Error('Provide --artifact-dir=PATH');
  if (!expectedGitHead || !/^[a-f0-9]{40}$/i.test(expectedGitHead)) {
    throw new Error('Provide --expected-git-head with the exact 40-character release commit');
  }
  if (requiredState !== undefined && requiredState !== 'exact') {
    throw new Error('Only --require=exact is supported');
  }
  return { packageKind, artifactDirectory, expectedGitHead, stateOutput, requiredState };
}

async function proveExactRelease({
  packageKind,
  metadata,
  manifest,
  localIntegrity,
  expectedGitHead,
  canonicalVersion,
}) {
  if (packageKind === 'canonical') {
    assertCanonicalRegistryContract(metadata, {
      expectedVersion: manifest.version,
      expectedGitHead,
      requireProvenance: true,
    });
  } else {
    assertAliasRegistryContract(metadata, {
      expectedVersion: manifest.version,
      expectedCanonicalRange: `^${canonicalVersion}`,
      expectedGitHead,
      requireProvenance: true,
    });
  }
  assert.equal(metadata.dist.integrity, localIntegrity, 'published SRI matches the exact verified artifact');
  const publishedTarball = await fetchBufferWithDeadline(metadata.dist.tarball);
  assert.equal(
    sha512Integrity(publishedTarball),
    localIntegrity,
    'downloaded registry tarball matches the exact verified artifact',
  );
  const attestation = await fetchJsonWithDeadline(metadata.dist.attestations.url, {
    timeoutMs: REQUEST_TIMEOUT_MS,
    maxBytes: 5_000_000,
  });
  assertProvenanceBundle(attestation, {
    packageName: metadata.name,
    version: metadata.version,
    integrity: metadata.dist.integrity,
    expectedGitHead,
  });
  verifySignaturesAndTransparency(metadata.name, metadata.version);
}

async function registryMetadataOrNull(packageName, version) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(
      `${REGISTRY_BASE}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`,
      { headers: { accept: 'application/json' }, redirect: 'manual', signal: controller.signal },
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error(`Ambiguous registry response HTTP ${response.status}; version bump required`);
    }
    const body = await response.text();
    if (Buffer.byteLength(body) > 2_000_000) throw new Error('Registry metadata exceeds 2000000 bytes');
    return JSON.parse(body);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error('Ambiguous registry timeout; version bump required');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBufferWithDeadline(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
    if (response.status !== 200) throw new Error(`Registry tarball request failed with HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (declaredLength > MAX_TARBALL_BYTES) throw new Error('Registry tarball is too large');
    const body = Buffer.from(await response.arrayBuffer());
    if (body.byteLength > MAX_TARBALL_BYTES) throw new Error('Registry tarball is too large');
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

function verifySignaturesAndTransparency(packageName, version) {
  const tempRoot = mkdtempSync(path.join(tmpdir(), 'dmv-npm-signature-proof-'));
  try {
    const npmHome = path.join(tempRoot, 'npm-home');
    mkdirSync(npmHome, { recursive: true });
    writeFileSync(path.join(npmHome, '.npmrc'), 'audit=false\nfund=false\n');
    const consumer = path.join(tempRoot, 'consumer');
    mkdirSync(consumer);
    writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true }, null, 2));
    const environment = createVerifierChildEnvironment(npmHome);
    run('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--save-exact',
      `${packageName}@${version}`,
    ], { cwd: consumer, env: environment });
    const audit = run('npm', ['audit', 'signatures'], { cwd: consumer, env: environment });
    if (!/verified attestations?|has verified attestations?/i.test(`${audit.stdout}\n${audit.stderr}`)) {
      throw new Error(`${packageName}@${version} lacks cryptographically verified provenance attestations`);
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

function readPackedManifest(tarball) {
  const result = spawnSync('tar', ['-xOf', tarball, 'package/package.json'], {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`Unable to read package.json from ${path.basename(tarball)}`);
  }
  return JSON.parse(result.stdout);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    ...options,
  });
  if (result.error || result.status !== 0) {
    throw new Error([
      `Command failed: ${command} ${args.join(' ')}`,
      result.error?.message ?? `status ${result.status}`,
      result.stdout ?? '',
      result.stderr ?? '',
    ].join('\n'));
  }
  return result;
}
