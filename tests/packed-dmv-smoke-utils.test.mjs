import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assertPackedRegistrationBody,
  runAsyncWithTimeout,
  runSyncWithTimeout,
} from '../scripts/lib/packed-dmv-smoke-utils.mjs';

const validBody = {
  agent_name: 'packed-smoke-agent',
  email: 'operator@example.com',
  operator_name: 'Packed Smoke Operator',
  description: null,
  signup_source: 'cli',
  registration_type: 'AGENT',
  machine_fingerprint: 'a'.repeat(64),
};

test('assertPackedRegistrationBody requires the CLI machine fingerprint', () => {
  assert.doesNotThrow(() => assertPackedRegistrationBody(validBody));

  assert.throws(
    () => assertPackedRegistrationBody({
      ...validBody,
      machine_fingerprint: undefined,
    }),
    /machine_fingerprint/,
  );

  assert.throws(
    () => assertPackedRegistrationBody({
      ...validBody,
      machine_fingerprint: 'not-a-fingerprint',
    }),
    /machine_fingerprint/,
  );
});

test('runAsyncWithTimeout rejects stalled child processes', async () => {
  await assert.rejects(
    () => runAsyncWithTimeout(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { timeoutMs: 25 },
    ),
    /timed out after 25ms/,
  );
});

test('runSyncWithTimeout rejects stalled child processes', () => {
  assert.throws(
    () => runSyncWithTimeout(
      process.execPath,
      ['-e', 'setTimeout(() => {}, 1000)'],
      { timeoutMs: 25 },
    ),
    /timed out after 25ms/,
  );
});

test('runSyncWithTimeout does not report spawn errors as timeouts', () => {
  assert.throws(
    () => runSyncWithTimeout(
      'definitely-missing-dmv-smoke-command',
      [],
      { timeoutMs: 25 },
    ),
    (error) => {
      assert.match(error.message, /spawn error:/);
      assert.doesNotMatch(error.message, /timed out after 25ms/);
      return true;
    },
  );
});
