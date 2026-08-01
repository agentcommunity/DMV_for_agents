import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { assertReleaseWorkflowPolicy } from '../scripts/lib/dmv-release-workflow-policy.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workflow = readFileSync(
  path.join(ROOT, '.github/workflows/publish-dmv-packages.yml'),
  'utf8',
);

test('release workflow confines OIDC to protected main-only tarball publish jobs', () => {
  assert.doesNotThrow(() => assertReleaseWorkflowPolicy(workflow));
});

test('release workflow policy rejects alias publication before canonical proof', () => {
  const canonicalPublish = 'npm publish .release-artifacts/agentcommunity-dmv-agent-0.3.0.tgz --access public --provenance';
  const aliasPublish = 'npm publish .release-artifacts/dmv-agent-0.1.3.tgz --access public --provenance';
  const unsafe = workflow
    .replace(canonicalPublish, '__CANONICAL__')
    .replace(aliasPublish, canonicalPublish)
    .replace('__CANONICAL__', aliasPublish);

  assert.throws(() => assertReleaseWorkflowPolicy(unsafe), /canonical.*before.*alias/i);
});

test('release workflow policy rejects top-level OIDC authority', () => {
  const unsafe = workflow.replace(
    'permissions:\n  contents: read',
    'permissions:\n  contents: read\n  id-token: write',
  );
  assert.throws(() => assertReleaseWorkflowPolicy(unsafe), /top-level.*OIDC/i);
});

test('release workflow policy rejects OIDC on an unprivileged gate', () => {
  const unsafe = workflow.replace(
    'maintained-node-gate:\n    name:',
    'maintained-node-gate:\n    permissions:\n      contents: read\n      id-token: write\n    name:',
  );
  assert.throws(() => assertReleaseWorkflowPolicy(unsafe), /gate.*OIDC/i);
});

test('release workflow policy requires the protected environment and main ref', () => {
  assert.throws(
    () => assertReleaseWorkflowPolicy(workflow.replace(/\n\s+environment: npm-production/g, '')),
    /npm-production/i,
  );
  assert.throws(
    () => assertReleaseWorkflowPolicy(workflow.replaceAll("github.ref == 'refs/heads/main'", 'true')),
    /main ref/i,
  );
});

test('release workflow policy rejects publication without explicit provenance', () => {
  const unsafe = workflow.replaceAll(' --provenance', '');
  assert.throws(() => assertReleaseWorkflowPolicy(unsafe), /provenance/i);
});
