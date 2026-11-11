import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
// Real SQLite transaction acceptance runs only in the existing remote isolated CI.
test('租户与银行卡真实事务原子提交，故障回滚全部写入，重开仍为加密数据', { skip: process.env.CI !== 'true' }, async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url)); await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'tenant-card-transaction-')), path = join(directory, 'business.sqlite');
  let store = createLocalBusinessStore(path), control = new DatabaseSync(path);
  const actor = { id: 'admin', name: '隔离管理员', role: 'admin' };
  const number = '4000000000000000';
  const data = { customers: [], tenants: [{ id: 'tenant', name: '合成租户', phone: '合成电话', version: 1,
    initialCards: [{ number, label: '合成银行卡' }] }], orders: [], operating: [], rentBatches: [], logs: [] };
  const save = () => store.saveBatch([{ domain: 'commerce', version: 0, data, action: '新增资料' }], { actor });
  try {
    control.exec("CREATE TRIGGER synthetic_card_write_failure BEFORE INSERT ON business_document WHEN NEW.domain='tenant-cards' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    assert.throws(save);
    assert.equal(store.load('commerce').version, 0); assert.equal(store.featureDocument('tenant-cards').version, 0);
    assert.equal(store.audit().length, 0, '商务先写入的内容及审计也必须回滚');
    assert.equal(data.tenants[0].initialCards[0].number, number, '调用者输入不被失败事务清除');
    control.exec('DROP TRIGGER synthetic_card_write_failure'); control.close(); control = null;
    save();
    assert.equal(store.load('commerce').data.tenants[0].ownerId, actor.id);
    assert(!Object.hasOwn(store.load('commerce').data.tenants[0], 'initialCards'));
    assert.equal(store.featureDocument('tenant-cards').data.items[0].number, number);
    assert.equal(store.audit().length, 2); assert(!JSON.stringify(store.audit()).includes(number));
    store.close(); store = null;
    assert(!(await readFile(path)).includes(Buffer.from(number)));
    store = createLocalBusinessStore(path);
    assert.equal(store.load('commerce').data.tenants[0].name, '合成租户');
    assert.equal(store.featureDocument('tenant-cards').data.items[0].tenantId, 'tenant');
  } finally { control?.close(); store?.close(); await rm(directory, { recursive: true }); }
});
