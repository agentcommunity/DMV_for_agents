import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';

import {
  assertAliasRegistryContract,
  assertArtifactEntries,
  assertCanonicalRegistryContract,
  classifyReleasePackageState,
  classifyReleaseSequence,
  createVerifierChildEnvironment,
  assertNoSensitiveArtifact,
  assertNoProvenanceDisablingNpmConfig,
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

test('npm configuration cannot disable or replace workflow-generated provenance', () => {
  assert.doesNotThrow(() => assertNoProvenanceDisablingNpmConfig('audit=false\nfund=false\n', '.npmrc'));
  assert.throws(
    () => assertNoProvenanceDisablingNpmConfig('provenance=false\n', '.npmrc'),
    /provenance-disabling/i,
  );
  assert.throws(
    () => assertNoProvenanceDisablingNpmConfig('provenance-file=attestation.json\n', '.npmrc'),
    /provenance-disabling/i,
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
  assert.throws(
    () => assertSourceContracts({
      ...canonical,
      dependencies: { '@modelcontextprotocol/sdk': '^1.0.1' },
    }, alias),
    /runtime dependency map/i,
  );
  assert.throws(
    () => assertSourceContracts({
      ...canonical,
      scripts: { install: 'node surprise.js' },
    }, alias),
    /lifecycle script/i,
  );
  assert.throws(
    () => assertSourceContracts({
      ...canonical,
      scripts: { prepublishOnly: 'node candidate-code-with-oidc.js' },
    }, alias),
    /lifecycle script/i,
  );
  assert.throws(
    () => assertSourceContracts({
      ...canonical,
      publishConfig: { provenance: false },
    }, alias),
    /provenance/i,
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
  const commit = 'a'.repeat(40);
  const payload = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [{
      name: 'pkg:npm/%40agentcommunity/dmv-agent@0.3.0',
      digest: { sha512: 'ab'.repeat(64) },
    }],
    predicate: {
      buildDefinition: {
        buildType: 'https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1',
        externalParameters: {
          workflow: {
            repository: 'https://github.com/agentcommunity/DMV_for_agents',
            path: '.github/workflows/publish-dmv-packages.yml',
            ref: 'refs/heads/main',
          },
        },
        internalParameters: { github: { runner_environment: 'github-hosted' } },
        resolvedDependencies: [{
          uri: 'git+https://github.com/agentcommunity/DMV_for_agents@refs/heads/main',
          digest: { gitCommit: commit },
        }],
      },
      runDetails: {
        builder: { id: 'https://github.com/actions/runner/github-hosted' },
      },
    },
  };
  const response = {
    attestations: [{
      predicateType: 'https://slsa.dev/provenance/v1',
      bundle: {
        dsseEnvelope: {
          payloadType: 'application/vnd.in-toto+json',
          payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
        },
      },
    }],
  };

  assert.doesNotThrow(() => assertProvenanceBundle(response, {
    packageName: '@agentcommunity/dmv-agent',
    version: '0.3.0',
    integrity: `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`,
    expectedGitHead: commit,
  }));
  assert.throws(
    () => assertProvenanceBundle(response, {
      packageName: '@agentcommunity/dmv-agent',
      version: '0.3.0',
      integrity: `sha512-${Buffer.from('cd'.repeat(64), 'hex').toString('base64')}`,
      expectedGitHead: commit,
    }),
    /subject digest/i,
  );
  const wrongRef = structuredClone(response);
  const wrongStatement = JSON.parse(Buffer.from(
    wrongRef.attestations[0].bundle.dsseEnvelope.payload,
    'base64',
  ).toString('utf8'));
  wrongStatement.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/feature';
  wrongRef.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
    JSON.stringify(wrongStatement),
  ).toString('base64');
  assert.throws(
    () => assertProvenanceBundle(wrongRef, {
      packageName: '@agentcommunity/dmv-agent',
      version: '0.3.0',
      integrity: `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`,
      expectedGitHead: commit,
    }),
    /main ref/i,
  );

  const invalidCases = [
    ['statement type', (statement) => { statement._type = 'https://example.test/Statement'; }, /statement type/i],
    ['build type', (statement) => { statement.predicate.buildDefinition.buildType = 'https://example.test/build'; }, /build type/i],
    ['runner', (statement) => { statement.predicate.buildDefinition.internalParameters.github.runner_environment = 'self-hosted'; }, /runner environment/i],
    ['builder', (statement) => { statement.predicate.runDetails.builder.id = 'https://example.test/builder'; }, /release builder/i],
    ['commit', (statement) => { statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = 'b'.repeat(40); }, /gitCommit/i],
  ];
  for (const [label, mutate, expectedError] of invalidCases) {
    const candidate = structuredClone(response);
    const statement = JSON.parse(Buffer.from(
      candidate.attestations[0].bundle.dsseEnvelope.payload,
      'base64',
    ).toString('utf8'));
    mutate(statement);
    candidate.attestations[0].bundle.dsseEnvelope.payload = Buffer.from(
      JSON.stringify(statement),
    ).toString('base64');
    assert.throws(
      () => assertProvenanceBundle(candidate, {
        packageName: '@agentcommunity/dmv-agent',
        version: '0.3.0',
        integrity: `sha512-${Buffer.from('ab'.repeat(64), 'hex').toString('base64')}`,
        expectedGitHead: commit,
      }),
      expectedError,
      label,
    );
  }
});

test('secretless upstream verification accepts only the exact typed 403 envelope', () => {
  assert.doesNotThrow(() => assertSecretlessGateResponse({
    status: 403,
    contentType: 'application/json',
    body: { error: 'direct_access_deprecated' },
  }, 'lookup'));
  assert.throws(
    () => assertSecretlessGateResponse({
      status: 403,
      contentType: 'text/html',
      body: { error: 'direct_access_deprecated' },
    }, 'lookup'),
    /media type/i,
  );
  assert.throws(
    () => assertSecretlessGateResponse({
      status: 403,
      contentType: 'application/json',
      body: { error: 'jwt_required' },
    }, 'lookup'),
    /direct_access_deprecated/i,
  );
  assert.throws(
    () => assertSecretlessGateResponse({
      status: 403,
      contentType: 'application/json',
      body: { error: 'direct_access_deprecated', extra: true },
    }, 'lookup'),
    /exact JSON envelope/i,
  );
  assert.doesNotThrow(() => assertSecretlessGateResponse({
    status: 403,
    contentType: 'application/json',
    body: {
      error: 'direct_access_deprecated',
      message:
        'Direct access to this edge function is no longer supported. Use '
        + 'https://dmv.agentcommunity.org/api/register (the DMV worker proxy) '
        + 'or update @agentcommunity/dmv-agent to the latest version via '
        + '`bunx @agentcommunity/dmv-agent register`.',
    },
  }, 'registration'));
});

test('release state is absent, exact, or a version-bump-required mismatch', () => {
  assert.equal(classifyReleasePackageState(null, {
    packageName: '@agentcommunity/dmv-agent',
    expectedIntegrity: 'sha512-local',
  }), 'absent');
  assert.equal(classifyReleasePackageState({ dist: { integrity: 'sha512-local' } }, {
    packageName: '@agentcommunity/dmv-agent',
    expectedIntegrity: 'sha512-local',
  }), 'exact');
  assert.throws(
    () => classifyReleasePackageState({ dist: { integrity: 'sha512-other' } }, {
      packageName: '@agentcommunity/dmv-agent',
      expectedIntegrity: 'sha512-local',
    }),
    /version bump required/i,
  );
});

test('release sequence resumes only through absent, canonical-only, or alias-complete states', () => {
  assert.equal(classifyReleaseSequence('absent', 'absent'), 'publish-canonical');
  assert.equal(classifyReleaseSequence('exact', 'absent'), 'publish-alias');
  assert.equal(classifyReleaseSequence('exact', 'exact'), 'complete');
  assert.throws(
    () => classifyReleaseSequence('absent', 'exact'),
    /ambiguous.*version bump required/i,
  );
});

test('verifier child processes cannot inherit release credentials or GitHub OIDC request authority', () => {
  const environment = createVerifierChildEnvironment('/tmp/npm-home', {
    PATH: '/usr/bin',
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'oidc-token',
    ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example.test',
    NPM_TOKEN: 'npm-token',
    NODE_AUTH_TOKEN: 'node-token',
    NPM_ID_TOKEN: 'npm-id-token',
    npm_config__auth: 'auth',
  });
  assert.equal(environment.PATH, '/usr/bin');
  for (const key of [
    'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
    'ACTIONS_ID_TOKEN_REQUEST_URL',
    'NPM_TOKEN',
    'NODE_AUTH_TOKEN',
    'NPM_ID_TOKEN',
    'npm_config__auth',
  ]) {
    assert.equal(environment[key], undefined, `${key} must be scrubbed`);
  }
});
