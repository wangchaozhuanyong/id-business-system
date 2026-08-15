import assert from 'node:assert/strict';
import test from 'node:test';
import { isV1EncryptedField, maskUserPhone } from './lib/user-phone-encryption.mjs';

test('masks user phone values without retaining plaintext formatting', () => {
  assert.equal(maskUserPhone('+60 12 345 6789'), '***6789');
  assert.equal(maskUserPhone('1234'), '***');
  assert.equal(maskUserPhone(''), null);
  assert.equal(maskUserPhone(null), null);
});

test('accepts only complete v1 encrypted field envelopes', () => {
  assert.equal(isV1EncryptedField('v1:abcdefghijklmnop:abcdefghijklmnopqrstuv:ciphertext'), true);
  assert.equal(isV1EncryptedField('plaintext-phone'), false);
  assert.equal(isV1EncryptedField('v1:short:short:ciphertext'), false);
  assert.equal(isV1EncryptedField(null), false);
});
