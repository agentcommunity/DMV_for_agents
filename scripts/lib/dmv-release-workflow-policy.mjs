import assert from 'node:assert/strict';

const canonicalPublish = 'npm publish .release-artifacts/agentcommunity-dmv-agent-0.3.0.tgz --access public';
const canonicalVerify = '--registry-mode=canonical-release';
const aliasPublish = 'npm publish .release-artifacts/dmv-agent-0.1.3.tgz --access public';
const finalVerify = '--registry-mode=release';
const canonicalGitHead = 'npm pkg set gitHead="$GITHUB_SHA" --workspace=@agentcommunity/dmv-agent';
const aliasGitHead = 'npm pkg set gitHead="$GITHUB_SHA" --workspace=dmv-agent';

export function assertReleaseWorkflowPolicy(workflow) {
  assert.match(workflow, /^\s{2}id-token: write$/m, 'OIDC permission');
  assert.match(workflow, /^\s{2}contents: read$/m, 'read-only repository permission');
  assert.match(workflow, /^\s{4}runs-on: ubuntu-latest$/m, 'GitHub-hosted runner');
  assert.match(workflow, /actions\/checkout@v7/);
  assert.match(workflow, /actions\/setup-node@v7/);
  assert.match(workflow, /node: \['22\.22\.3', '24\.18\.1'\]/, 'maintained Node matrix');
  assert.match(workflow, /node-version: '24\.18\.1'/, 'trusted publish Node pin');
  assert.match(workflow, /npm install --global npm@12\.0\.2/, 'trusted publish npm pin');
  assert.match(workflow, /package-manager-cache: false/, 'release cache disabled');
  assert.doesNotMatch(workflow, /^\s+cache:/m, 'no dependency cache');
  assert.doesNotMatch(workflow, /\b(?:NPM_TOKEN|NODE_AUTH_TOKEN)\b/, 'no long-lived release token');
  assert.match(workflow, /inputs\.confirmation == 'publish-0\.3\.0-and-0\.1\.3'/, 'explicit dispatch confirmation');
  assert.equal(workflow.match(/^\s*run: npm publish /gm)?.length, 2, 'exactly two publish operations');

  const canonicalPublishIndex = workflow.indexOf(canonicalPublish);
  const canonicalGitHeadIndex = workflow.indexOf(canonicalGitHead);
  const aliasGitHeadIndex = workflow.indexOf(aliasGitHead);
  const verifiedPackIndex = workflow.indexOf('--registry-mode=current --pack-output=.release-artifacts');
  const canonicalVerifyIndex = workflow.indexOf(canonicalVerify);
  const aliasPublishIndex = workflow.indexOf(aliasPublish);
  const finalVerifyIndex = workflow.indexOf(finalVerify, aliasPublishIndex);
  if (!(
    canonicalGitHeadIndex >= 0
    && aliasGitHeadIndex >= 0
    && canonicalGitHeadIndex < verifiedPackIndex
    && aliasGitHeadIndex < verifiedPackIndex
    && verifiedPackIndex < canonicalPublishIndex
    &&
    canonicalPublishIndex >= 0
    && canonicalPublishIndex < canonicalVerifyIndex
    && canonicalVerifyIndex < aliasPublishIndex
  )) {
    throw new Error('Canonical publish and proof must complete before alias publication');
  }
  if (!(aliasPublishIndex < finalVerifyIndex)) {
    throw new Error('Alias publication must complete before final release proof');
  }
  assert.equal(
    workflow.match(/for attempt in 1 2 3 4; do/g)?.length,
    2,
    'both registry propagation checks have bounded retries',
  );
}
