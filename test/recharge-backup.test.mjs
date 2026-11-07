import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script = fileURLToPath(new URL('../deploy/recharge-core/seal-backup.mjs', import.meta.url));

test('a deployment backup verifies without emitting plaintext and binds ciphertext to its release and existing key', () => {
  const revision = 'a'.repeat(40);
  const key = randomBytes(32).toString('hex');
  const sql = Buffer.from('synthetic-dump-data-only\n'.repeat(10000));
  const sealed = spawnSync(process.execPath, [script, 'seal', revision], { input: Buffer.concat([Buffer.from(key + '\n'), sql]) });
  assert.equal(sealed.status, 0);
  assert.equal(sealed.stdout.includes(Buffer.from('synthetic-dump')), false);
  const metadata = JSON.parse(sealed.stderr);
  assert.equal(metadata.sha256, createHash('sha256').update(sql).digest('hex'));
  const input = Buffer.concat([Buffer.from(key + '\n'), sealed.stdout]);
  const verified = JSON.parse(execFileSync(process.execPath, [script, 'verify', revision], { input }));
  assert.equal(verified.sha256, metadata.sha256);
  assert.equal(verified.bytes, sql.length);
  const tampered = Buffer.from(sealed.stdout); tampered[25] ^= 1;
  assert.equal(spawnSync(process.execPath, [script, 'verify', revision], { input: Buffer.concat([Buffer.from(key + '\n'), tampered]) }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, 'verify', 'b'.repeat(40)], { input }).status, 1);
  assert.equal(spawnSync(process.execPath, [script, 'verify', revision], { input: Buffer.concat([Buffer.from(randomBytes(32).toString('hex') + '\n'), sealed.stdout]) }).status, 1);
});
