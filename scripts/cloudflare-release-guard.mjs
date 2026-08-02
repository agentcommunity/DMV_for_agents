#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const PRODUCTION_BRANCH = 'main';

function uploadRelease(branch) {
  return {
    action: 'upload',
    branch,
    args: ['wrangler', 'versions', 'upload'],
  };
}

export function selectCloudflareRelease({
  workersCi = '',
  workersCiBranch = '',
  localBranch = '',
  explicitPreview = false,
} = {}) {
  const isWorkersBuild = workersCi === '1';
  const branch = (isWorkersBuild ? workersCiBranch : localBranch).trim();

  if (explicitPreview) {
    return uploadRelease(branch || 'detached');
  }

  if (isWorkersBuild) {
    if (!branch) {
      throw new Error('WORKERS_CI_BRANCH is required in Workers Builds; refusing release.');
    }

    if (branch !== PRODUCTION_BRANCH) {
      return uploadRelease(branch);
    }
  } else if (branch !== PRODUCTION_BRANCH) {
    throw new Error(
      `Refusing production deploy from local branch ${JSON.stringify(branch || 'detached')}. ` +
        'Use pnpm cf:preview to upload a preview version.',
    );
  }

  return {
    action: 'deploy',
    branch,
    args: ['wrangler', 'deploy'],
  };
}

function readLocalBranch() {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function run() {
  const unknownArgs = process.argv.slice(2).filter((arg) => arg !== '--preview');
  if (unknownArgs.length > 0) {
    throw new Error(`Unknown release argument: ${unknownArgs.join(' ')}`);
  }

  const explicitPreview = process.argv.includes('--preview');
  const release = selectCloudflareRelease({
    workersCi: process.env.WORKERS_CI,
    workersCiBranch: process.env.WORKERS_CI_BRANCH,
    localBranch: explicitPreview ? '' : readLocalBranch(),
    explicitPreview,
  });
  const [packageName, ...wranglerArgs] = release.args;

  console.log(
    `[cloudflare-release] ${release.action} for ${release.branch}: npx ${release.args.join(' ')}`,
  );

  const result = spawnSync('npx', [packageName, ...wranglerArgs], {
    stdio: 'inherit',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run();
}
