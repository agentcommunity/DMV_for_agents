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

test('release workflow is tokenless OIDC and canonical-first', () => {
  assert.doesNotThrow(() => assertReleaseWorkflowPolicy(workflow));
});

test('release workflow policy rejects alias publication before canonical proof', () => {
  const canonicalPublish = 'npm publish .release-artifacts/agentcommunity-dmv-agent-0.3.0.tgz --access public';
  const aliasPublish = 'npm publish .release-artifacts/dmv-agent-0.1.3.tgz --access public';
  const unsafe = workflow
    .replace(canonicalPublish, '__CANONICAL__')
    .replace(aliasPublish, canonicalPublish)
    .replace('__CANONICAL__', aliasPublish);

  assert.throws(() => assertReleaseWorkflowPolicy(unsafe), /canonical.*before.*alias/i);
});
