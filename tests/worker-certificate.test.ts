import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCertificateId, verifyCertificateId } from '../worker/certificate.ts';

test('accepts a valid certificate ID', () => {
  assert.equal(verifyCertificateId('MESA-DD6-660J'), true);
});

test('normalizes surrounding whitespace and lowercase certificate IDs', () => {
  assert.equal(normalizeCertificateId('  mesa-dd6-660j  '), 'MESA-DD6-660J');
  assert.equal(verifyCertificateId('  mesa-dd6-660j  '), true);
});

test('rejects a certificate ID with a changed check digit', () => {
  assert.equal(verifyCertificateId('MESA-DD6-660K'), false);
});

test('rejects a hyphenless certificate ID', () => {
  assert.equal(verifyCertificateId('MESADD6660J'), false);
});

test('rejects certificate IDs with misplaced or trailing hyphens', () => {
  assert.equal(verifyCertificateId('M-ESA-DD6-660J'), false);
  assert.equal(verifyCertificateId('MESA-DD6-660J-'), false);
});

test('rejects wrong-length IDs and punctuation outside the canonical alphabet', () => {
  assert.equal(verifyCertificateId('MESA-DD6-66J'), false);
  assert.equal(verifyCertificateId('MESA-DD6-660!'), false);
});
