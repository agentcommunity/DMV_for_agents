import assert from 'node:assert/strict';

const canonicalPublish = 'npm publish .release-artifacts/agentcommunity-dmv-agent-0.3.0.tgz --access public --provenance';
const aliasPublish = 'npm publish .release-artifacts/dmv-agent-0.1.3.tgz --access public --provenance';
const mainRefGuard = "github.ref == 'refs/heads/main'";
const privilegedJobs = ['publish-canonical', 'publish-alias'];
const unprivilegedJobs = [
  'maintained-node-gate',
  'prepare-release-artifacts',
  'canonical-state',
  'canonical-proof',
  'alias-state',
  'final-proof',
];

export function assertReleaseWorkflowPolicy(workflow) {
  const topPermissions = topLevelBlock(workflow, 'permissions');
  assert.match(topPermissions, /^  contents: read$/m, 'read-only top-level repository permission');
  if (/id-token:\s*write/.test(topPermissions)) {
    throw new Error('Top-level OIDC authority is forbidden');
  }
  assert.doesNotMatch(workflow, /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN|NPM_ID_TOKEN)\b/, 'no long-lived release token');
  assert.doesNotMatch(
    workflow,
    /(?:NPM_CONFIG_PROVENANCE\s*=\s*false|provenance\s*=\s*false|--provenance-file|NPM_CONFIG_PROVENANCE_FILE)/i,
    'no provenance-disabling release configuration',
  );
  assert.match(workflow, /node: \['22\.22\.3', '24\.18\.1'\]/, 'maintained Node matrix');
  assert.match(workflow, /node-version: '24\.18\.1'/, 'trusted publish Node pin');
  assert.match(workflow, /npm install --global npm@12\.0\.2/, 'trusted publish npm pin');
  assert.match(workflow, /package-manager-cache: false/, 'release cache disabled');
  assert.doesNotMatch(workflow, /^\s+cache:/m, 'no dependency cache');
  assert.match(workflow, /inputs\.confirmation == 'publish-0\.3\.0-and-0\.1\.3'/, 'explicit dispatch confirmation');

  const publishCommands = workflow.match(/^\s+- run: npm publish .*$/gm) ?? [];
  assert.equal(publishCommands.length, 2, 'exactly two publish operations');
  if (publishCommands.some((command) => !command.endsWith(' --provenance'))) {
    throw new Error('Every npm publish must explicitly enable provenance');
  }

  for (const jobName of unprivilegedJobs) {
    const block = jobBlock(workflow, jobName);
    if (/id-token:\s*write/.test(block)) {
      throw new Error(`${jobName} gate must not receive OIDC authority`);
    }
  }
  assert.equal(
    workflow.match(/^\s+id-token: write$/gm)?.length,
    privilegedJobs.length,
    'OIDC permission belongs only to the two publish jobs',
  );

  const prepareIndex = workflow.indexOf('prepare-release-artifacts:');
  const canonicalStateIndex = workflow.indexOf('canonical-state:');
  const canonicalPublishIndex = workflow.indexOf(canonicalPublish);
  const canonicalProofIndex = workflow.indexOf('canonical-proof:');
  const aliasStateIndex = workflow.indexOf('alias-state:');
  const aliasPublishIndex = workflow.indexOf(aliasPublish);
  const finalProofIndex = workflow.indexOf('final-proof:');
  if (!(
    prepareIndex < canonicalStateIndex
    && canonicalStateIndex < canonicalPublishIndex
    && canonicalPublishIndex < canonicalProofIndex
    && canonicalProofIndex < aliasStateIndex
    && aliasStateIndex < aliasPublishIndex
    && aliasPublishIndex < finalProofIndex
  )) {
    throw new Error('Canonical publish and proof must complete before alias publication and final proof');
  }

  for (const [jobName, exactPublish] of [
    ['publish-canonical', canonicalPublish],
    ['publish-alias', aliasPublish],
  ]) {
    const block = jobBlock(workflow, jobName);
    assert.match(block, /^    environment: npm-production$/m, `${jobName} protected npm-production environment`);
    if (!block.includes(mainRefGuard)) {
      throw new Error(`${jobName} must enforce the intended main ref`);
    }
    assert.match(block, /^      id-token: write$/m, `${jobName} OIDC permission`);
    assert.match(block, new RegExp(escapeRegExp(exactPublish)), `${jobName} exact tarball provenance publish`);
    assert.doesNotMatch(block, /actions\/checkout|\bpnpm\b|node scripts\/|verify:packages/, `${jobName} executes no candidate repository code`);
  }

  for (const jobName of [
    'prepare-release-artifacts',
    'canonical-state',
    'canonical-proof',
    'alias-state',
    'final-proof',
  ]) {
    if (!jobBlock(workflow, jobName).includes(mainRefGuard)) {
      throw new Error(`${jobName} must enforce the intended main ref`);
    }
  }

  assert.match(
    jobBlock(workflow, 'prepare-release-artifacts'),
    /--registry-mode=current --pack-output=\.release-artifacts/,
    'unprivileged exact artifact preparation',
  );
  assert.match(jobBlock(workflow, 'canonical-state'), /--package=canonical/, 'canonical absent-or-exact state');
  assert.match(jobBlock(workflow, 'alias-state'), /--package=alias/, 'alias absent-or-exact state');
  assert.match(jobBlock(workflow, 'canonical-proof'), /--require=exact/, 'canonical exact proof');
  assert.match(jobBlock(workflow, 'final-proof'), /--package=canonical[\s\S]*--package=alias/, 'final exact proof');

  assert.equal(
    workflow.match(/for attempt in 1 2 3 4; do/g)?.length,
    2,
    'post-publish registry proofs have bounded retries',
  );
}

function topLevelBlock(workflow, key) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `${key}:`);
  assert.notEqual(start, -1, `${key} top-level block`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || /^\s/.test(lines[end]))) end += 1;
  return lines.slice(start + 1, end).join('\n');
}

function jobBlock(workflow, jobName) {
  const lines = workflow.split('\n');
  const start = lines.findIndex((line) => line === `  ${jobName}:`);
  assert.notEqual(start, -1, `${jobName} job`);
  let end = start + 1;
  while (end < lines.length && (lines[end] === '' || !/^  [a-z0-9-]+:$/.test(lines[end]))) end += 1;
  return lines.slice(start, end).join('\n');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
