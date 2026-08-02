import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectCloudflareRelease } from '../scripts/cloudflare-release-guard.mjs';

test('Workers Builds deploys only the main branch', () => {
  assert.deepEqual(
    selectCloudflareRelease({
      workersCi: '1',
      workersCiBranch: 'main',
      localBranch: 'ignored-local-branch',
    }),
    {
      action: 'deploy',
      branch: 'main',
      args: ['wrangler', 'deploy'],
    },
  );
});

test('Workers Builds uploads a version for every non-main branch', () => {
  for (const branch of ['feature/preview', 'release', '']) {
    if (branch === '') {
      assert.throws(
        () => selectCloudflareRelease({ workersCi: '1', workersCiBranch: branch }),
        /WORKERS_CI_BRANCH.*required/i,
      );
      continue;
    }

    const release = selectCloudflareRelease({
      workersCi: '1',
      workersCiBranch: branch,
    });

    assert.deepEqual(release, {
      action: 'upload',
      branch,
      args: ['wrangler', 'versions', 'upload'],
    });
    assert.notEqual(release.args.at(-1), 'deploy');
  }
});

test('local non-main and detached deploy attempts fail closed', () => {
  for (const localBranch of ['feature/local', '']) {
    assert.throws(
      () => selectCloudflareRelease({ localBranch }),
      /refusing production deploy/i,
    );
  }
});

test('the explicit preview command only uploads a version locally', () => {
  assert.deepEqual(
    selectCloudflareRelease({
      localBranch: 'feature/local',
      explicitPreview: true,
    }),
    {
      action: 'upload',
      branch: 'feature/local',
      args: ['wrangler', 'versions', 'upload'],
    },
  );
});

test('local main remains an explicit production fallback', () => {
  assert.deepEqual(selectCloudflareRelease({ localBranch: 'main' }), {
    action: 'deploy',
    branch: 'main',
    args: ['wrangler', 'deploy'],
  });
});

test('package scripts route releases through the guard', () => {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8'));

  assert.match(manifest.scripts['cf:deploy'], /cloudflare-release-guard\.mjs/);
  assert.match(manifest.scripts['cf:preview'], /cloudflare-release-guard\.mjs --preview/);
  assert.doesNotMatch(manifest.scripts['cf:deploy'], /&&\s*wrangler deploy/);
  assert.match(manifest.scripts.check, /cloudflare-release-guard\.test\.mjs/);
});

test('operator docs record the live v3 state and the branch-promotion incident', () => {
  const operatorDocs = [
    readFileSync('AGENTS.md', 'utf8'),
    readFileSync('CLAUDE.md', 'utf8'),
    readFileSync('CLOUDFLARE.md', 'utf8'),
    readFileSync('packages/dmv-agent/DEPLOY.md', 'utf8'),
  ].join('\n');

  assert.match(operatorDocs, /v3 is (?:now )?live/i);
  assert.match(operatorDocs, /preserve[\s\S]{0,100}v1[\s\S]{0,100}v2[\s\S]{0,100}v3/i);
  assert.match(operatorDocs, /2026-08-02[\s\S]{0,240}accidental[^\n]*branch[^\n]*production/i);
  assert.match(operatorDocs, /non-production[^\n]*`npx wrangler versions upload`/i);
  assert.match(operatorDocs, /production[^\n]*`npx wrangler deploy`/i);
  assert.match(operatorDocs, /`WORKERS_CI_BRANCH`/);
});
