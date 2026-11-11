import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { claudeHistoryPreview, planClaudeHistoryIntake, stageClaudeHistoryIntake } from '../server/claude-history-intake.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { accountLifecycleSummary } from '../server/account-lifecycle.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { withClaudeMailboxCandidates } from '../server/tools/claude-mailbox-candidates.mjs';

const at = new Date('2026-11-10T08:00:00Z');
const actor = { id: 'fixture-admin', name: '合成管理员', role: 'admin' };
const opened = { email: 'stock@example.test', state: '已开通', plan: 'Max 20x',
  start: '2026-10-31 22:00', expiry: '2026-11-30 22:00', country: '马来西亚' };
const aging = { email: 'aging@example.test', state: '养号中', registered: '2026-10-29', device: '合成设备' };
const dead = { email: 'archive@gmail.com', state: '死号', plan: 'Max 20x', start: '2026-10-27', expiry: '2026-11-26' };

function snapshots() {
  return {
    inventory: { version: 4, data: { accounts: [], importRecords: [],
      mailboxes: [{ id: 'google', type: 'google', email: dead.email, health: 'normal', status: '正常', inventoryState: 'available' }] } },
    commerce: { version: 7, data: { orders: [], customers: [] } }
  };
}

test('历史账号保留原周期和未知日期，谷歌邮箱无自动关联', () => {
  const { inventory, commerce } = snapshots();
  const prior = structuredClone(inventory.data);
  const plan = planClaudeHistoryIntake({ rows: [opened, aging, dead] }, inventory, commerce, at.getTime());
  const preview = claudeHistoryPreview(plan);
  assert.equal(preview.pending, 3);
  assert.deepEqual(preview.rows.map(row => row.state), ['已开通', '养号中', '死号']);
  assert.deepEqual(inventory.data, prior);
  const result = stageClaudeHistoryIntake(plan, 4, inventory.data, actor, at);
  assert.equal(result.imported, 3);
  assert.deepEqual(inventory.data.mailboxes, prior.mailboxes);
  assert.deepEqual(commerce.data, { orders: [], customers: [] });
  const [active, pending, archive] = inventory.data.accounts;
  assert.equal(active.registered, '');
  assert.deepEqual(active.claudeHistory, { phase: 'opened', plan: 'Max 20x', start: '2026-10-31T22:00', expiry: '2026-11-30T22:00' });
  assert.equal(active.inventoryState, 'used');
  assert.equal(active.used, true);
  assert.equal(active.actualUsedAt, '2026-10-31 22:00');
  assert.equal(pending.inventoryState, 'available');
  assert.equal(pending.registered, '2026-10-29');
  assert.equal(pending.claudeHistory.plan, '');
  assert.equal(archive.health, 'dead');
  assert.equal(archive.healthChangedAt, undefined);
  assert.equal(archive.claudeHistory.expiry, '2026-11-26');
  assert.equal(accountLifecycleSummary(archive, commerce.data, at.getTime()).label, '已归档');
  assert.equal(archive.inventoryHistory[0].actorId, actor.id);
  assert.ok(inventory.data.accounts.every(row => row.status === '冻结' && row.usageLinks.length === 0));
  const legacy = structuredClone(inventory.data);
  Object.assign(legacy.accounts[0], { inventoryState: 'available', used: false, status: '正常' });
  assert.equal(accountLifecycleSummary(legacy.accounts[0], commerce.data, at.getTime()).label, '历史已开通');
  const claimed = structuredClone(legacy);
  claimed.accounts[0].inventoryState = 'claimed';
  assert.match(checkInventoryHistory(legacy, claimed), /历史账号当前不可提取/);
  assert.equal(inventory.data.importRecords[0].id, result.batchId);
  assert.equal(inventory.data.importRecords[0].actorId, actor.id);
  assert.equal(inspectInventoryUsage(inventory.data, commerce.data, at.getTime()).get('google').status, 'review');
  const googlePool = { items: [{ email: dead.email, source: 'manual' }] };
  assert.deepEqual(withClaudeMailboxCandidates(googlePool, inventory.data), googlePool);
});

test('预检阻止冲突和无效行，重试不重复登记', () => {
  const { inventory, commerce } = snapshots();
  commerce.data.orders.push({ product: 'Claude Pro', email: 'sold@example.test', customerId: 'customer' });
  const invalid = planClaudeHistoryIntake({ rows: [
    opened, { ...opened, email: opened.email.toUpperCase() },
    { ...aging, plan: 'Pro' }, { ...dead, expiry: '2026-11-31' },
    { email: 'sold@example.test', state: '死号' }, { ...dead, password: 'unexpected' }
  ] }, inventory, commerce, at.getTime());
  assert.deepEqual(claudeHistoryPreview(invalid).rows.slice(1).map(row => row.error), [
    '同一批 Claude 登录邮箱重复', '养号中的账号请保留未开通状态', '请核对原套餐、开通时间和到期时间',
    '该邮箱已关联客户订单，请先核对账号归属', '请只填写历史入库表头中的文字字段'
  ]);
  assert.throws(() => stageClaudeHistoryIntake(invalid, 4, inventory.data, actor, at), /第 2 条/);
  assert.equal(inventory.data.accounts.length, 0);

  const input = { rows: [dead] };
  const first = planClaudeHistoryIntake(input, inventory, commerce, at.getTime());
  assert.throws(() => stageClaudeHistoryIntake(first, 3, inventory.data, actor, at), /库存已变化/);
  stageClaudeHistoryIntake(first, 4, inventory.data, actor, at);
  inventory.version++;
  const replay = planClaudeHistoryIntake(input, inventory, commerce, at.getTime());
  assert.deepEqual(stageClaudeHistoryIntake(replay, 5, inventory.data, actor, at), { imported: 0, reused: 1 });
  assert.equal(inventory.data.accounts.length, 1);
  assert.equal(inventory.data.importRecords.length, 1);
  const changed = planClaudeHistoryIntake({ rows: [{ ...dead, expiry: '2026-11-27' }] }, inventory, commerce, at.getTime());
  assert.match(changed.rows[0].error, /已有同邮箱/);

  const forged = structuredClone(inventory.data);
  forged.accounts[0].claudeHistory.expiry = '2026-12-01';
  assert.match(checkInventoryHistory(inventory.data, forged), /专用入口/);
  const extracted = structuredClone(inventory.data);
  Object.assign(extracted.accounts[0], { inventoryState: 'claimed', health: 'normal', status: '正常' });
  assert.match(checkInventoryHistory(inventory.data, extracted), /不可提取/);
});

test('Claude 历史销售从原库存生成订单，买家可补齐，死号保留原周期与终止', () => {
  const store = createLocalBusinessStore(':memory:');
  const tenant = { id: 'tenant-supplier', name: '合成出租方', active: true };
  const buyer = { id: 'customer-buyer', name: '合成买家', active: true };
  const clock = Date.parse('2026-11-11T04:00:00Z');
  const subscriptionRows = () => store.withSubscriptions(actor, snapshots => projectSubscriptions(snapshots, clock));
  try {
    store.saveBatch([{ domain: 'inventory', version: 0, data: {
      mailboxes: [opened, dead].map(({ email }, i) => ({ id: 'google-' + i, email, type: 'google', status: '正常' })),
      accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
    } }, { domain: 'commerce', version: 0, data: {
      orders: [], tenants: [tenant], customers: [buyer], operating: [], rentBatches: [], logs: []
    } }]);
    store.saveClaudeHistory({ rows: [opened, dead], inventoryVersion: 1 }, actor);
    const originalInventory = store.load('inventory');
    const choices = store.claudeHistoricalSales();
    const [liveAccount, endedAccount] = choices.accounts;
    assert.deepEqual(choices.accounts.map(row => [row.email, row.ended]), [[opened.email, false], [dead.email, true]]);
    assert.ok(subscriptionRows().every(row => row.scope === 'owned'));
    const versions = { inventoryVersion: choices.inventoryVersion, commerceVersion: choices.commerceVersion };
    const input = {
      ...versions, accountId: liveAccount.id, tenantId: tenant.id,
      payment: '银行卡', saleAmount: '1500', saleCurrency: 'CNY', actualCostAmount: '1350', actualCostCurrency: 'CNY'
    };
    assert.throws(() => store.saveClaudeHistoricalSale(input, { ...actor, role: 'employee' }), /只有管理员/);
    assert.throws(() => store.saveClaudeHistoricalSale({ ...input, tenantId: buyer.id }, actor), /出租账号的租户/);
    assert.throws(() => store.saveClaudeHistoricalSale({ ...input, customerId: tenant.id }, actor), /购买账号的客户/);
    assert.throws(() => store.saveClaudeHistoricalSale({ ...input, paidConfirmed: true }, actor), /核对历史销售资料/);
    const first = store.saveClaudeHistoricalSale(input, actor);
    assert.equal(first.created, true);
    assert.deepEqual(store.saveClaudeHistoricalSale(input, actor), { ...first, created: false });
    assert.throws(() => store.saveClaudeHistoricalSale({ ...input, saleAmount: '2100' }, actor), /已有订单/);
    const endedInput = { ...versions, accountId: endedAccount.id, tenantId: tenant.id,
      payment: '苹果内购', saleAmount: '2100', saleCurrency: 'CNY', subscriptionEndedAt: '2026-11-06T19:20' };
    assert.throws(() => store.saveClaudeHistoricalSale(endedInput, actor), /已变化/);
    const ended = store.saveClaudeHistoricalSale({ ...endedInput, commerceVersion: first.version }, actor);
    assert.equal(ended.orderNo, 'OD-LOCAL-0002');
    assert.deepEqual(store.load('inventory'), originalInventory);
    assert.deepEqual(store.claudeHistoricalSales().accounts, []);
    const [firstOrder, endedOrder] = [first, ended].map(result =>
      store.load('commerce').data.orders.find(order => order.id === result.orderId));
    assert.deepEqual([firstOrder.customerId, firstOrder.tenantId, firstOrder.saleAmount, firstOrder.actualCostAmount],
      ['', tenant.id, '1500', '1350']);
    assert.deepEqual([firstOrder.paidConfirmed, firstOrder.receiptConfirmed, endedOrder.actualCostAmount], [false, false, '']);
    assert.deepEqual([endedOrder.start, endedOrder.expiry, endedOrder.subscriptionEndedAt],
      ['2026-10-27', '2026-11-26', '2026-11-06T19:20']);
    const cost = { action: 'fill-manual-details', orderId: endedOrder.id, version: endedOrder.version,
      details: { actualCost: { amount: '1234.50', currency: 'CNY', reason: '按原销售凭据核对' } } };
    assert.throws(() => store.saveOrderCompletion({ ...actor, role: 'employee' }, cost), /只有管理员/);
    assert.throws(() => store.saveOrderCompletion(actor, { ...cost, orderId: firstOrder.id }), /核对原历史销售/);
    assert.throws(() => store.saveOrderCompletion(actor, { ...cost, details: {
      actualCost: { ...cost.details.actualCost, reason: '' }
    } }), /成本、币种和核对依据/);
    store.saveOrderCompletion(actor, cost);
    const afterCost = store.load('commerce').data;
    const saved = afterCost.orders.find(row => row.id === endedOrder.id);
    const { updatedAt, version, actualCostAmount, actualCostCurrency, costBasis, ...retained } = saved;
    const { updatedAt: previousUpdate, version: priorVersion, actualCostAmount: previousCost,
      actualCostCurrency: previousCurrency, ...priorDetails } = endedOrder;
    assert.deepEqual(retained, priorDetails);
    assert.deepEqual([version, actualCostAmount, actualCostCurrency, costBasis],
      [priorVersion + 1, '1234.50', 'CNY', 'actual']);
    assert.match(afterCost.logs[0].detail, /实际总成本 1234\.50 CNY · 按原销售凭据核对/);
    assert.throws(() => store.saveOrderCompletion(actor, cost), /订单已变化/);
    const receipt = { action: 'fill-manual-details', orderId: endedOrder.id, version,
      details: { confirmFullReceipt: true } };
    assert.throws(() => store.saveOrderCompletion({ ...actor, role: 'employee' }, receipt), /只有管理员/);
    assert.throws(() => store.saveOrderCompletion(actor, { ...receipt,
      details: { confirmFullReceipt: true, saleAmount: '1' } }), /不可编辑/);
    assert.throws(() => store.saveOrderCompletion(actor, { ...receipt,
      details: { confirmFullReceipt: 'yes' } }), /售价及实收/);
    store.saveOrderCompletion(actor, receipt);
    const afterReceipt = store.load('commerce').data;
    const received = afterReceipt.orders.find(row => row.id === endedOrder.id);
    assert.deepEqual(received, {
      ...saved, version: version + 1, updatedAt: received.updatedAt, receiptConfirmed: true,
      financialEvidence: [{ kind: 'receipt', amount: saved.saleAmount, currency: saved.saleCurrency, at: received.updatedAt }]
    });
    assert.match(afterReceipt.logs[0].detail, /确认全额实收 2100 CNY/);
    assert.throws(() => store.saveOrderCompletion(actor, receipt), /订单已变化/);
    assert.throws(() => store.saveOrderCompletion(actor, { ...receipt, version: received.version }), /售价及实收/);
    for (const [order, status] of [[firstOrder, 'pending'], [endedOrder, 'ended']]) {
      const row = subscriptionRows().find(row => row.account === order.email);
      assert.deepEqual([row.scope, row.status, row.series[0].orderNo], ['customer', status, order.orderNo]);
    }
    store.saveOrderCompletion(actor, { action: 'fill-manual-details', orderId: firstOrder.id,
      version: firstOrder.version, details: { customerId: buyer.id } });
    const linked = subscriptionRows().find(row => row.account === firstOrder.email);
    assert.deepEqual([linked.scope, linked.status, linked.customerId], ['customer', 'active', buyer.id]);
    assert.deepEqual(store.load('inventory'), originalInventory);
    const commerce = store.load('commerce');
    commerce.data.tenants.push({ id: 'another-tenant', name: '其他出租方', active: true });
    store.saveBatch([{ domain: 'commerce', version: commerce.version, data: commerce.data }]);
    assert.equal(store.load('commerce').data.orders.length, 2);
    assert.deepEqual(store.load('inventory'), originalInventory);
  } finally {
    store.close();
  }
});

test('历史入库接口仅接受管理员同源预检和确认', async () => {
  const origin = 'https://inventory.example.test';
  const route = '/api/local/claude-history-intake';
  const calls = [];
  const store = {
    previewClaudeHistory: input => { calls.push(input); return { pending: 1 }; },
    saveClaudeHistory: (input, user) => { calls.push(input, user); return { imported: 1 }; }
  };
  async function request({ user = actor, from = origin, method = 'POST', mode = 'preview', ...input } = {}) {
    const req = Readable.from([Buffer.from(JSON.stringify({ mode, rows: [dead], ...input }))]);
    req.method = method;
    req.headers = { origin: from, 'content-type': 'application/json' };
    const response = {
      setHeader() {},
      writeHead(status) { this.status = status; },
      end(body) { this.body = JSON.parse(body); }
    };
    await handleLocalBusiness(req, response, route, store, user, { publicOrigin: origin });
    return response;
  }
  assert.equal((await request({ user: { ...actor, role: 'employee' } })).status, 403);
  assert.equal((await request({ from: 'https://other.example.test' })).status, 403);
  assert.equal((await request({ method: 'GET' })).status, 405);
  assert.equal((await request({ mode: 'unknown' })).status, 400);
  assert.equal(calls.length, 0);
  assert.equal((await request()).body.pending, 1);
  assert.equal((await request({ mode: 'confirm', inventoryVersion: 4 })).body.imported, 1);
  assert.deepEqual(calls, [{ rows: [dead] }, { rows: [dead], inventoryVersion: 4 }, actor]);
});
