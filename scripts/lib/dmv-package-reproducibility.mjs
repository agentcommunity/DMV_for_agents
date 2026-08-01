import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const REPOSITORY_URL = 'git+https://github.com/agentcommunity/DMV_for_agents.git';
const HOMEPAGE = 'https://dmv.agentcommunity.org';
const BUGS_URL = 'https://github.com/agentcommunity/DMV_for_agents/issues';
const NODE_ENGINE = '>=22';

export function assertArtifactEntries(entries, expectedPaths, packageName) {
  const actualPaths = entries.map((entry) => normalizeArtifactPath(entry.path));
  const seen = new Set();
  for (const artifactPath of actualPaths) {
    if (seen.has(artifactPath)) {
      throw new Error(`${packageName} contains duplicate artifact entry ${artifactPath}`);
    }
    seen.add(artifactPath);
  }

  const expected = new Set(expectedPaths.map(normalizeArtifactPath));
  const missing = [...expected].filter((artifactPath) => !seen.has(artifactPath));
  const unexpected = actualPaths.filter((artifactPath) => !expected.has(artifactPath));
  if (missing.length > 0) {
    throw new Error(`${packageName} is missing required artifact entries: ${missing.join(', ')}`);
  }
  if (unexpected.length > 0) {
    throw new Error(`${packageName} contains unexpected artifact entries: ${unexpected.join(', ')}`);
  }
}

export function assertNoSensitiveArtifact(artifactPath, content) {
  const sensitivePatterns = [
    /(?:^|\n)\s*\/\/registry\.npmjs\.org\/:_authToken\s*=\s*\S+/i,
    /\b(?:DMV_PROXY_SECRET|SUPABASE_SERVICE_ROLE_KEY|TURNSTILE_SECRET_KEY)\s*[=:]\s*["']?\S+/i,
    /\b(?:npm_[A-Za-z0-9]{16,}|gh[pousr]_[A-Za-z0-9]{16,})\b/,
  ];
  if (sensitivePatterns.some((pattern) => pattern.test(content))) {
    throw new Error(`Sensitive content detected in ${artifactPath}`);
  }
}

export function assertSourceContracts(canonical, alias, { expectedGitHead } = {}) {
  assert.equal(canonical.name, '@agentcommunity/dmv-agent', 'canonical source package name');
  assertCommonRegistryMetadata(canonical, 'packages/dmv-agent');
  assert.equal(canonical.main, 'dist/index.js', 'canonical source main');
  assert.equal(canonical.types, 'dist/index.d.ts', 'canonical source types');
  assert.deepEqual(canonical.bin, { 'dmv-agent': 'dist/cli.js' }, 'canonical source binary');
  assert.deepEqual(
    canonical.files,
    ['dist/', 'skills/', 'README.md', 'CHANGELOG.md', 'LICENSE'],
    'canonical files allow-list',
  );

  assert.equal(alias.name, 'dmv-agent', 'alias source package name');
  assert.match(alias.description ?? '', /^Compatibility alias for the canonical /);
  assertCommonRegistryMetadata(alias, 'packages/dmv-agent-alias');
  assert.deepEqual(alias.bin, { 'dmv-agent': 'bin/dmv-agent.js' }, 'alias source binary');
  assert.deepEqual(alias.files, ['bin/', 'README.md', 'LICENSE'], 'alias files allow-list');
  const expectedRange = `^${canonical.version}`;
  if (
    Object.keys(alias.dependencies ?? {}).length !== 1
    || alias.dependencies?.['@agentcommunity/dmv-agent'] !== expectedRange
  ) {
    throw new Error(`Alias compatibility dependency must be exactly @agentcommunity/dmv-agent@${expectedRange}`);
  }
  if (expectedGitHead !== undefined) {
    assert.equal(canonical.gitHead, expectedGitHead, 'canonical source gitHead');
    assert.equal(alias.gitHead, expectedGitHead, 'alias source gitHead');
  }
}

export function assertCanonicalRegistryContract(metadata, {
  expectedVersion,
  expectedGitHead,
  requireProvenance,
}) {
  assert.equal(metadata.name, '@agentcommunity/dmv-agent', 'canonical registry package name');
  assert.equal(metadata.version, expectedVersion, 'canonical registry package version');
  assertCommonRegistryMetadata(metadata, 'packages/dmv-agent');
  assert.equal(metadata.main, 'dist/index.js', 'canonical main');
  assert.equal(metadata.types, 'dist/index.d.ts', 'canonical types');
  assert.deepEqual(metadata.bin, { 'dmv-agent': 'dist/cli.js' }, 'canonical binary');
  assertRegistryReleaseEvidence(metadata, { expectedGitHead, requireProvenance });
}

export function assertAliasRegistryContract(metadata, {
  expectedVersion,
  expectedCanonicalRange,
  expectedGitHead,
  requireProvenance,
}) {
  assert.equal(metadata.name, 'dmv-agent', 'alias registry package name');
  assert.equal(metadata.version, expectedVersion, 'alias registry package version');
  assertCommonRegistryMetadata(metadata, 'packages/dmv-agent-alias');
  assert.deepEqual(metadata.bin, { 'dmv-agent': 'bin/dmv-agent.js' }, 'alias binary');
  if (metadata.dependencies?.['@agentcommunity/dmv-agent'] !== expectedCanonicalRange) {
    throw new Error(`Alias canonical dependency must be exactly ${expectedCanonicalRange}`);
  }
  assertRegistryReleaseEvidence(metadata, { expectedGitHead, requireProvenance });
}

export async function fetchJsonWithDeadline(url, {
  timeoutMs = 8_000,
  fetchFn = fetch,
  maxBytes = 2_000_000,
} = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  timeout.unref?.();
  try {
    const response = await fetchFn(url, {
      headers: { accept: 'application/json' },
      redirect: 'error',
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Registry request failed with HTTP ${response.status}`);
    }
    const declaredLength = Number(response.headers.get('content-length') ?? '0');
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      throw new Error(`Registry response exceeds ${maxBytes} bytes`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > maxBytes) {
      throw new Error(`Registry response exceeds ${maxBytes} bytes`);
    }
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Registry request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function sha512Integrity(content) {
  return `sha512-${createHash('sha512').update(content).digest('base64')}`;
}

export function assertIssuedCliOutput(output, certificateId) {
  const escapedCertificateId = certificateId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const issuedPattern = new RegExp(
    `Certificate\\s+${escapedCertificateId}\\s+is issued\\s+\\(live check\\)`,
    'i',
  );
  if (!issuedPattern.test(output)) {
    throw new Error(`Expected an issued live-check result for ${certificateId}`);
  }
}

export function assertProvenanceBundle(response, { packageName, version, integrity }) {
  const provenance = response?.attestations?.find(
    (attestation) => attestation.predicateType === 'https://slsa.dev/provenance/v1',
  );
  assert.ok(provenance, 'SLSA provenance attestation');
  const encodedPayload = provenance.bundle?.dsseEnvelope?.payload;
  assert.equal(typeof encodedPayload, 'string', 'provenance DSSE payload');
  let statement;
  try {
    statement = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'));
  } catch {
    throw new Error('Provenance DSSE payload is not valid JSON');
  }
  assert.equal(statement.predicateType, 'https://slsa.dev/provenance/v1', 'provenance predicate type');
  const packagePurl = `pkg:npm/${packageName.replace('@', '%40')}@${version}`;
  const expectedDigest = Buffer.from(integrity.replace(/^sha512-/, ''), 'base64').toString('hex');
  const subject = statement.subject?.find((candidate) => candidate.name === packagePurl);
  if (subject?.digest?.sha512 !== expectedDigest) {
    throw new Error(`Provenance subject digest does not match ${packageName}@${version}`);
  }
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  assert.deepEqual(workflow && {
    repository: workflow.repository,
    path: workflow.path,
  }, {
    repository: 'https://github.com/agentcommunity/DMV_for_agents',
    path: '.github/workflows/publish-dmv-packages.yml',
  }, 'trusted publishing workflow identity');
}

export function assertSecretlessGateResponse(status, gateName) {
  if (status !== 403) {
    throw new Error(`${gateName} secretless gate expected 403, received HTTP ${status}`);
  }
}

function normalizeArtifactPath(artifactPath) {
  return artifactPath.replace(/^package\//, '').replaceAll('\\', '/');
}

function assertCommonRegistryMetadata(metadata, directory) {
  assert.deepEqual(metadata.repository, {
    type: 'git',
    url: REPOSITORY_URL,
    directory,
  }, 'repository metadata');
  assert.equal(metadata.homepage, HOMEPAGE, 'homepage metadata');
  assert.deepEqual(metadata.bugs, { url: BUGS_URL }, 'bugs metadata');
  assert.equal(metadata.license, 'MIT', 'license metadata');
  assert.deepEqual(metadata.engines, { node: NODE_ENGINE }, 'Node engine metadata');
}

function assertRegistryReleaseEvidence(metadata, { expectedGitHead, requireProvenance }) {
  assert.match(metadata.dist?.integrity ?? '', /^sha512-[A-Za-z0-9+/=]+$/, 'registry integrity');
  if (expectedGitHead !== undefined) {
    assert.equal(metadata.gitHead, expectedGitHead, 'registry gitHead');
  }
  if (requireProvenance && !metadata.dist?.attestations?.url) {
    throw new Error('Published package is missing a provenance attestation');
  }
}
