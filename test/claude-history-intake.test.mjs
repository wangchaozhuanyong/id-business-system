import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { claudeHistoryPreview, planClaudeHistoryIntake, stageClaudeHistoryIntake } from '../server/claude-history-intake.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { accountLifecycleSummary } from '../server/account-lifecycle.mjs';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { withClaudeMailboxCandidates } from '../server/tools/claude-mailbox-candidates.mjs';
import { calculateConfirmedNetReceipt } from '../modules/finance/accounting.mjs';
import { inventoryOperationalStatus, manualOrderDetailsMissing } from '../frontend/order-opening.mjs';

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

test('历史账号保留原周期和未知日期，唯一注册邮箱可自动关联', () => {
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
  assert.ok(inventory.data.accounts.every(row => row.status === '正常' && row.usageLinks.length === 0));
  const legacy = structuredClone(inventory.data);
  Object.assign(legacy.accounts[0], { inventoryState: 'available', used: false, status: '正常' });
  assert.equal(accountLifecycleSummary(legacy.accounts[0], commerce.data, at.getTime()).label, '历史已开通');
  const claimed = structuredClone(legacy);
  claimed.accounts[0].inventoryState = 'claimed';
  assert.match(checkInventoryHistory(legacy, claimed), /历史账号当前不可提取/);
  const defaultFreeze = { ...pending, status: '冻结' };
  assert.equal(inventoryOperationalStatus(defaultFreeze), '正常');
  assert.equal(inventoryOperationalStatus({ ...defaultFreeze,
    inventoryHistory: [...pending.inventoryHistory, { action: '修改资料' }] }), '冻结');
  assert.equal(inventory.data.importRecords[0].id, result.batchId);
  assert.equal(inventory.data.importRecords[0].actorId, actor.id);
  assert.equal(inspectInventoryUsage(inventory.data, commerce.data, at.getTime()).get('google').status, 'used');
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
      mailboxes: [...[opened, dead].map(({ email }, i) => ({ id: 'google-' + i, email, type: 'google', status: '正常' })),
        { id: 'apple-history', email: 'historical-payment@example.test', type: 'apple', status: '正常',
          health: 'normal', appStoreRegion: 'US', appleOpeningBalance: '250' }],
      accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
    }, action: 'inventory_create' }, { domain: 'commerce', version: 0, data: {
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
      payment: '苹果内购', appleIdId: 'apple-history', paidAmount: '250', paidCurrency: 'USD',
      saleAmount: '2100', saleCurrency: 'CNY', subscriptionEndedAt: '2026-11-06T19:20' };
    assert.throws(() => store.saveClaudeHistoricalSale(endedInput, actor), /已变化/);
    const originalLedger = store.load('appleBalance');
    assert.throws(() => store.saveClaudeHistoricalSale({ ...endedInput,
      commerceVersion: first.version, paidAmount: '251' }, actor), /余额不足/);
    assert.deepEqual(store.load('appleBalance'), originalLedger);
    assert.equal(store.load('commerce').version, first.version);
    const ended = store.saveClaudeHistoricalSale({ ...endedInput, commerceVersion: first.version }, actor);
    assert.equal(ended.orderNo, 'OD-LOCAL-0002');
    assert.deepEqual(store.saveClaudeHistoricalSale(endedInput, actor), { ...ended, created: false });
    assert.deepEqual(store.load('inventory'), originalInventory);
    assert.deepEqual(store.claudeHistoricalSales().accounts, []);
    const [firstOrder, endedOrder] = [first, ended].map(result =>
      store.load('commerce').data.orders.find(order => order.id === result.orderId));
    assert.deepEqual([firstOrder.customerId, firstOrder.tenantId, firstOrder.saleAmount, firstOrder.actualCostAmount],
      ['', tenant.id, '1500', '1350']);
    assert.deepEqual([firstOrder.paidConfirmed, firstOrder.receiptConfirmed, endedOrder.actualCostAmount], [false, true, '']);
    assert.deepEqual([endedOrder.start, endedOrder.expiry, endedOrder.subscriptionEndedAt],
      ['2026-10-27', '2026-11-26', '2026-11-06T19:20']);
    assert.deepEqual([endedOrder.paidConfirmed, endedOrder.appleFunding.bound, endedOrder.customerId], [true, true, '']);
    assert.deepEqual(store.load('appleBalance').data.movements.filter(row => row.kind === 'order-charge').map(row =>
      [row.orderId, row.orderNo, row.amount, row.after]), [[ended.orderId, ended.orderNo, '-250', '0.0000']]);
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
    assert.equal(calculateConfirmedNetReceipt(saved), '2100.0000');
    assert.equal(manualOrderDetailsMissing(saved, afterCost.customers).receipt, undefined);
    assert.deepEqual(store.load('commerce').data, afterCost, '读取已录入实收不改写原单或追加确认记录');
    for (const [order, status] of [[firstOrder, 'active'], [endedOrder, 'dead']]) {
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

test('历史 Claude 首次补客户经存储事务保存并保留已绑定的 Apple 扣款', { skip: process.env.CI !== 'true' }, async t => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(join(runtime, 'historical-claude-buyer-'));
  const path = join(directory, 'business.sqlite');
  let store = createLocalBusinessStore(path);
  t.after(async () => {
    store?.close();
    await rm(directory, { recursive: true });
  });
  const buyer = { id: 'buyer', name: '合成买家', active: true };
  const other = { id: 'other-buyer', name: '合成其他客户', active: true };
  const tenant = { id: 'supplier', name: '合成出租方', active: true };
  const appleIdId = 'apple-history';
  const write = (domain, data, action) => ({ domain, version: store.load(domain).version, data, action });
  const save = (...entries) => store.saveBatch(entries, { actor });
  store.saveBatch([write('settings', { mailboxTypes: [], costSettings: {},
    applePaidPrices: { 'Claude Max': { 'Max 20x': { US: '250' } } } }, 'apple_paid_prices_save')], { actor: { ...actor, role: 'super' } });
  save(write('inventory', { accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [],
      tableSettings: [], undo: [], mailboxes: [
        { id: 'google', email: opened.email, type: 'google', status: '正常', country: opened.country },
        { id: appleIdId, email: 'apple-history@example.test', type: 'apple', status: '正常', health: 'normal',
          appStoreRegion: 'US', appleOpeningBalance: '500' }
      ] }, 'inventory_create'),
    write('commerce', { orders: [], tenants: [tenant], customers: [buyer, other],
      operating: [], rentBatches: [], logs: [] }, '新增资料'));
  store.saveClaudeHistory({ rows: [opened], inventoryVersion: store.load('inventory').version }, actor);
  const { accounts: [account], inventoryVersion, commerceVersion } = store.claudeHistoricalSales();
  const { orderId } = store.saveClaudeHistoricalSale({ inventoryVersion, commerceVersion, accountId: account.id,
    tenantId: tenant.id, customerId: buyer.id, payment: '苹果内购', saleAmount: '2100', saleCurrency: 'CNY',
    actualCostAmount: '1550', actualCostCurrency: 'CNY' }, actor);

  const commerce = store.load('commerce').data;
  const [order] = commerce.orders;
  Object.assign(order, { appleIdId, appleStoreRegion: 'US', paidAmount: '250', paidCurrency: 'USD', paidConfirmed: true,
    financialEvidence: [{ kind: 'payment', payment: '苹果内购', amount: '250', currency: 'USD', cardId: '', at: at.toISOString() }],
    version: 2 });
  const ledger = store.load('appleBalance').data;
  ledger.wallets[0] = { ...ledger.wallets[0], balance: '250', version: 3 };
  ledger.movements.push({ id: 'historical-charge', kind: 'order-charge', appleIdId, orderId, amount: '-250',
    before: '500', after: '250', versionAfter: 3 });
  ledger.allocations.push({ orderId, appleIdId, amount: '250', returned: '0' });
  save(write('commerce', commerce, '更正订单'), write('appleBalance', ledger, 'apple_order_charge'));

  // Reproduce an older imported document that already had the original Apple debit but lacked the buyer.
  const oldCommerce = store.load('commerce');
  delete oldCommerce.data.orders[0].customerId;
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', await readFile(path + '.key'), nonce);
  cipher.setAAD(Buffer.from(`commerce:${oldCommerce.version}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(oldCommerce.data), 'utf8'), cipher.final()]);
  const fixture = new DatabaseSync(path);
  try {
    fixture.prepare('UPDATE business_document SET payload = ? WHERE domain = ?').run(
      Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]), 'commerce');
  } finally {
    fixture.close();
  }

  const beforeBalance = store.load('appleBalance');
  const beforeInventory = store.load('inventory');
  const correction = (snapshot, customerId) => {
    const { corrections, refunds, bankReturns, ...previous } = snapshot.data.orders[0];
    const next = structuredClone(snapshot.data);
    const version = previous.version + 1;
    Object.assign(next.orders[0], { customerId, version, notes: '按原账单补资料', expiry: '2026-12-01T22:00',
      saleAmount: '2150', actualCostAmount: '1560', corrections: [...corrections, {
        id: 'correction-' + version, previous, versionAfter: version, reason: '核对原单和实际买家', actorId: actor.id
      }] });
    return { domain: 'commerce', action: '更正订单', version: snapshot.version, data: next };
  };
  const change = correction(store.load('commerce'), buyer.id);
  const auditCount = store.audit().length;
  const origin = 'https://history.fixture.test';
  const request = Readable.from([Buffer.from(JSON.stringify(change))]);
  Object.assign(request, { method: 'PUT', url: '/api/local/commerce',
    headers: { origin, 'content-type': 'application/json' } });
  let status, response;
  await handleLocalBusiness(request, {
    setHeader() {},
    writeHead(value) { status = value; },
    end(value) { response = JSON.parse(value); }
  }, '/api/local/commerce', store, actor, { publicOrigin: origin });
  assert.equal(status, 200, response?.error);
  const saved = store.load('commerce');
  assert.equal(response.version, saved.version);
  const [after] = saved.data.orders;
  assert.deepEqual([after.id, after.orderNo, after.accountId, after.customerId, after.appleIdId],
    [orderId, order.orderNo, account.id, buyer.id, appleIdId]);
  assert.deepEqual([after.expiry, after.saleAmount, after.actualCostAmount, after.notes],
    ['2026-12-01T22:00', '2150', '1560', '按原账单补资料']);
  assert.deepEqual(after.appleFunding, { region: 'US', expected: '250', bound: true });
  assert.deepEqual(after.financialEvidence, oldCommerce.data.orders[0].financialEvidence);
  assert.equal(after.corrections.at(-1).reason, '核对原单和实际买家');
  assert.deepEqual(after.corrections.at(-1).previous, change.data.orders[0].corrections.at(-1).previous);
  assert.equal(store.audit().length, auditCount + 1);
  assert.throws(() => save(change), { status: 409, message: /已在其他页面更新/ });
  assert.throws(() => save(correction(saved, other.id)), { status: 409, message: /已登记的客户/ });
  assert.deepEqual(store.load('commerce'), saved);
  assert.deepEqual(store.load('appleBalance'), beforeBalance);
  assert.deepEqual(store.load('inventory'), beforeInventory);
  assert.equal(store.audit().length, auditCount + 1);

  store.close();
  store = null;
  store = createLocalBusinessStore(path);
  assert.deepEqual(store.load('commerce'), saved);
  assert.deepEqual(store.load('appleBalance'), beforeBalance);
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
