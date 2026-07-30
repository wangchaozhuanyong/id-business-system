import assert from 'node:assert/strict';
import test from 'node:test';
import { createTotpCode, validateTotpSecret } from './lib/totp.mjs';

const rfcSecret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('generates the RFC 6238 SHA-1 vector with the requested digits', () => {
  assert.equal(createTotpCode(rfcSecret, 59_000, { digits: 8 }), '94287082');
  assert.equal(createTotpCode(rfcSecret, 59_000), '287082');
});

test('rejects invalid, short and non-base32 TOTP secrets', () => {
  assert.equal(validateTotpSecret(rfcSecret), true);
  assert.equal(validateTotpSecret('short'), false);
  assert.equal(validateTotpSecret('not-a-base32-secret!'), false);
  assert.throws(() => createTotpCode('invalid!'), /Base32/);
});
