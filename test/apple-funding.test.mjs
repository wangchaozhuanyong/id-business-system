import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { stageAppleOrderFunding } from '../server/apple-funding.mjs';
import { appleBinding, appleFundingEligibility, appleFundingIndex } from '../frontend/apple-funding.mjs';

const actor = { id: 'apple-test-admin', name: '合成经办人', role: 'admin' };
const settings = { mailboxTypes: [], costSettings: {}, applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20', MY: '24' } } } };
const inventory = (...mailboxes) => ({ mailboxes, accounts: [], batches: [], returnRecords: [], importRecords: [],
  registrationRecords: [], tableSettings: [], undo: [] });
const asset = (id, amount, region = 'US') => ({ id, type: 'apple', email: id + '@example.test',
  status: '正常', health: 'normal', appStoreRegion: region, appleOpeningBalance: amount });
const customers = [{ id: 'one', name: '合成甲' }, { id: 'two', name: '合成乙' }];
const draftOrder = (id, change = {}) => ({
  id, orderNo: id, product: 'Gemini', plan: 'Google AI Pro', subscriptionSeries: 'google_ai',
  businessType: '首次开通', email: 'subscriber@example.test', loginMethod: 'google', customerId: 'one',
  payment: '苹果内购', appleIdId: 'apple-a', appleStoreRegion: 'US', billingChannel: 'app_store',
  billingCycle: 'month', billingCountry: '美国', billingReceipt: '', entitlementStatus: 'pending',
  autoRenew: 'unknown', paidCurrency: 'USD', paidAmount: '', paidConfirmed: false, costBasis: 'standard',
  saleCurrency: 'CNY', saleAmount: '', receiptConfirmed: false, start: '', expiry: '', version: 1,
  refunds: [], bankReturns: [], cancellationEvents: [], ...change
});
const commerce = orders => ({ orders, customers, tenants: [], operating: [], rentBatches: [], logs: [] });
const setup = t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const write = (domain, data, action) => ({ domain, version: store.load(domain).version, data, action });
  const save = (...entries) => store.saveBatch(entries, { actor });
  store.saveBatch([write('settings', settings, 'apple_paid_prices_save')], { actor: { ...actor, role: 'super' } });
  return { store, write, save };
};

test('在原订单补登记实付时同时入账，余额不足时不写入，重试不会多扣', t => {
  const { store, write, save } = setup(t);
  save(write('inventory', inventory(asset('apple-a', '250')), 'inventory_create'));
  const order = draftOrder('old-unposted', { orderNo: 'OD-FIXTURE-APPLE', paidAmount: '250',
    financialEvidence: [{ kind: 'receipt', amount: '2100', currency: 'CNY', at: '2026-10-13T09:30:00Z' }] });
  save(write('commerce', commerce([order]), '新增独立订单'));
  const original = store.load('commerce');
  const ledger = store.load('appleBalance');
  const command = { action: 'record-apple-payment', orderId: order.id, version: 1, amount: '250' };
  assert.throws(() => store.saveOrderCompletion({ ...actor, role: 'employee' }, command), /无权/);
  assert.throws(() => store.saveOrderCompletion(actor, { ...command, version: 0 }), /订单已更新/);
  assert.throws(() => store.saveOrderCompletion(actor, { ...command, amount: '251' }), /余额不足/);
  assert.deepEqual(store.load('commerce'), original);
  assert.deepEqual(store.load('appleBalance'), ledger);

  const saved = store.saveOrderCompletion(actor, command);
  const updated = store.load('commerce');
  const [actual] = updated.data.orders;
  const balance = store.load('appleBalance');
  assert.deepEqual([actual.paidConfirmed, actual.paidAmount, actual.paidCurrency, actual.appleFunding.bound, actual.version],
    [true, '250', 'USD', true, 2]);
  assert.equal(actual.corrections.at(-1).previous.paidConfirmed, false);
  assert.deepEqual(actual.financialEvidence.find(row => row.kind === 'receipt'), order.financialEvidence[0]);
  assert.equal(actual.financialEvidence.find(row => row.kind === 'payment').amount, '250');
  assert.deepEqual(balance.data.allocations.map(row => [row.orderId, row.orderNo, row.appleIdId, row.amount]),
    [[order.id, order.orderNo, 'apple-a', '250']]);
  assert.deepEqual(balance.data.movements.filter(row => row.kind === 'order-charge').map(row =>
    [row.orderId, row.orderNo, row.amount, row.before, row.after]), [[order.id, order.orderNo, '-250', '250', '0.0000']]);
  assert.equal(balance.data.wallets[0].balance, '0.0000');
  assert.deepEqual(store.saveOrderCompletion(actor, { ...command, amount: '250.00' }), saved);
  assert.throws(() => store.saveOrderCompletion(actor, { ...command, amount: '249' }), /已有付款记录/);
  assert.deepEqual(store.load('commerce'), updated);
  assert.deepEqual(store.load('appleBalance'), balance);
});

test('期初余额和苹果 ID 同时提交；充值留痕，重复请求不重复加款', t => {
  const { store, write, save } = setup(t);
  const invalid = write('inventory', inventory(asset('apple-a', '25'), asset('apple-b', '-1')), 'inventory_create');
  assert.throws(() => save(invalid), /期初余额/);
  assert.equal(store.load('inventory').version, 0);
  assert.equal(store.load('appleBalance').version, 0);
  save(write('inventory', inventory(asset('apple-a', '25'), asset('apple-b', '0')), 'inventory_create'));
  const initial = store.load('appleBalance').data;
  assert.deepEqual(initial.wallets.map(w => [w.id, w.balance]), [['apple-a', '25'], ['apple-b', '0']]);
  assert.deepEqual(initial.movements.map(m => [m.kind, m.amount, m.actorId]), [['opening', '25', actor.id]]);
  assert.equal(Object.hasOwn(store.load('inventory').data.mailboxes[0], 'appleOpeningBalance'), false);
  const next = structuredClone(initial);
  next.wallets[0] = { ...next.wallets[0], balance: '35', version: 3 };
  next.movements.push({ id: 'topup-1', appleIdId: 'apple-a', kind: 'topup', amount: '10',
    before: '25', after: '35', versionAfter: 3, reason: '已核对到账' });
  const topup = write('appleBalance', next, 'apple_topup');
  save(topup);
  assert.throws(() => save(topup), /已在其他页面更新/);
  assert.equal(store.load('appleBalance').data.movements.at(-1).actorId, actor.id);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '35');
});

test('按地区预算筛选，占用、取消与正式绑定受事务保护；续费只能使用原 ID', t => {
  const { store, write, save } = setup(t);
  save(write('inventory', inventory(asset('apple-a', '25'), asset('apple-b', '30'), asset('apple-my', '40', 'MY')), 'inventory_create'));
  const first = draftOrder('pending-a');
  const duplicate = draftOrder('pending-b', { email: 'other@example.test', customerId: 'two' });
  save(write('commerce', commerce([first]), '新增独立订单'));
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '25');
  assert.throws(() => save(write('commerce', commerce([first, duplicate]), '新增独立订单')), /占用/);
  assert.throws(() => save(write('commerce', commerce([first, { ...duplicate, email: first.email, appleIdId: 'apple-b', customerId: 'one' }]),
    '新增独立订单')), /已有待付款订单/);
  const pending = store.load('commerce').data.orders[0];
  const cancelled = { ...pending, cancelled: true, version: 2,
    cancellationEvents: [{ id: 'cancel-a', action: '业务撤单', reason: '测试撤单' }] };
  assert.throws(() => save(write('commerce', commerce([cancelled]), '业务撤单')), /未付款/);
  cancelled.cancellationEvents[0].appleUnpaidConfirmed = true;
  save(write('commerce', commerce([cancelled]), '业务撤单'));
  save(write('commerce', commerce([cancelled, duplicate]), '新增独立订单'));
  const ledger = store.load('appleBalance').data;
  const paid = { ...duplicate, paidAmount: '20', paidConfirmed: true,
    billingReceipt: 'fixture-apple-paid', appleGoogleVerified: true, version: 2 };
  assert.throws(() => save(write('commerce', commerce([cancelled, paid]), '更正订单')), /同时保存余额扣款/);
  assert.equal(store.load('commerce').data.orders[1].appleFunding.bound, false);
  ledger.wallets[0] = { ...ledger.wallets[0], balance: '5', version: 3 };
  ledger.movements.push({ id: 'charge-b', appleIdId: 'apple-a', orderId: paid.id, kind: 'order-charge',
    amount: '-20', before: '25', after: '5', versionAfter: 3 });
  ledger.allocations.push({ orderId: paid.id, appleIdId: 'apple-a', amount: '20', returned: '0' });
  save(write('commerce', commerce([cancelled, paid]), '更正订单'), write('appleBalance', ledger, 'apple_order_charge'));
  const persisted = store.load('commerce').data.orders;
  assert.equal(persisted[1].appleFunding.bound, true);
  const renewal = draftOrder('renewal', { businessType: '续费', email: ' OTHER@example.test ', customerId: 'two' });
  const index = appleFundingIndex(persisted, ledger);
  assert.equal(appleBinding(index, renewal).id, 'apple-a');
  assert.equal(appleBinding(index, { ...renewal, customerId: 'one' }).conflict, true);
  assert.equal(appleFundingEligibility({ ...ledger.wallets[0], appStoreRegion: 'US', status: '正常' }, renewal, index, settings).shortage, 150000n);
  assert.match(appleFundingEligibility({ ...ledger.wallets[1], appStoreRegion: 'US', status: '正常' }, renewal, index, settings).error, /原绑定/);
  assert.match(appleFundingEligibility({ ...ledger.wallets[2], appStoreRegion: 'MY', status: '正常' }, duplicate, index, settings).error, /原绑定/);
  const renewForSave = { ...renewal, email: renewal.email.trim() };
  assert.throws(() => save(write('commerce', commerce([...persisted, renewForSave]), '新增独立订单')), /余额不足/);
  ledger.wallets[0] = { ...ledger.wallets[0], balance: '20', version: 4 };
  ledger.movements.push({ id: 'renewal-topup', appleIdId: 'apple-a', kind: 'topup', amount: '15',
    before: '5', after: '20', versionAfter: 4, reason: '已核对充值到账' });
  save(write('appleBalance', ledger, 'apple_topup'));
  save(write('commerce', commerce([...persisted, renewForSave]), '新增独立订单'));
  assert.equal(store.load('commerce').data.orders.at(-1).appleFunding.bound, false);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '20');
});

test('旧流水可识别唯一绑定，冲突或缺少证据时留待核对', () => {
  const original = draftOrder('legacy-a', { paidConfirmed: true, paidAmount: '20', platformAccountId: 'platform-a' });
  const second = { ...original, id: 'legacy-b', appleIdId: 'apple-b' };
  const allocation = (order) => ({ orderId: order.id, appleIdId: order.appleIdId, amount: '20', returned: '0' });
  const renewal = draftOrder('renewal', { businessType: '续费', email: ' SUBSCRIBER@example.test ' });
  assert.equal(appleBinding(appleFundingIndex([original]), renewal).id, '');
  const unresolved = { ...original, paidConfirmed: false, cancelled: true };
  assert.equal(appleFundingIndex([unresolved]).byWallet.get('apple-a').pending.length, 1);
  const known = appleFundingIndex([original], { allocations: [allocation(original)] });
  assert.equal(appleBinding(known, renewal).id, 'apple-a');
  const fromMovement = appleFundingIndex([original], { movements: [{ appleIdId: 'apple-a',
    orderId: original.id, kind: 'order-charge', amount: '-20.00' }] });
  assert.equal(appleBinding(fromMovement, renewal).id, 'apple-a');
  assert.equal(appleBinding(appleFundingIndex([original, second], { allocations: [allocation(original)] }), renewal).conflict, true);
  const ambiguous = appleFundingIndex([original, second], { allocations: [allocation(original), allocation(second)] });
  assert.equal(appleBinding(ambiguous, renewal).conflict, true);
  const divergent = { ...second, appleIdId: 'apple-a', platformAccountId: 'platform-b' };
  assert.equal(appleBinding(appleFundingIndex([original, divergent],
    { allocations: [allocation(original), allocation(divergent)] }), renewal).conflict, true);
});

test('同一平台账号换登录标识仍使用原苹果 ID，死号和未付款占用继续受限', () => {
  const original = draftOrder('original-grok', { product: 'Grok', plan: 'SuperGrok', subscriptionSeries: 'supergrok',
    loginMethod: 'email', email: 'grok-original@example.test', platformAccountId: 'grok-fixture-1',
    paidConfirmed: true, paidAmount: '20', appleFunding: { region: 'US', expected: '20', bound: true } });
  const incoming = draftOrder('new-grok', { product: 'Grok', plan: 'SuperGrok', subscriptionSeries: 'supergrok',
    loginMethod: 'x', email: '', xHandle: '@fixture_grok', platformAccountId: 'grok-fixture-1', appleIdId: 'apple-b' });
  const wallets = [{ id: 'apple-a', balance: '50', currency: 'USD' }, { id: 'apple-b', balance: '50', currency: 'USD' }];
  const ledger = { wallets, allocations: [], movements: [] };
  const resources = inventory({ ...asset('apple-a', '0'), health: 'dead' }, asset('apple-b', '0'));
  const prices = { applePaidPrices: { Grok: { SuperGrok: { US: '20' } } } };
  const index = appleFundingIndex([original], ledger);
  assert.equal(appleBinding(index, incoming).id, 'apple-a');
  const wallet = id => ({ ...wallets.find(row => row.id === id), ...resources.mailboxes.find(row => row.id === id) });
  assert.match(appleFundingEligibility(wallet('apple-b'), incoming, index, prices).error, /原绑定/);
  assert.match(appleFundingEligibility(wallet('apple-a'), incoming, index, prices).error, /状态异常/);
  assert.match(stageAppleOrderFunding([original], [original, { ...incoming }], ledger, resources, prices, '新增订单', customers), /原绑定/);
  assert.match(stageAppleOrderFunding([original], [original, { ...incoming, appleIdId: 'apple-a' }],
    ledger, resources, prices, '新增订单', customers), /状态异常/);
  assert.equal(stageAppleOrderFunding([original], [original, { ...incoming, platformAccountId: 'grok-fixture-2' }],
    ledger, resources, prices, '新增订单', customers), undefined);
  const pending = { ...original, paidConfirmed: false, appleFunding: { ...original.appleFunding, bound: false } };
  assert.match(appleFundingEligibility(wallet('apple-b'), incoming, appleFundingIndex([pending], ledger), prices).error, /已有待付款订单/);
});

test('价目调整不更改占用快照，已核实的实际付款可按原单确认', t => {
  const { store, write, save } = setup(t);
  save(write('inventory', inventory(asset('apple-a', '25'), asset('apple-b', '24')), 'inventory_create'));
  const original = draftOrder('pending');
  save(write('commerce', commerce([original]), '新增独立订单'));
  const changedSettings = { ...settings, applePaidPrices: { Gemini: { 'Google AI Pro': { US: '28' } } } };
  store.saveBatch([write('settings', changedSettings, 'apple_paid_prices_save')], { actor: { ...actor, role: 'super' } });
  const second = draftOrder('new', { appleIdId: 'apple-b', email: 'other@example.test', customerId: 'two' });
  assert.throws(() => save(write('commerce', commerce([original, second]), '新增独立订单')), /余额不足/);
  const third = { ...second, appleStoreRegion: 'MY' };
  assert.match(appleFundingEligibility({ id: 'unpriced', currency: 'USD', appStoreRegion: 'MY',
    status: '正常', balance: '100' }, third, appleFundingIndex([]), changedSettings).error, /配置/);
  const updated = { ...store.load('commerce').data.orders[0], version: 2, paidAmount: '22' };
  save(write('commerce', commerce([updated]), '更正订单'));
  assert.equal(store.load('commerce').data.orders[0].appleFunding.expected, '20');
  const paid = { ...store.load('commerce').data.orders[0], version: 3, paidAmount: '23', paidConfirmed: true,
    billingReceipt: 'fixture-settled', appleGoogleVerified: true };
  const ledger = store.load('appleBalance').data;
  ledger.wallets[0] = { ...ledger.wallets[0], balance: '2', version: 3 };
  ledger.movements.push({ id: 'price-change-charge', appleIdId: 'apple-a', orderId: paid.id, kind: 'order-charge',
    amount: '-23', before: '25', after: '2', versionAfter: 3 });
  ledger.allocations.push({ orderId: paid.id, appleIdId: 'apple-a', amount: '23', returned: '0' });
  const orderWrite = write('commerce', commerce([paid]), '更正订单');
  const ledgerWrite = write('appleBalance', ledger, 'apple_order_charge');
  save(orderWrite, ledgerWrite);
  assert.throws(() => save(orderWrite, ledgerWrite), /已在其他页面更新/);
  const result = store.load('commerce').data.orders[0];
  assert.deepEqual(result.appleFunding, { region: 'US', expected: '20', bound: true });
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '2');
});
