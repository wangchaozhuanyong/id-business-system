import assert from 'node:assert/strict';
import test from 'node:test';
import { createHmac } from 'node:crypto';
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

test('valid Base32 keys are accepted without arbitrary length or distinct-character requirements', async () => {
  const reference = bytes => {
    const counter = Buffer.alloc(8); counter.writeBigUInt64BE(1n);
    const hash = createHmac('sha1', bytes).update(counter).digest();
    return String((hash.readUInt32BE(hash.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, '0');
  };
  assert.equal((await calculateTotp('MY======', 59_000)).code, reference(Buffer.from('f')));
  assert.equal((await calculateTotp('AAAAAAAAAAAAAAAA', 59_000)).code, reference(Buffer.alloc(10)));
  await assert.rejects(calculateTotp('AB'), /编码不完整/);
  await assert.rejects(calculateTotp('MY='), /长度不正确/);
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
  assert.equal(result.accounts[0].secretInput, key);
  assert.equal(result.accounts[1].secretInput, uri());
  assert.match(result.errors[0], /^第 2 行/);
  assert.doesNotMatch(JSON.stringify(result), /只用于测试的密码|INVALID/);
});

test('saving a calculated row keeps its URI configuration and excludes other account fields', async () => {
  const input = uri(key, '&issuer=RFC&algorithm=SHA256&digits=8&period=60');
  const { accounts } = await prepareTotpBatch(`fixture|fixture-password|${key}|fixture@example.test\n${input}`);
  assert.deepEqual(accounts.map(row => row.secretInput), [key, input]);
  assert.deepEqual(await calculateTotp(accounts[1].secretInput, 59_000), await accounts[1].generate(59_000));
  assert.doesNotMatch(JSON.stringify(accounts), /fixture-password|fixture@example/);
  assert(!JSON.stringify(await calculateTotp(input)).includes(key));
});
