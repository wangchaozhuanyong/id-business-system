import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile, copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile
} from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createSnapshot, restoreSnapshot, verifySnapshot } from '../server/backup/local-sqlite.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtureMarker = 'fake-inventory-secret-for-backup-test';
const snapshotFile = 'local-business.sqlite';
const call = (...args) => spawnSync(process.execPath, ['server/backup/cli.mjs', ...args], {
  cwd: root, encoding: 'utf8'
});

async function drill(t) {
  const base = join(root, 'backups');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const folder = await mkdtemp(join(base, '.sqlite-drill-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const fixtureDir = join(folder, 'synthetic-source');
  await mkdir(fixtureDir, { mode: 0o700 });
  return {
    folder, source: join(fixtureDir, 'fixture.sqlite'),
    output: join(folder, 'snapshot'), restore: join(folder, 'restore')
  };
}

const inventory = {
  mailboxes: [{ id: 'fixture-mailbox', password: fixtureMarker }],
  accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [],
  tableSettings: [], undo: []
};
const commerce = {
  customers: [{ id: 'fixture-customer', name: '合成客户' }],
  tenants: [], operating: [], rentBatches: [], logs: [],
  orders: [{
    id: 'fixture-order', orderNo: 'QA-1', version: 1, customerId: 'fixture-customer',
    product: 'GPT', payment: '银行卡', cardId: 'fixture-card', paidConfirmed: true,
    paidCurrency: 'PHP', paidAmount: '1000', saleAmount: '250', saleCurrency: 'CNY', receiptConfirmed: true,
    refunds: [{ id: 'fixture-refund', amount: '70', currency: 'CNY', payment: '银行卡' }],
    bankReturns: [{ id: 'fixture-return', amount: '200', currency: 'PHP', cardId: 'fixture-card' }]
  }]
};

function seed(source) {
  const store = createLocalBusinessStore(source);
  try {
    store.saveBatch([
      { domain: 'inventory', version: 0, data: inventory },
      { domain: 'commerce', version: 0, data: commerce, action: '新增独立订单' }
    ]);
    store.saveToolbox({
      version: 0, data: { shortcuts: [], phrases: [] }
    }, { id: 'fixture-actor', name: '合成操作员' });
  } finally {
    store.close();
  }
}

test('银行卡类型和稳定卡 ID 关联随加密快照恢复', async t => {
  const paths = await drill(t);
  const store = createLocalBusinessStore(paths.source);
  const data = {
    items: [{ id: 'type-fixture', name: '合成卡类型', active: true }],
    assignments: { 'recharge:74': 'type-fixture' }
  };
  try {
    store.saveFeatureDocument('card-types', 0, data, {
      action: '设置银行卡类型', actor: { id: 'fixture-actor', name: '合成操作员' }, targetId: 'recharge:74'
    });
  } finally {
    store.close();
  }
  await createSnapshot({ source: paths.source, output: paths.output });
  assert.ok(!(await readFile(join(paths.output, snapshotFile))).includes(Buffer.from('合成卡类型')));
  await restoreSnapshot({ input: paths.output, output: paths.restore, key: paths.source + '.key' });
  const recovered = createLocalBusinessStore(join(paths.restore, snapshotFile));
  try {
    assert.deepEqual(recovered.featureDocument('card-types'), { version: 1, data });
  } finally {
    recovered.close();
  }
});

test('Claude 邮箱复制后缀按操作员分开备份和恢复', async t => {
  const paths = await drill(t);
  const alpha = { id: 'synthetic-alpha', name: '合成甲', role: 'admin' };
  const beta = { id: 'synthetic-beta', name: '合成乙', role: 'super' };
  const suffix = 'synthetic-copy-suffix-marker';
  const store = createLocalBusinessStore(paths.source);
  const rates = { quotes: [{ id: 'synthetic-quote', rates: { USD: '7.2' } }] };
  try {
    store.saveClaudeGoogleCopySettings({ version: 0, copy1: suffix, copy2: '合成后缀二' }, alpha);
    store.saveClaudeGoogleCopySettings({ version: 0, copy1: '合成乙后缀', copy2: '' }, beta);
    store.saveFeatureDocument('finance-rates', 0, rates);
  } finally {
    store.close();
  }
  await createSnapshot({ source: paths.source, output: paths.output });
  assert.ok(!(await readFile(join(paths.output, snapshotFile))).includes(Buffer.from(suffix)));
  await restoreSnapshot({ input: paths.output, output: paths.restore, key: paths.source + '.key' });
  const recovered = createLocalBusinessStore(join(paths.restore, snapshotFile));
  try {
    assert.deepEqual(recovered.loadClaudeGoogleCopySettings(alpha), { version: 1, copy1: suffix, copy2: '合成后缀二' });
    assert.deepEqual(recovered.loadClaudeGoogleCopySettings(beta), { version: 1, copy1: '合成乙后缀', copy2: '' });
    assert.deepEqual(recovered.featureDocument('finance-rates'), { version: 1, data: rates });
  } finally {
    recovered.close();
  }
});

test('CLI produces a standalone committed WAL snapshot and restores business documents with a separate key', async (t) => {
  const paths = await drill(t);
  createLocalBusinessStore(paths.source).close();
  const db = new DatabaseSync(paths.source);
  try {
    db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; BEGIN;');
    db.prepare('SELECT COUNT(*) FROM business_document').get();
    seed(paths.source);
    assert.ok((await stat(paths.source + '-wal')).size > 0);
    db.exec("COMMIT; BEGIN IMMEDIATE; INSERT INTO business_audit (at,domain,action,summary,version) VALUES ('fixture','commerce','local_save','uncommitted',3)");
    const created = call('snapshot', '--source', paths.source, '--output', paths.output);
    assert.equal(created.status, 0, created.stderr);
    const manifest = JSON.parse(created.stdout);
    assert.deepEqual([manifest.documents, manifest.auditEntries], [3, 3]);
    const snapshot = join(paths.output, snapshotFile);
    assert.deepEqual((await readdir(paths.output)).sort(), [snapshotFile, 'manifest.json'].sort());
    assert.equal((await stat(paths.output)).mode & 0o777, 0o700);
    assert.equal((await stat(snapshot)).mode & 0o777, 0o600);
    assert.equal((await stat(join(paths.output, 'manifest.json'))).mode & 0o777, 0o600);
    assert.ok(!(await readFile(snapshot)).includes(Buffer.from(fixtureMarker)));
    assert.doesNotMatch(created.stdout, /fixture-sqlite|合成客户|fake-inventory-secret/);
    const checked = call('verify', '--input', paths.output);
    assert.equal(checked.status, 0, checked.stderr);
    assert.deepEqual(JSON.parse(checked.stdout), manifest);

    const restored = call('restore', '--input', paths.output, '--key', paths.source + '.key',
      '--output', paths.restore);
    assert.equal(restored.status, 0, restored.stderr);
    assert.deepEqual(JSON.parse(restored.stdout), { restored: true, documents: 3, auditEntries: 3 });
    const recoveredFile = join(paths.restore, snapshotFile);
    assert.equal((await stat(recoveredFile + '.key')).mode & 0o777, 0o600);
    const recovered = createLocalBusinessStore(recoveredFile);
    try {
      assert.deepEqual(recovered.load('commerce'), { version: 1, data: commerce });
      assert.deepEqual(recovered.load('inventory'), { version: 1, data: inventory });
      assert.equal(recovered.loadToolbox({ id: 'fixture-actor' }).version, 1);
      assert.equal(recovered.audit().length, 3, 'the open transaction is absent');
    } finally {
      recovered.close();
    }
    db.exec('ROLLBACK');
  } finally {
    db.close();
  }
});

test('existing directories are refused, mismatched keys and corrupt packages cannot leave a restore', async (t) => {
  const paths = await drill(t);
  seed(paths.source);
  await createSnapshot(paths);
  await assert.rejects(createSnapshot(paths), /目标已存在/);
  await mkdir(paths.restore, { mode: 0o700 });
  const sentinel = join(paths.restore, 'existing');
  await writeFile(sentinel, 'preserve');
  await assert.rejects(restoreSnapshot({ input: paths.output, key: paths.source + '.key', output: paths.restore }), /拒绝覆盖/);
  assert.equal(await readFile(sentinel, 'utf8'), 'preserve');

  const wrong = join(paths.folder, 'different.key');
  await writeFile(wrong, randomBytes(32), { flag: 'wx', mode: 0o600 });
  const rejected = join(paths.folder, 'wrong-key');
  await assert.rejects(restoreSnapshot({ input: paths.output, key: wrong, output: rejected }), /配套密钥/);
  await assert.rejects(stat(rejected), { code: 'ENOENT' });

  await appendFile(join(paths.output, snapshotFile), Buffer.from([0]));
  await assert.rejects(verifySnapshot(paths.output), /SHA-256/);
  const invalid = join(paths.folder, 'corrupt-restore');
  await assert.rejects(restoreSnapshot({ input: paths.output, key: paths.source + '.key', output: invalid }), /SHA-256/);
  await assert.rejects(stat(invalid), { code: 'ENOENT' });
});

test('restores address records for both local and signed-in operators without mixing scopes', async (t) => {
  const paths = await drill(t);
  const store = createLocalBusinessStore(paths.source);
  const owner = { id: randomUUID(), name: '合成地址录入人' };
  const localStreet = '49 Local Fixture Avenue';
  const ownedStreet = '50 Staff Fixture Avenue';
  try {
    store.saveBitBrowserAddresses({ streets: [localStreet] });
    store.saveBitBrowserAddresses({ streets: [ownedStreet] }, owner);
    assert.throws(() => store.loadBitBrowserAddressBackup('bitbrowser-addresses:invalid'), {
      status: 404
    });
  } finally {
    store.close();
  }
  await createSnapshot(paths);
  const snapshot = await readFile(join(paths.output, snapshotFile));
  assert.equal(snapshot.includes(Buffer.from(ownedStreet)), false);
  await restoreSnapshot({ input: paths.output, key: paths.source + '.key', output: paths.restore });
  const recovered = createLocalBusinessStore(join(paths.restore, snapshotFile));
  try {
    const search = new URLSearchParams();
    assert.deepEqual(recovered.listBitBrowserAddresses(search).items.map((row) => row.line1), [
      localStreet
    ]);
    assert.deepEqual(recovered.listBitBrowserAddresses(search, owner).items.map((row) => row.line1), [
      ownedStreet
    ]);
    assert.equal(recovered.audit().length, 2);
  } finally {
    recovered.close();
  }
});

test('snapshots reject loose key copies, SQLite sidecars, symlinks and unrecognized SQLite schemas', async (t) => {
  const paths = await drill(t);
  seed(paths.source);
  await createSnapshot(paths);
  const loose = join(paths.output, snapshotFile + '.key');
  await copyFile(paths.source + '.key', loose);
  await assert.rejects(verifySnapshot(paths.output), /仅包含数据库和清单/);
  await rm(loose);
  const sidecar = join(paths.output, snapshotFile + '-wal');
  await writeFile(sidecar, '');
  await assert.rejects(verifySnapshot(paths.output), /附属文件/);
  await rm(sidecar);
  const linked = join(paths.folder, 'link.sqlite');
  await symlink(paths.source, linked);
  await assert.rejects(createSnapshot({ source: linked, output: paths.restore }), /普通文件/);

  const unrelated = join(paths.folder, 'other.sqlite');
  const db = new DatabaseSync(unrelated);
  db.exec('CREATE TABLE unrelated (id INTEGER)');
  db.close();
  await assert.rejects(createSnapshot({ source: unrelated, output: paths.restore }), /业务结构校验/);
  await assert.rejects(stat(paths.restore), { code: 'ENOENT' });
});
