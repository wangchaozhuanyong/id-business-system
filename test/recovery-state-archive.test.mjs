import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import { openRecoveryState, sealRecoveryState } from '../server/backup/recovery-archive.mjs';

const pair = () => generateKeyPairSync('rsa', { modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const entry = (path, value, kind = 'file') => {
  const bytes = Buffer.from(value);
  return { path, kind, mode: 0o600, uid: 993, gid: 992, data: bytes.toString('base64'),
    sha256: createHash('sha256').update(bytes).digest('hex') };
};
const state = () => ({ format: 'id-business-recovery-state-v1', appRevision: 'a'.repeat(40),
  nativeRevision: 'b'.repeat(40), startedAt: '2026-11-14T00:00:00Z', finishedAt: '2026-11-14T00:00:02Z',
  sessionPolicy: 'revoke', directories: ['formal', 'formal/data', 'credentials'].map(path => ({ path, mode: 0o700, uid: 993, gid: 992 })), entries: [
    entry('formal/data/local-auth.json', JSON.stringify({ id: 'synthetic-admin', passwordHash: 'synthetic-only' })),
    entry('formal/data/local-auth.json.security.json', JSON.stringify({ requireMfa: true })),
    entry('formal/data/local-business.sqlite', 'synthetic database bytes', 'sqlite'),
    entry('formal/data/local-business.sqlite.key', 'synthetic-only-field-key'),
    entry('formal/data/recharge-events.checkpoint.json', JSON.stringify({ source: 'synthetic-source',
      database: 'synthetic-recharge', position: { file: 'binlog.000003', position: 489 }, snapshotDone: true })),
    entry('credentials/synthetic-oauth', 'synthetic-only-recovery-marker', 'credential')
  ] });

test('恢复包保留账号标识、登录策略、断点及可移机凭据，明文不进入制品', () => {
  const keys = pair(), source = state();
  source.entries.push(entry('formal/data/中文恢复资料.json', 'synthetic attachment'));
  const { archive, receipt } = sealRecoveryState(source, keys.publicKey);
  assert.ok(!archive.includes(Buffer.from('synthetic-only-recovery-marker')));
  assert.ok(!archive.includes(Buffer.from(source.entries.at(-1).data)));
  const restored = openRecoveryState(archive, keys.privateKey);
  assert.deepEqual(restored.state, source);
  assert.deepEqual(restored.receipt, receipt);
  assert.equal(receipt.sessionPolicy, 'revoke');
  const damaged = Buffer.from(archive); damaged[damaged.length - 30] ^= 1;
  assert.throws(() => openRecoveryState(damaged, keys.privateKey), /VERIFICATION_FAILED/);
  assert.throws(() => openRecoveryState(archive.subarray(0, -1), keys.privateKey), /VERIFICATION_FAILED/);
  assert.throws(() => openRecoveryState(archive, pair().privateKey), /VERIFICATION_FAILED/);
});

test('恢复包拒绝缺项、路径穿越、重复条目、损坏内容及直接恢复会话或付款入口', () => {
  const keys = pair();
  const missing = state(); missing.entries.shift();
  assert.throws(() => sealRecoveryState(missing, keys.publicKey), /REQUIRED_STATE_MISSING/);
  for (const path of ['../outside', '/etc/outside', 'formal/../outside', 'a//b', 'a\\b']) {
    const input = state(); input.entries.push(entry(path, 'synthetic'));
    assert.throws(() => sealRecoveryState(input, keys.publicKey), /ENTRY_INVALID/);
  }
  for (const path of ['formal/data/local-auth.json.sessions/session.json',
    'formal/data/vendure-admission/accept-submissions', 'formal/data/vendure-admission/lookup.sock',
    'formal/vendure-state/vendure-task-service.lock']) {
    const input = state(); input.entries.push(entry(path, 'synthetic'));
    const directory = path.slice(0, path.lastIndexOf('/'));
    if (!input.directories.some(row => row.path === directory))
      input.directories.push({ path: directory, mode: 0o700, uid: 993, gid: 992 });
    assert.throws(() => sealRecoveryState(input, keys.publicKey), /RUNTIME_STATE_FORBIDDEN/);
  }
  const duplicate = state(); duplicate.entries.push(duplicate.entries[0]);
  assert.throws(() => sealRecoveryState(duplicate, keys.publicKey), /ENTRY_INVALID/);
  const damaged = state(); damaged.entries[0].data = Buffer.from('changed').toString('base64');
  assert.throws(() => sealRecoveryState(damaged, keys.publicKey), /ENTRY_INVALID/);
});
