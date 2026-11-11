import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

// No local database: this acceptance case runs in the existing remote isolated CI only.
test('租户转交与审计原子提交、失败回滚、重试幂等及加密重开', { skip: process.env.CI !== 'true' }, async () => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url)); await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'tenant-transfer-')), path = join(directory, 'business.sqlite');
  let store = createLocalBusinessStore(path), control = new DatabaseSync(path);
  const actor = { id: 'admin', name: '合成管理员', role: 'admin' }, staff = { id: 'staff', name: '合成员工', role: 'employee' };
  try {
    const [initial] = store.saveBatch([{ domain: 'commerce', version: 0, action: '新增资料', data: {
      customers: [], tenants: [{ id: 'tenant', name: '合成租户', phone: '合成电话', version: 1 }], orders: [{
        id: 'order', product: 'GPT', plan: 'Plus', businessType: '续费', payment: '银行卡',
        email: 'synthetic@example.test', ownerId: actor.id, version: 1
      }], operating: [], rentBatches: [], logs: []
    } }], { actor });
    const body = { tenantId: 'tenant', ownerId: staff.id, version: initial.version, tenantVersion: 1,
      operationId: 'tenant-transfer-00000000-0000-4000-8000-000000000002', reason: 'synthetic-private-transfer-reason' };
    const save = () => store.transferTenantOwner(body, actor, () => [staff]);
    control.exec("CREATE TRIGGER synthetic_transfer_audit_failure BEFORE INSERT ON business_audit WHEN NEW.action='tenant_owner_transfer' BEGIN SELECT RAISE(ABORT, 'synthetic failure'); END;");
    assert.throws(save); assert.deepEqual(store.load('commerce'), { version: initial.version, data: initial.data });
    assert.equal(store.audit().length, 1, '数据写入后审计失败，整个事务须回滚');
    control.exec('DROP TRIGGER synthetic_transfer_audit_failure'); control.close(); control = null;
    const saved = save(); assert.equal(saved.data.tenants[0].ownerId, staff.id);
    assert.deepEqual(saved.data.orders, initial.data.orders); assert.equal(saved.data.tenants[0].createdById, actor.id);
    assert.equal(store.audit().length, 2); assert.equal(store.audit()[0].actorId, actor.id);
    assert.equal(save().replayed, true); assert.equal(store.audit().length, 2);
    assert.equal(store.tenantOwnerTransferView('tenant').history.length, 1);
    assert(!JSON.stringify(store.audit()).includes(body.reason), '自由填写原因只进入加密历史，不进入明文审计摘要');
    store.close(); store = null;
    assert(!(await readFile(path)).includes(Buffer.from(body.reason)));
    store = createLocalBusinessStore(path);
    assert.equal(store.tenantOwnerTransferView('tenant').history[0].reason, body.reason);
    assert.equal(store.transferTenantOwner(body, actor, () => []).replayed, true);
    assert.equal(store.audit().length, 2);
    const forged = structuredClone(store.load('commerce'));
    delete forged.data.tenants[0].ownerTransfers;
    assert.throws(() => store.saveBatch([{ domain: 'commerce', ...forged }]), { status: 409 });
  } finally { control?.close(); store?.close(); await rm(directory, { recursive: true }); }
});
