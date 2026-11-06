import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTotp, prepareTotpBatch } from '../modules/tools/totp.mjs';

// RFC 6238 Appendix B uses this public test key for SHA-1.
const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const uri = (value = key, options = '') => `otpauth://totp/test?secret=${value}${options}`;

test('TOTP matches the official values across a time boundary and beyond 2038', async () => {
  assert.deepEqual(await calculateTotp(uri(key, '&digits=8'), 59_000), {
    code: '94287082',
    expiresAt: 60_000
  });
  assert.equal((await calculateTotp(key, 59_000)).code, '287082');
  assert.notEqual((await calculateTotp(key, 60_000)).code, '287082');
  assert.equal((await calculateTotp(uri(key, '&digits=8'), 20_000_000_000_000)).code, '65353130');
});

test('TOTP rejects malformed input without copying it into errors', async () => {
  const invalid = 'INVALID!KEY';
  await assert.rejects(calculateTotp(invalid), (error) => !error.message.includes(invalid));
  await assert.rejects(calculateTotp(uri(key, '&period=0')), /时间周期/);
  await assert.rejects(calculateTotp(uri(key, '&algorithm=MD5')), /算法/);
  await assert.rejects(calculateTotp(uri().replace('/totp/', '/hotp/')), /基于时间/);
});

test('batch preparation keeps legacy account fields separate and reports only invalid rows', async () => {
  const result = await prepareTotpBatch(`账套一|只用于测试的密码|${key}\nINVALID!\n${uri()}`);
  assert.deepEqual(
    result.accounts.map((account) => account.label),
    ['账套一', 'test']
  );
  assert.deepEqual(await result.accounts[0].generate(59_000), {
    code: '287082',
    expiresAt: 60_000
  });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /^第 2 行/);
  assert.doesNotMatch(JSON.stringify(result), /只用于测试的密码|INVALID/);
});
