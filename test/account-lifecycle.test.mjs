import assert from 'node:assert/strict';
import test from 'node:test';
import { accountLifecycleSummary, changeAccountLifecycle, checkInventoryRenewals, applyAccountOrderLifecycle } from '../server/account-lifecycle.mjs';
import { checkStockDeliveries, checkOrderFinancialHistory } from '../server/local-business-integrity.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { stageAppleOrderFunding } from '../server/apple-funding.mjs';

const actor = { id: 'admin', name: '隔离管理员', role: 'admin' };
const now = new Date('2026-11-07T08:00:00Z');
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';

const command = (fixture, overrides = {}) => ({ action: 'release', assetId: fixture.inventory.accounts[0].id,
  assetVersion: fixture.inventory.accounts[0].version, commandId: 'synthetic-command', reason: '客户已结束使用',
  controlled: true, accessReviewed: true, tasksReviewed: true, ...overrides });
const renew = (fixture, customerId = 'customer-a', id = 'renew-a') => ({ ...structuredClone(fixture.commerce.orders[0]),
  id, orderNo: id, businessType: '续费', customerId, accountId: '', accountSource: '客户自有',
  start: '2026-11-07T12:00', expiry: '2026-12-07T12:00' });

test('历史 Claude 默认冻结与实际冻结在库存和账号详情使用相同口径', () => {
  const imported = { id: 'legacy', type: 'claude', source: '历史入库', status: '冻结',
    health: 'normal', claudeHistory: { phase: 'aging' }, importId: 'legacy-import',
    inventoryHistory: [{ action: 'Claude 历史入库' }] };
  assert.equal(accountLifecycleSummary(imported, {}).label, '首次可用');
  assert.equal(accountLifecycleSummary({ ...imported, healthChangedAt: now.toISOString() }, {}).label, '待核对交付资料');
});

for (const type of ['gpt', 'claude']) {
  test(`${type} 回收保留账号编号、历史付款、KYC 和订单；到期只提示待处理`, () => {
    const f = lifecycleFixture(type), original = structuredClone(f);
    assert.equal(accountLifecycleSummary(f.inventory.accounts[0], f.commerce, now.getTime()).label, '到期待处理');
    assert.equal(f.inventory.accounts[0].inventoryState, 'used');
    assert.equal(changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now).changed, true);
    const account = f.inventory.accounts[0];
    assert.equal(account.id, original.inventory.accounts[0].id);
    assert.equal(account.password, original.inventory.accounts[0].password);
    assert.equal(account.inventoryState, 'available');
    assert.deepEqual(account.usageLinks, original.inventory.accounts[0].usageLinks);
    assert.deepEqual(f.commerce, original.commerce);
    const summary = accountLifecycleSummary(account, f.commerce, now.getTime());
    assert.equal(summary.label, '已回收可用');
    assert.equal(summary.currentKyc, '待重新核实');
    assert.equal(summary.latestKyc.verifier, '历史认证人');
    assert.equal(summary.latestKyc.verifierPhone, '000000');
    assert.equal(summary.latestKyc.tenant, '原认证租户');
    assert.equal(summary.orders[0].paidAmount, '20.0000');
    assert.equal(summary.orders[0].released, true);
    assert.equal(inspectInventoryUsage(f.inventory, f.commerce, now.getTime()).size, 0);
  });
  test(`${type} 原客户续费保留库存身份，只追加独立订单和使用历史`, () => {
    const f = lifecycleFixture(type), previous = structuredClone(f.commerce);
    f.commerce.orders.push(renew(f));
    assert.equal(checkInventoryRenewals(previous, f.commerce, f.inventory), undefined);
    const saved = f.commerce.orders.at(-1);
    assert.equal(saved.accountId, 'account-a');
    assert.equal(saved.accountSource, '库存');
    applyAccountOrderLifecycle(previous, f.commerce, f.inventory, actor, now);
    assert.equal(f.inventory.accounts[0].inventoryState, 'used');
    assert.deepEqual(f.commerce.orders[0], previous.orders[0]);
    assert.equal(f.inventory.accounts[0].usageLinks.length, 2);
    assert.equal(accountLifecycleSummary(f.inventory.accounts[0], f.commerce).orders.length, 2);
  });
  test(`${type} 回收后再次交付给新客户，旧客户不能继续沿用，旧单继续可读`, () => {
    const f = lifecycleFixture(type);
    changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now);
    const before = structuredClone(f.inventory), priorCommerce = structuredClone(f.commerce);
    const reused = { ...structuredClone(f.commerce.orders[0]), id: 'order-b', orderNo: 'QA-2', customerId: 'customer-b',
      start: '2026-11-07T12:00', expiry: '2026-12-07T12:00', createdAt: '2026-11-07T12:00' };
    f.commerce.orders.push(reused);
    const account = f.inventory.accounts[0];
    account.inventoryState = 'used'; account.used = true;
    account.usageLinks.push({ kind: 'order-sale', orderId: 'order-b', label: '再次交付', time: '2026-11-07 12:00' });
    assert.equal(checkInventoryHistory(before, f.inventory), undefined);
    assert.equal(checkStockDeliveries(priorCommerce, f.commerce, before, f.inventory, actor), undefined);
    applyAccountOrderLifecycle(priorCommerce, f.commerce, f.inventory, actor, now);
    assert.equal(checkInventoryHistory(before, f.inventory, { trustedAccountLifecycle: true }), undefined);
    assert.equal(accountLifecycleSummary(account, f.commerce).customer, '客户 B');
    const previous = structuredClone(f.commerce);
    f.commerce.orders.push(renew(f, 'customer-a'));
    assert.match(checkInventoryRenewals(previous, f.commerce, f.inventory), /其他客户/);
    f.commerce.orders.pop();
    f.commerce.orders.push(renew(f, 'customer-b'));
    assert.equal(checkInventoryRenewals(previous, f.commerce, f.inventory), undefined);
    assert.deepEqual(f.commerce.orders[0], priorCommerce.orders[0]);
    assert.equal(checkOrderFinancialHistory(priorCommerce, { ...priorCommerce, orders: [priorCommerce.orders[0]] }), undefined);
  });
}

test('停止复用保留已使用位置，禁止续费；可经重新核对后恢复可用', () => {
  const f = lifecycleFixture();
  changeAccountLifecycle(f.inventory, f.commerce, command(f, { action: 'retire' }), actor, now);
  assert.equal(f.inventory.accounts[0].inventoryState, 'used');
  assert.equal(accountLifecycleSummary(f.inventory.accounts[0], f.commerce).label, '不再复用');
  assert.equal(accountLifecycleSummary(f.inventory.accounts[0], f.commerce).lastRecoveredAt, '', '停止复用不伪造回收时间');
  const previous = structuredClone(f.commerce);
  f.commerce.orders.push(renew(f));
  assert.match(checkInventoryRenewals(previous, f.commerce, f.inventory), /停止复用/);
  f.commerce.orders.pop();
  changeAccountLifecycle(f.inventory, f.commerce, command(f, { commandId: 'recover-later' }), actor, now);
  assert.equal(f.inventory.accounts[0].inventoryState, 'available');
  assert.equal(f.inventory.accounts[0].accountLifecycleEvents.length, 2);
});

test('同一回执重复提交不重复修改；更换内容不能复用提交编号', () => {
  const f = lifecycleFixture(), request = command(f);
  changeAccountLifecycle(f.inventory, f.commerce, request, actor, now);
  const before = structuredClone(f.inventory);
  assert.equal(changeAccountLifecycle(f.inventory, f.commerce, request, actor, now).changed, false);
  assert.deepEqual(f.inventory, before);
  assert.throws(() => changeAccountLifecycle(f.inventory, f.commerce, { ...request, reason: '不同原因' }, actor, now), /提交内容/);
});

test('未确认控制权、陈旧版本、普通员工、客户自有和异常账号不能回库', () => {
  for (const [override, change, user] of [
    [{ controlled: false }, null, actor], [{ accessReviewed: false }, null, actor],
    [{ tasksReviewed: false }, null, actor], [{ assetVersion: 999 }, null, actor],
    [{}, null, { ...actor, role: 'employee' }], [{}, account => { account.source = '客户提供'; }, actor],
    [{}, account => { account.health = 'dead'; }, actor]
  ]) {
    const f = lifecycleFixture(); change?.(f.inventory.accounts[0]);
    const before = structuredClone(f);
    assert.throws(() => changeAccountLifecycle(f.inventory, f.commerce, command(f, override), user, now));
    assert.deepEqual(f, before);
  }
});

test('未到期须显式确认提前结束，执行中及未知付款结果不能回库', () => {
  const f = lifecycleFixture();
  f.commerce.orders[0].expiry = '2099-01-01T12:00';
  assert.throws(() => changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now), /尚未到期/);
  f.commerce.orders[0].status = 'payment_unknown';
  assert.throws(() => changeAccountLifecycle(f.inventory, f.commerce, command(f, { endEarly: true }), actor, now), /付款结果未知/);
  delete f.commerce.orders[0].status;
  changeAccountLifecycle(f.inventory, f.commerce, command(f, { endEarly: true }), actor, now);
  assert.equal(f.commerce.orders[0].expiry, '2099-01-01T12:00');
});

test('回收账号再次提取和未使用归还允许，回收历史不能由普通保存伪造或删除', () => {
  const f = lifecycleFixture();
  changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now);
  const before = structuredClone(f.inventory);
  const claimed = structuredClone(before);
  claimed.accounts[0].inventoryState = 'claimed'; claimed.accounts[0].used = true;
  assert.equal(checkInventoryHistory(before, claimed), undefined);
  assert.equal(checkInventoryHistory(claimed, before), undefined);
  const forged = structuredClone(before);
  forged.accounts[0].accountLifecycle.customerId = 'attacker';
  assert.match(checkInventoryHistory(before, forged), /专用操作/);
  const deleted = structuredClone(before);
  deleted.accounts[0].accountLifecycleEvents = [];
  assert.match(checkInventoryHistory(before, deleted), /专用操作|必须保留/);
});

test('已回收账号不能直接给原客户续费，独立客户邮箱不强制进入库存', () => {
  const f = lifecycleFixture();
  changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now);
  const previous = structuredClone(f.commerce);
  f.commerce.orders.push(renew(f));
  assert.match(checkInventoryRenewals(previous, f.commerce, f.inventory), /重新分配/);
  f.commerce.orders.at(-1).email = 'customer-owned@example.test';
  assert.equal(checkInventoryRenewals(previous, f.commerce, f.inventory), undefined);
  assert.equal(f.commerce.orders.at(-1).accountId, '');
});

test('只按明确库存关联读取 KYC，不根据同邮箱外部订单猜测', () => {
  const f = lifecycleFixture();
  f.commerce.orders[0].accountId = '';
  f.commerce.orders[0].businessType = '续费';
  f.inventory.accounts[0].usageLinks = [];
  const summary = accountLifecycleSummary(f.inventory.accounts[0], f.commerce);
  assert.equal(summary.latestKyc, null);
  assert.equal(summary.orders.length, 0);
});

test('执行任务、重复客户归属必须先核对，拒绝操作不产生修改', () => {
  for (const update of [
    f => { f.inventory.batches.push({ items: [{ assetId: 'account-a', status: 'pending', taskId: 'task-a' }] }); },
    f => { f.inventory.accounts[0].reservation = { outcome: 'payment_unknown' }; },
    f => { f.inventory.accounts[0].reservation = { outcome: 'unknown' }; },
    f => { f.commerce.orders.push({ ...f.commerce.orders[0], id: 'legacy-other', customerId: 'customer-b' }); }
  ]) {
    const f = lifecycleFixture(); update(f);
    const before = structuredClone(f);
    assert.throws(() => changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now), /待处理任务|多个未结束客户/);
    assert.deepEqual(f, before);
  }
});

test('原库存订单不能通过普通更正换邮箱、客户或库存身份；回收不授权一次交付两次', () => {
  const f = lifecycleFixture();
  for (const field of ['accountId', 'email', 'product', 'businessType', 'customerId']) {
    const next = structuredClone(f.commerce);
    next.orders[0][field] = 'different';
    assert.match(checkInventoryRenewals(f.commerce, next, f.inventory), /普通订单更正/);
  }
  changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now);
  const next = structuredClone(f.commerce);
  next.orders.push({ ...next.orders[0], id: 'resale-1' }, { ...next.orders[0], id: 'resale-2' });
  assert.match(checkStockDeliveries(f.commerce, next, f.inventory, f.inventory, actor), /不能重复交付/);
});

test('Claude 历史成品单可在更正时补首位客户，原库存、期限和财务证据保留', () => {
  const { commerce, inventory } = lifecycleFixture();
  const [prior] = commerce.orders;
  Object.assign(prior, { source: '历史入库', product: 'Claude Max', plan: 'Max 20x', payment: '苹果内购' });
  delete prior.customerId;
  const { corrections, refunds, bankReturns, ...previous } = structuredClone(prior);
  const next = structuredClone(commerce);
  Object.assign(next.orders[0], {
    customerId: 'customer-a', notes: '按原销售记录补客户', version: 2,
    corrections: [{ previous, versionAfter: 2, reason: '按原销售记录核对' }]
  });
  const completedCustomerOrders = new Set();
  const options = { action: '更正订单', actor, completedCustomerOrders };
  const originalInventory = structuredClone(inventory);
  assert.equal(checkInventoryRenewals(commerce, next, inventory, options), undefined);
  assert.deepEqual([...completedCustomerOrders], [prior.id]);
  assert.equal(checkStockDeliveries(commerce, next, inventory, inventory, actor), undefined);
  assert.equal(applyAccountOrderLifecycle(commerce, next, inventory, actor, now), false);
  assert.deepEqual(inventory, originalInventory);
  assert.equal(checkOrderFinancialHistory(commerce, next), undefined);
  assert.equal(accountLifecycleSummary(inventory.accounts[0], next, now.getTime()).customerId, 'customer-a');

  for (const unsafe of [
    { customerId: '不存在' },
    { customerId: 'customer-b', accountId: '其他账号' },
    { corrections: [] },
    { corrections: [{ previous: { ...previous, email: 'other@example.test' }, versionAfter: 2, reason: '错误的原单' }] },
    { version: 1 }
  ]) {
    const rejected = structuredClone(next);
    Object.assign(rejected.orders[0], unsafe);
    assert.ok(checkInventoryRenewals(commerce, rejected, inventory, options));
  }
  assert.ok(checkInventoryRenewals(commerce, next, inventory, { ...options, actor: { ...actor, role: 'employee' } }));
  const conflicting = structuredClone(commerce);
  conflicting.orders.push({ ...prior, id: 'other-order', customerId: 'customer-b' });
  assert.ok(checkInventoryRenewals(conflicting, next, inventory, options));
  assert.ok(checkInventoryRenewals(commerce, { ...next, orders: [...next.orders, conflicting.orders.at(-1)] }, inventory, options));
  const duplicateStock = structuredClone(inventory);
  duplicateStock.accounts.push({ ...duplicateStock.accounts[0], id: 'duplicate-stock' });
  assert.match(checkInventoryRenewals(commerce, next, duplicateStock, options), /多个账号/);
  const reassigned = structuredClone(next);
  reassigned.orders[0].customerId = 'customer-b';
  assert.ok(checkInventoryRenewals(next, reassigned, inventory, options));
});

test('旧库存订单空客户字段的不同写法不拦截无关资料更正', () => {
  const { commerce, inventory } = lifecycleFixture();
  delete commerce.orders[0].customerId;
  const next = structuredClone(commerce);
  Object.assign(next.orders[0], { customerId: '', notes: '已核对原单' });
  assert.equal(checkInventoryRenewals(commerce, next, inventory), undefined);
});

test('历史订单补客户继续使用原 Apple ID，余额记录与其他订单绑定受保护', () => {
  const { commerce, inventory } = lifecycleFixture();
  const prior = { ...commerce.orders[0], customerId: undefined, payment: '苹果内购', appleIdId: 'original-wallet',
    appleStoreRegion: 'US', appleFunding: { region: 'US', expected: '20', bound: true } };
  const ledger = { wallets: [{ id: prior.appleIdId, currency: 'USD', balance: '30' }],
    allocations: [{ orderId: prior.id, appleIdId: prior.appleIdId, amount: '20', returned: '0' }] };
  const originalLedger = structuredClone(ledger);
  const order = { ...prior, customerId: 'customer-a', notes: '补登记买家' };
  const accepted = new Set([order.id]);
  const check = (previous, next, approved) => stageAppleOrderFunding(previous, next, ledger, inventory, {}, '更正订单',
    commerce.customers, approved);
  assert.equal(check([prior], [order], accepted), undefined);
  assert.deepEqual(ledger, originalLedger);
  assert.match(check([prior], [order]), /绑定不能改写/);
  assert.match(check([order], [{ ...order, customerId: 'customer-b' }], accepted), /绑定不能改写/);
  assert.match(check([prior], [{ ...order, appleIdId: 'other-wallet' }], accepted), /保留原付款/);
  assert.match(check([{ ...prior, appleIdId: '' }], [order], accepted), /保留原付款/);
  const conflicting = { ...prior, id: 'other-order', email: 'other@example.test', customerId: 'customer-b' };
  assert.match(check([prior, conflicting], [order, conflicting], accepted), /已有其他绑定/);
  assert.match(check([prior, conflicting], [order], accepted), /必须保留原订单/);

  const pending = { ...prior, paidConfirmed: false, appleFunding: undefined };
  assert.equal(check([pending], [{ ...pending, customerId: '', notes: '补备注' }]), undefined);
  assert.equal(check([pending], [{ ...pending, customerId: 'customer-a' }], accepted), undefined);
  assert.match(check([pending], [{ ...pending, paidAmount: '1' }]), /实际客户/);
  assert.deepEqual(ledger, originalLedger);
});

test('历史订单已结束或撤单时，专用回收仍关闭原交付占用，不删除原状态', () => {
  for (const flag of ['cancelled', 'subscriptionEnded']) {
    const f = lifecycleFixture();
    f.commerce.orders[0][flag] = true;
    changeAccountLifecycle(f.inventory, f.commerce, command(f), actor, now);
    assert.deepEqual(f.inventory.accounts[0].accountLifecycleEvents[0].orderIds, ['order-a']);
    const prior = structuredClone(f.inventory), previous = structuredClone(f.commerce);
    const next = { ...structuredClone(previous.orders[0]), id: 'next-sale', customerId: 'customer-b',
      cancelled: false, subscriptionEnded: false };
    f.commerce.orders.push(next);
    Object.assign(f.inventory.accounts[0], { inventoryState: 'used', used: true });
    f.inventory.accounts[0].usageLinks.push({ kind: 'order-sale', orderId: next.id });
    assert.equal(checkStockDeliveries(previous, f.commerce, prior, f.inventory, actor), undefined);
    assert.equal(f.commerce.orders[0][flag], true);
  }
});

test('无人员信息的旧导入保存不伪造人员，新增使用记录可经过 JSON 持久化往返', () => {
  const f = lifecycleFixture(), previous = structuredClone(f.commerce);
  f.commerce.orders.push(renew(f));
  assert.equal(checkInventoryRenewals(previous, f.commerce, f.inventory), undefined);
  applyAccountOrderLifecycle(previous, f.commerce, f.inventory, undefined, now);
  assert.deepEqual(JSON.parse(JSON.stringify(f.inventory)), f.inventory);
  assert.equal(f.inventory.accounts[0].lastOperatedById, undefined);
});

test('既有客户自有账号可正常保存，系统库存不能借来源更正转成客户账号', () => {
  const f = lifecycleFixture();
  const changed = structuredClone(f.inventory);
  changed.accounts[0].accountSource = '客户自有';
  assert.match(checkInventoryHistory(f.inventory, changed), /客户自有来源/);
  assert.equal(checkInventoryHistory(changed, structuredClone(changed)), undefined);
});
