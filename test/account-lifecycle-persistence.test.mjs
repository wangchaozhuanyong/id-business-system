import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';

// Run through npm test in the existing remote, isolated CI; no production data.
const actor = { id: 'lifecycle-admin', name: '隔离管理员', role: 'admin' };
const write = (domain, version, data, action) => ({ domain, version, data, action });

function seed(t, type) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const fixture = lifecycleFixture(type);
  const initial = { ...fixture.inventory, tableSettings: [], undo: [] };
  const originalLink = initial.accounts[0].usageLinks[0];
  Object.assign(initial.accounts[0], { inventoryState: 'available', used: false, usageLinks: [] });
  store.saveBatch([write('inventory', 0, initial, 'inventory_create')], { actor });
  const allocated = store.load('inventory');
  Object.assign(allocated.data.accounts[0], { inventoryState: 'used', used: true, version: 2, usageLinks: [originalLink] });
  store.saveBatch([
    write('commerce', 0, fixture.commerce, '新增独立订单'),
    write('inventory', allocated.version, allocated.data, 'inventory_order_sale')
  ], { actor });
  return store;
}

function command(store, overrides = {}) {
  const snapshot = store.inventorySnapshot();
  return { version: snapshot.version, commerceVersion: snapshot.commerceVersion,
    data: { assetId: 'account-a', assetVersion: snapshot.data.accounts[0].version,
      commandId: 'isolated-lifecycle-command', action: 'release', reason: '客户已结束使用',
      controlled: true, accessReviewed: true, tasksReviewed: true, ...overrides } };
}

for (const type of ['gpt', 'claude']) {
  test(`${type} 加密文档回收保存和回读保留原单，重复回执不增加版本或审计`, t => {
    const store = seed(t, type), request = command(store);
    const original = store.load('commerce'), beforeAudit = store.audit().length;
    const saved = store.saveAccountLifecycle(request, actor);
    assert.equal(saved.version, request.version + 1);
    assert.equal(saved.data.accounts[0].inventoryState, 'available');
    assert.equal(saved.accountSummaries[0].latestKyc.verifier, '历史认证人');
    assert.deepEqual(store.load('commerce'), original);
    assert.equal(store.audit().length, beforeAudit + 1);
    assert.deepEqual(store.saveAccountLifecycle(request, actor), saved);
    assert.equal(store.audit().length, beforeAudit + 1);
    assert.throws(() => store.saveAccountLifecycle({ ...request, data: { ...request.data, reason: '不同内容' } }, actor), { status: 409 });
    assert.deepEqual(store.inventorySnapshot(), saved);
  });

  test(`${type} 回库、再交付与续费共同保留旧资料，旧客户失败时事务不写入`, t => {
    const store = seed(t, type);
    store.saveAccountLifecycle(command(store), actor);
    const commerce = store.load('commerce'), inventory = store.load('inventory');
    const original = structuredClone(commerce.data.orders[0]);
    const nextOrder = { ...structuredClone(original), id: 'new-sale', orderNo: 'QA-2', customerId: 'customer-b',
      start: '2026-11-07T12:00', expiry: '2026-12-07T12:00', createdAt: '2026-11-07T12:00' };
    commerce.data.orders.push(nextOrder);
    const asset = inventory.data.accounts[0];
    Object.assign(asset, { inventoryState: 'used', used: true, version: asset.version + 1 });
    asset.usageLinks.push({ kind: 'order-sale', orderId: nextOrder.id, label: '再次交付', time: '2026-11-07 12:00' });
    if (type === 'claude') {
      const changedProof = structuredClone(commerce.data);
      changedProof.orders.at(-1).verifier = '不同认证人';
      assert.throws(() => store.saveBatch([
        write('commerce', commerce.version, changedProof, '新增独立订单'),
        write('inventory', inventory.version, structuredClone(inventory.data), 'inventory_order_sale')
      ], { actor }), /不能重复认证/);
    }
    store.saveBatch([
      write('commerce', commerce.version, commerce.data, '新增独立订单'),
      write('inventory', inventory.version, inventory.data, 'inventory_order_sale')
    ], { actor });
    const before = store.inventorySnapshot(), previous = store.load('commerce'), auditCount = store.audit().length;
    const renewal = { ...structuredClone(original), id: 'renew-new', orderNo: 'QA-3', businessType: '续费', accountId: '' };
    const renewed = structuredClone(previous.data);
    renewed.orders.push(renewal);
    assert.throws(() => store.saveBatch([write('commerce', previous.version, renewed, '新增独立订单')], { actor }), /其他客户/);
    assert.deepEqual(store.inventorySnapshot(), before);
    assert.deepEqual(store.load('commerce'), previous);
    assert.equal(store.audit().length, auditCount);
    renewal.customerId = 'customer-b';
    const result = store.saveBatch([write('commerce', previous.version, renewed, '新增独立订单')], { actor });
    assert.deepEqual(result.map(row => row.domain), ['commerce', 'inventory']);
    const saved = store.inventorySnapshot();
    assert.equal(saved.data.accounts[0].inventoryState, 'used');
    assert.equal(saved.accountSummaries[0].customerId, 'customer-b');
    assert.equal(saved.data.accounts[0].usageLinks.at(-1).kind, 'order-renewal');
    const savedOrders = store.load('commerce').data.orders;
    assert.deepEqual(savedOrders[0], original);
    if (type === 'claude') assert.deepEqual(savedOrders.map(row => row.kyc), [original.kyc, undefined, undefined]);
  });
}

test('文档和账号版本、角色、确认项失败不会写库存、订单或审计', t => {
  const store = seed(t, 'gpt'), valid = command(store);
  const before = store.inventorySnapshot(), previous = store.load('commerce'), auditCount = store.audit().length;
  for (const [request, user] of [
    [{ ...valid, version: 0 }, actor], [{ ...valid, commerceVersion: 0 }, actor],
    [{ ...valid, data: { ...valid.data, assetVersion: 999 } }, actor],
    [{ ...valid, data: { ...valid.data, controlled: false } }, actor],
    [valid, { ...actor, role: 'employee' }]
  ]) {
    assert.throws(() => store.saveAccountLifecycle(request, user));
    assert.deepEqual(store.inventorySnapshot(), before);
    assert.deepEqual(store.load('commerce'), previous);
    assert.equal(store.audit().length, auditCount);
  }
  store.saveBatch([write('commerce', previous.version, structuredClone(previous.data), '更正订单')], { actor });
  assert.throws(() => store.saveAccountLifecycle(valid, actor), { status: 409 });
  assert.deepEqual(store.load('inventory'), { version: before.version, data: before.data });
});
