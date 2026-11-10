import assert from 'node:assert/strict';
import test from 'node:test';
import { planHistoricalIntake, historicalIntakePreview, requireHistoricalIntake, stageHistoricalIntake } from '../server/apple-relay/historical-intake.mjs';
import { registerAppleRelayAliases } from '../server/apple-relay/alias-registration.mjs';
import { checkStockDeliveries, checkOrderFinancialHistory } from '../server/local-business-integrity.mjs';
import { inspectInventoryUsage, applyInventoryUsage } from '../server/inventory-usage.mjs';
import { applyAccountOrderLifecycle, checkInventoryRenewals } from '../server/account-lifecycle.mjs';
import { pendingRelayClaimIds } from '../server/relay-claim-integrity.mjs';
import { checkClaudeProRenewalSource, checkNewOrder } from '../server/order-policy.mjs';

const actor = { id: 'fixture-admin', name: '合成管理员', role: 'admin' };
const clock = new Date('2026-03-25T04:00:00Z');
const parent = { id: 'parent', version: 2, status: 'ACTIVE', email: 'primary@example.test', remotePrimaryId: '201' };
const sold = { email: 'sold@example.test', registered: '2026/1/12', wechat: 'fixture-wechat', plan: 'Pro 200',
  start: '2026/2/1 12:34', expiry: '2026/3/1 12:34', payment: '银行卡', note: '合成来源第 2 行' };
const registered = { email: 'registered@example.test', registered: '2026/1/18' };
const payload = (rows = [sold, registered]) => ({ parentId: parent.id, parentVersion: parent.version, days: 30, rows });
const fixture = () => ({
  inventory: { version: 12, data: { mailboxes: [], accounts: [], batches: [], registrationRecords: [],
    appleRelay: { parents: [parent], imports: [], events: [] } } },
  commerce: { version: 8, data: { customers: [{ id: 'fixture-customer', wechat: 'fixture-wechat', name: '合成客户' }], orders: [], logs: [] } }
});

test('历史注册和历史交付复用正常校验，在保存前离开可领用库存', () => {
  const { inventory, commerce } = fixture();
  const plan = planHistoricalIntake(payload(), inventory, commerce, clock.getTime());
  assert.deepEqual(historicalIntakePreview(plan).rows.map(row => [row.account, row.order]), [
    ['新增已使用账号', '新增待补全订单'], ['新增正常账号', '—']
  ]);
  requireHistoricalIntake(plan, { inventoryVersion: 12, commerceVersion: 8 });
  const next = structuredClone(inventory.data);
  next.mailboxes = plan.pending.map((row, index) => ({ id: `alias-${index}`, email: row.email, type: 'relay',
    parentMailboxId: parent.id, relayStatus: 'ACTIVE', inventoryState: 'available', usageLinks: [] }));
  const nextCommerce = structuredClone(commerce.data);
  const staged = stageHistoricalIntake(plan, next, nextCommerce, actor, clock.toISOString());
  const [order] = nextCommerce.orders;
  assert.equal(staged.accountsCreated, 2);
  assert.equal(nextCommerce.orders.length, 1);
  assert.equal(order.customerId, 'fixture-customer');
  assert.equal(order.start, '2026-02-01T12:34');
  assert.equal(order.expiry, '2026-03-01T12:34');
  assert.equal(order.paidAmount, '');
  assert.equal(order.saleAmount, '');
  assert.equal(order.paidConfirmed || order.receiptConfirmed || order.costConfirmed, false);
  assert.equal(checkNewOrder(order), undefined);
  assert.equal(checkOrderFinancialHistory(commerce.data, nextCommerce), undefined);
  assert.deepEqual(pendingRelayClaimIds(inventory.data, next, { action: 'inventory_relay_history_import', actor }), []);
  assert.match(checkStockDeliveries(commerce.data, nextCommerce, inventory.data, next, actor), /可用库存/);
  const priorDelivery = { ...inventory.data, accounts: staged.deliveryAccounts };
  assert.equal(checkStockDeliveries(commerce.data, nextCommerce, priorDelivery, next, actor), undefined);
  const matches = inspectInventoryUsage(next, nextCommerce, clock.getTime());
  assert(applyInventoryUsage(matches, actor, clock));
  assert(applyAccountOrderLifecycle(commerce.data, nextCommerce, next, actor, clock));
  for (const mailbox of next.mailboxes) {
    assert.equal(mailbox.inventoryState, 'used');
    assert.equal(mailbox.usageLinks[0].accountId, next.accounts.find(row => row.email === mailbox.email).id);
  }
  const account = next.accounts.find(row => row.id === order.accountId);
  assert.equal(account.inventoryState, 'used');
  assert.equal(account.accountLifecycle.customerId, order.customerId);
  assert.ok(next.accounts.every(row => row.status === '正常' && row.source === '自己注册'));

  const retry = planHistoricalIntake(payload(), { version: 13, data: next }, { version: 9, data: nextCommerce }, clock.getTime());
  assert.equal(retry.pending.length, 0);
  assert.equal(retry.rows[0].previousOrder.id, order.id);
  assert.throws(() => requireHistoricalIntake(retry, { inventoryVersion: 12, commerceVersion: 8 }), /重新预检/);
  assert.equal(inventory.data.mailboxes.length, 0);
  assert.equal(commerce.data.orders.length, 0);
});

test('历史入库预检挡住缺客户、跨主邮箱、重复和越权字段', () => {
  const { inventory, commerce } = fixture();
  inventory.data.mailboxes.push({ id: 'claimed', email: registered.email, type: 'relay', parentMailboxId: 'another-parent',
    relayStatus: 'ACTIVE', inventoryState: 'claimed' });
  const noCustomer = { ...sold, wechat: 'unknown' };
  const plan = planHistoricalIntake(payload([noCustomer, registered, sold,
    { ...registered, email: 'extra@example.test', paidConfirmed: 'yes' }]), inventory, commerce, clock.getTime());
  assert.deepEqual(plan.rows.map(row => row.error), [
    '请先按客户微信建立或核对唯一客户', '隐藏邮箱归属、状态或领用有冲突', '同一批隐藏邮箱重复', '只接受历史入库表头中的文字字段'
  ]);
  assert.throws(() => requireHistoricalIntake(plan, { inventoryVersion: 12, commerceVersion: 8 }), /第 1 条/);
});

test('收件服务部分登记后重试只补缺项，全部确认才保存库存', async () => {
  const { inventory, commerce } = fixture();
  const plan = planHistoricalIntake(payload(), inventory, commerce, clock.getTime());
  const input = { parentId: parent.id, parentVersion: parent.version, days: 30, batch: true,
    rows: plan.pending.map(({ email, note }) => ({ email, note })) };
  const remote = [];
  const creates = [];
  const saves = [];
  const provider = {
    virtualEmails: () => remote,
    batchCreateAliases({ rawInput }) {
      const requested = rawInput.split('\n').map(line => line.split(',')[0]);
      creates.push(requested);
      remote.push({ id: String(remote.length + 1), aliasEmail: requested[0], primaryAccountId: parent.remotePrimaryId,
        status: 'ACTIVE', buyerQueryCode: 'fixture-code' });
      if (creates.length === 1) throw Error('合成部分失败');
    }
  };
  const dependencies = {
    provider, remoteIdFor: row => row.remotePrimaryId, remoteAliasIdFor: row => row.remoteAliasId,
    perform: callback => callback([parent], [{ ...parent, id: parent.remotePrimaryId }], new Map()),
    savePrimaries: (...args) => { saves.push(args); return { processed: 2 }; }
  };
  await assert.rejects(() => registerAppleRelayAliases(input, actor, dependencies, plan), /尚未入库/);
  assert.equal(saves.length, 0);
  assert.deepEqual(await registerAppleRelayAliases(input, actor, dependencies, plan), { processed: 2 });
  assert.deepEqual(creates, [[sold.email, registered.email], [registered.email]]);
  assert.equal(saves[0][3].history, plan);
});

test('Claude 续费邮箱可空，非空仍校验，空邮箱不能绑定库存或原续费单', () => {
  for (const [product, plan] of [['Claude Pro', 'Pro'], ['Claude Max', 'Max 20x']]) {
    const order = { id: product, product, plan, businessType: '续费', email: '', payment: '银行卡' };
    assert.equal(checkNewOrder(order), undefined);
    assert.match(checkNewOrder({ ...order, email: 'no-address' }), /有效订单邮箱/);
    assert.match(checkNewOrder({ ...order, businessType: '成品交付' }), /有效订单邮箱/);
    assert.equal(checkInventoryRenewals({}, { orders: [order] }, { accounts: [] }), undefined);
    assert.match(checkInventoryRenewals({}, { orders: [{ ...order, accountId: 'fixture-account' }] }, { accounts: [] }), /库存账号/);
    assert.match(checkClaudeProRenewalSource({ ...order, claudeRenewalId: 'prior-order' }, null, new Map(), new Map()), /填写邮箱/);
  }
});
