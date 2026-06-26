import { createRequire } from 'node:module';

interface PackageJson {
  version?: unknown;
}

const require = createRequire(import.meta.url);

function readPackageVersion(): string {
  const pkg = require('../package.json') as PackageJson;
  return typeof pkg.version === 'string' && pkg.version ? pkg.version : '0.0.0';
}

export const packageVersion = readPackageVersion();
