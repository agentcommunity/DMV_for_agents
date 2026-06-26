import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';

export const PACKED_SMOKE_CLI_TIMEOUT_MS = 30_000;
export const PACKED_SMOKE_NPM_TIMEOUT_MS = 120_000;

const machineFingerprintPattern = /^[a-f0-9]{64}$/;

export function assertPackedRegistrationBody(body) {
  assert.equal(body.agent_name, 'packed-smoke-agent');
  assert.equal(body.email, 'operator@example.com');
  assert.equal(body.operator_name, 'Packed Smoke Operator');
  assert.equal(body.description, null);
  assert.equal(body.signup_source, 'cli');
  assert.equal(body.registration_type, 'AGENT');
  assert.equal(typeof body.machine_fingerprint, 'string', 'machine_fingerprint must be a string');
  assert.match(
    body.machine_fingerprint,
    machineFingerprintPattern,
    'machine_fingerprint must be a 64-character lowercase hex string',
  );
}

export function runSyncWithTimeout(command, args, options = {}) {
  const { timeoutMs = PACKED_SMOKE_CLI_TIMEOUT_MS, ...spawnOptions } = options;
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...spawnOptions,
    timeout: timeoutMs,
  });

  if (result.error) {
    const reason = result.error.code === 'ETIMEDOUT'
      ? `timed out after ${timeoutMs}ms`
      : `spawn error: ${result.error.message}`;
    throw new Error(formatFailure(command, args, result, reason));
  }

  if (result.status !== 0) {
    throw new Error(formatFailure(command, args, result, `status: ${result.status}`));
  }

  return result;
}

export function runAsyncWithTimeout(command, args, options = {}) {
  const { timeoutMs = PACKED_SMOKE_CLI_TIMEOUT_MS, ...spawnOptions } = options;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...spawnOptions,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    function settle(settleFn, value) {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      settleFn(value);
    }

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      settle(
        reject,
        new Error(formatFailure(
          command,
          args,
          { stdout, stderr, signal: 'SIGTERM' },
          `timed out after ${timeoutMs}ms`,
        )),
      );
    }, timeoutMs);
    timeout.unref?.();

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      settle(reject, error);
    });
    child.on('close', (status, signal) => {
      if (status !== 0) {
        settle(
          reject,
          new Error(formatFailure(command, args, { status, signal, stdout, stderr }, `status: ${status}`)),
        );
        return;
      }

      settle(resolve, { status, stdout, stderr });
    });
  });
}

function formatFailure(command, args, result, reason) {
  return [
    `Command failed: ${command} ${args.join(' ')}`,
    reason,
    result.signal ? `signal: ${result.signal}` : undefined,
    'stdout:',
    result.stdout ?? '',
    'stderr:',
    result.stderr ?? '',
  ]
    .filter((line) => line !== undefined)
    .join('\n');
}
