import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  assertAliasRegistryContract,
  assertArtifactEntries,
  assertCanonicalRegistryContract,
  assertNoSensitiveArtifact,
  assertIssuedCliOutput,
  assertProvenanceBundle,
  assertSourceContracts,
  assertSecretlessGateResponse,
  fetchJsonWithDeadline,
  sha512Integrity,
} from '../scripts/lib/dmv-package-reproducibility.mjs';

const canonicalExpected = [
  'LICENSE',
  'README.md',
  'package.json',
];

test('artifact validation accepts one exact copy of every allow-listed file', () => {
  assert.doesNotThrow(() => assertArtifactEntries(
    canonicalExpected.map((path) => ({ path })),
    canonicalExpected,
    '@agentcommunity/dmv-agent',
  ));
});

test('artifact validation rejects a missing required file', () => {
  assert.throws(
    () => assertArtifactEntries(
      [{ path: 'README.md' }, { path: 'package.json' }],
      canonicalExpected,
      '@agentcommunity/dmv-agent',
    ),
    /missing.*LICENSE/i,
  );
});

test('artifact validation rejects duplicate archive entries', () => {
  assert.throws(
    () => assertArtifactEntries(
      [
        ...canonicalExpected.map((path) => ({ path })),
        { path: 'README.md' },
      ],
      canonicalExpected,
      '@agentcommunity/dmv-agent',
    ),
    /duplicate.*README\.md/i,
  );
});

test('artifact validation rejects mixed source and generated files', () => {
  assert.throws(
    () => assertArtifactEntries(
      [
        ...canonicalExpected.map((path) => ({ path })),
        { path: 'src/cli.ts' },
        { path: 'dist/cli.js' },
      ],
      canonicalExpected,
      '@agentcommunity/dmv-agent',
    ),
    /unexpected.*src\/cli\.ts/i,
  );
});

test('artifact validation rejects secret-bearing content without echoing the secret', () => {
  const secret = 'npm_super_secret_value';
  assert.throws(
    () => assertNoSensitiveArtifact('dist/config.js', `//registry.npmjs.org/:_authToken=${secret}`),
    (error) => {
      assert.match(error.message, /sensitive content/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      return true;
    },
  );
});

test('canonical release registry validation requires attestations, not npm signatures', () => {
  const metadata = {
    name: '@agentcommunity/dmv-agent',
    version: '0.3.0',
    gitHead: 'a'.repeat(40),
    repository: {
      type: 'git',
      url: 'git+https://github.com/agentcommunity/DMV_for_agents.git',
      directory: 'packages/dmv-agent',
    },
    homepage: 'https://dmv.agentcommunity.org',
    bugs: { url: 'https://github.com/agentcommunity/DMV_for_agents/issues' },
    license: 'MIT',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    bin: { 'dmv-agent': 'dist/cli.js' },
    engines: { node: '>=22' },
    dist: {
      integrity: 'sha512-example',
      signatures: [{ keyid: 'registry-key', sig: 'registry-signature' }],
    },
  };

  assert.throws(
    () => assertCanonicalRegistryContract(metadata, {
      expectedVersion: '0.3.0',
      expectedGitHead: 'a'.repeat(40),
      requireProvenance: true,
    }),
    /provenance attestation/i,
  );
});

test('alias registry validation requires an exact compatibility dependency', () => {
  assert.throws(
    () => assertAliasRegistryContract({
      name: 'dmv-agent',
      version: '0.1.3',
      dependencies: { '@agentcommunity/dmv-agent': '^0.2.2' },
      repository: {
        type: 'git',
        url: 'git+https://github.com/agentcommunity/DMV_for_agents.git',
        directory: 'packages/dmv-agent-alias',
      },
      homepage: 'https://dmv.agentcommunity.org',
      bugs: { url: 'https://github.com/agentcommunity/DMV_for_agents/issues' },
      license: 'MIT',
      engines: { node: '>=22' },
      bin: { 'dmv-agent': 'bin/dmv-agent.js' },
      dist: { integrity: 'sha512-example', attestations: { url: 'https://example.test' } },
      gitHead: 'b'.repeat(40),
    }, {
      expectedVersion: '0.1.3',
      expectedCanonicalRange: '^0.3.0',
      expectedGitHead: 'b'.repeat(40),
      requireProvenance: true,
    }),
    /canonical dependency/i,
  );
});

test('registry requests abort at the caller deadline', async () => {
  const server = http.createServer(() => {});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    await assert.rejects(
      () => fetchJsonWithDeadline(`http://127.0.0.1:${address.port}/stalled`, { timeoutMs: 25 }),
      /timed out after 25ms/i,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

test('source manifests define one scoped capability and one exact compatibility alias', () => {
  const canonical = {
    name: '@agentcommunity/dmv-agent',
    version: '0.3.0',
    repository: {
      type: 'git',
      url: 'git+https://github.com/agentcommunity/DMV_for_agents.git',
      directory: 'packages/dmv-agent',
    },
    homepage: 'https://dmv.agentcommunity.org',
    bugs: { url: 'https://github.com/agentcommunity/DMV_for_agents/issues' },
    license: 'MIT',
    main: 'dist/index.js',
    types: 'dist/index.d.ts',
    bin: { 'dmv-agent': 'dist/cli.js' },
    engines: { node: '>=22' },
    files: ['dist/', 'skills/', 'README.md', 'CHANGELOG.md', 'LICENSE'],
    dependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
  };
  const alias = {
    name: 'dmv-agent',
    version: '0.1.3',
    description: 'Compatibility alias for the canonical @agentcommunity/dmv-agent CLI and MCP server',
    repository: {
      type: 'git',
      url: 'git+https://github.com/agentcommunity/DMV_for_agents.git',
      directory: 'packages/dmv-agent-alias',
    },
    homepage: 'https://dmv.agentcommunity.org',
    bugs: { url: 'https://github.com/agentcommunity/DMV_for_agents/issues' },
    license: 'MIT',
    bin: { 'dmv-agent': 'bin/dmv-agent.js' },
    engines: { node: '>=22' },
    files: ['bin/', 'README.md', 'LICENSE'],
    dependencies: { '@agentcommunity/dmv-agent': '^0.3.0' },
  };

  assert.doesNotThrow(() => assertSourceContracts(canonical, alias));
  assert.throws(
    () => assertSourceContracts({ ...canonical, engines: undefined }, alias),
    /Node engine/i,
  );
  assert.throws(
    () => assertSourceContracts(canonical, {
      ...alias,
      dependencies: { '@agentcommunity/dmv-agent': '^0.2.2', 'another-capability': '^1.0.0' },
    }),
    /compatibility dependency/i,
  );
  assert.doesNotThrow(() => assertSourceContracts(
    { ...canonical, gitHead: 'a'.repeat(40) },
    { ...alias, gitHead: 'a'.repeat(40) },
    { expectedGitHead: 'a'.repeat(40) },
  ));
  assert.throws(
    () => assertSourceContracts(canonical, alias, { expectedGitHead: 'a'.repeat(40) }),
    /gitHead/i,
  );
});

test('tarball integrity uses npm sha512 SRI format', () => {
  assert.equal(
    sha512Integrity(Buffer.from('dmv-artifact', 'utf8')),
    'sha512-SGUsABgvenWuVcH1e+F37wdFWffD6NXUfmKloc74dybwCEWcOmiTLviN860qErdaGX3DhUARmYt141qQeR+tvg==',
  );
});

test('production lookup evidence requires an issued live-check result', () => {
  assert.doesNotThrow(() => assertIssuedCliOutput(
    '✓ Certificate REEF-068-BD0Q is issued (live check).\nAgent: masato.agent',
    'REEF-068-BD0Q',
  ));
  assert.throws(
    () => assertIssuedCliOutput(
      'Certificate REEF-068-BD0Q has a valid check digit (format-only check).',
      'REEF-068-BD0Q',
    ),
    /issued live-check/i,
  );
});

test('provenance validation binds the package digest to the trusted workflow', () => {
  const payload = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{
      name: 'pkg:npm/%40agentcommunity/dmv-agent@0.3.0',
      digest: { sha512: 'ab'.repeat(64) },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: 'https://github.com/agentcommunity/DMV_for_agents',
            path: '.github/workflows/publish-dmv-packages.yml',
          },
        },
      },
    },
  };
  const response = {
    attestations: [{
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        },
      },
    }],
  };

  assert.doesNotThrow(() => assertProvenanceBundle(response, {
    packageName: '@agentcommunity/dmv-agent',
    version: '0.3.0',
    integrity: `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`,
  }));
  assert.throws(
    () => assertProvenanceBundle(response, {
      packageName: '@agentcommunity/dmv-agent',
      version: '0.3.0',
      integrity: `sha512-${Buffer.from('cd'.repeat(64), 'hex').toString('base64')}`,
    }),
    /subject digest/i,
  );
});

test('secretless upstream verification accepts only the closed 403 gate', () => {
  assert.doesNotThrow(() => assertSecretlessGateResponse(403, 'registration'));
  assert.throws(
    () => assertSecretlessGateResponse(200, 'registration'),
    /registration.*expected 403.*HTTP 200/i,
  );
});
