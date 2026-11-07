import assert from 'node:assert/strict';
import { createCipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import test from 'node:test';
import { calculateTotp } from '../modules/tools/totp.mjs';
import { planLegacyTotpImport } from '../server/tools/legacy-totp-import.mjs';

const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const secrets = { fieldEncryptionKey: 'fixture-encryption', hashSecret: 'fixture-hash' };
const ownerId = '11111111-1111-4111-8111-111111111111';
function sourceRow(overrides = {}) {
  const row = { id: '22222222-2222-4222-8222-222222222222', userId: ownerId,
    name: '旧验证器', issuer: '原签发方', algorithm: 'sha1', digits: 8, period: 30,
    updatedAt: '2026-11-06T10:00:00.000Z', ...overrides };
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', createHash('sha256').update(secrets.fieldEncryptionKey).digest(), iv);
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return { ...row, secretEncrypted: ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join(':'),
    secretHash: createHmac('sha256', secrets.hashSecret).update([row.algorithm, row.digits, row.period, secret].join(':')).digest('hex') };
}
const bundle = (rows = [sourceRow()]) => ({ format: 'id-saved-totp-v1', ownerId, rows });
const blank = { version: 0, data: null };

test('restores the original TOTP algorithm, digits, period, issuer and timestamps', async () => {
  const plan = await planLegacyTotpImport(blank, bundle(), secrets);
  assert.equal(plan.imported, 1);
  assert.equal(plan.items[0].updatedAt, sourceRow().updatedAt);
  assert.equal(new URL(plan.items[0].secret).searchParams.get('issuer'), '原签发方');
  assert.equal((await calculateTotp(plan.items[0].secret, 59_000)).code, '94287082');
  const repeated = await planLegacyTotpImport({ version: 1, data: plan.items }, bundle(), secrets);
  assert.equal(repeated.imported, 0);
  assert.equal(repeated.unchanged, 1);
  assert.deepEqual(repeated.items, plan.items);
});

test('preserves current accounts and recognizes equivalent Base32 and URI settings', async () => {
  const existing = { id: '33333333-3333-4333-8333-333333333333', name: '当前名称', secret,
    updatedAt: '2026-11-07T01:00:00.000Z' };
  const snapshot = { version: 1, data: [existing] };
  const plan = await planLegacyTotpImport(snapshot, bundle([sourceRow({ digits: 6 })]), secrets);
  assert.deepEqual(plan, { items: [existing], imported: 0, unchanged: 1 });
  const other = await planLegacyTotpImport(snapshot, bundle(), secrets);
  assert.equal(other.items.length, 2);
  assert.deepEqual(snapshot.data, [existing]);
  assert.equal(other.items[0], existing);
});

test('refuses an owner mismatch, invalid authentication or invalid parameters without exposing secrets', async () => {
  for (const row of [sourceRow({ userId: '44444444-4444-4444-8444-444444444444' }),
    { ...sourceRow(), secretHash: '0'.repeat(64) }, sourceRow({ algorithm: 'md5' }),
    sourceRow({ digits: 4 }), sourceRow({ period: 0 })]) {
    await assert.rejects(planLegacyTotpImport(blank, bundle([row]), secrets), error =>
      error.status === 400 && !error.message.includes(secret) && !error.message.includes(row.secretEncrypted));
  }
  await assert.rejects(planLegacyTotpImport(blank, bundle(), { ...secrets, fieldEncryptionKey: 'wrong' }), /校验失败/);
});

test('refuses conflicting current names and duplicate source records without mutating the snapshot', async () => {
  const existing = { id: '33333333-3333-4333-8333-333333333333', name: '旧验证器', secret };
  const snapshot = { version: 1, data: [existing] };
  await assert.rejects(planLegacyTotpImport(snapshot, bundle(), secrets), error => error.status === 409);
  assert.deepEqual(snapshot.data, [existing]);
  await assert.rejects(planLegacyTotpImport(blank, bundle([sourceRow(), sourceRow()]), secrets), /校验失败/);
});

test('storage import preserves current records, audits one atomic import and refuses concurrent edits', async () => {
  const { createLocalBusinessStore } = await import('../server/local-business.mjs');
  const store = createLocalBusinessStore(':memory:');
  const actor = { id: ownerId, name: '管理员' };
  try {
    await store.saveSavedTotp({ action: 'create', version: 0, name: '当前账号', secret }, actor);
    const pending = store.importLegacySavedTotp(bundle(), secrets, actor, 1);
    await store.saveSavedTotp({ action: 'create', version: 1, name: '并发账号', secret }, actor);
    await assert.rejects(pending, error => error.status === 409);
    assert.equal(store.loadSavedTotp(actor).items.length, 2);
    const saved = await store.importLegacySavedTotp(bundle(), secrets, actor, 2);
    assert.deepEqual(saved, { version: 3, imported: 1, unchanged: 0, total: 3 });
    assert.deepEqual(await store.importLegacySavedTotp(bundle(), secrets, actor, 3),
      { version: 3, imported: 0, unchanged: 1, total: 3 });
    assert.equal(store.loadSavedTotp({ id: 'other-owner' }).items.length, 0);
    const audit = store.audit().filter(row => row.action === 'saved_totp_legacy_import');
    assert.equal(audit.length, 1);
    assert.equal(JSON.stringify(audit).includes(secret), false);
    await assert.rejects(store.importLegacySavedTotp(bundle(), secrets, actor, 2), error => error.status === 409);
  } finally {
    store.close();
  }
});
