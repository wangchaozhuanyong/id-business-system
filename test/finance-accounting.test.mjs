import assert from 'node:assert/strict';
import test from 'node:test';
import {
  calculateConfirmedNetReceipt, calculateOrder, createManualSnapshot, createOrderSnapshot, snapshotAction
} from '../modules/finance/accounting.mjs';
import { checkFinanceSnapshots } from '../server/finance/snapshot-integrity.mjs';

const clock = Date.parse('2026-11-05T05:00:00Z');
const orderAt = '2026-11-04T10:30';
const quote = {
  source: '银行账单凭据 TEST-01',
  at: '2026-11-04T09:00',
  expiresAt: '2026-11-04T12:00',
  rates: { MYR: '1.6', USD: '7.2', PHP: '0.125', CLP: '0.0075', IDR: '0.00045' }
};
const rules = {
  version: 1, appleDiscount: '0.8', claudeBankFeeMyr: '100', claudeAccountCostMyr: '50',
  cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5'
};
const bank = () => ({
  id: 'order-01', version: 1, product: 'GPT', payment: '银行卡',
  paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
  start: orderAt, costBasis: 'standard', costSettings: structuredClone(rules),
  issueFeeSnapshot: { applied: true, amountUsd: '0.5' },
  refunds: [], bankReturns: []
});
const calculate = (order, options) => calculateOrder(order, { clock, ...options });

test('实付替换 KYC 和另扣换汇费按原单快照复算，旧凭据和作废凭据保留原口径', () => {
  const order = { ...bank(), product: 'Claude Pro', paidConfirmed: true };
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  const kyc = { id: 'kyc-a', orderId: order.id, category: 'kyc', chargedOn: '2026-11-04',
    amount: '20', currency: 'MYR', settlementAmount: '32.12', settlementCurrency: 'CNY',
    source: '合成机构', reference: 'KYC-A', accountingMode: 'replace-kyc' };
  const fx = { id: 'fx-a', orderId: order.id, category: 'fx-fee', chargedOn: '2026-11-04',
    amount: '1.25', currency: 'CNY', accountingMode: 'add-fx' };
  const expenseReceipts = [kyc, fx, { ...fx, id: 'fx-b', amount: '2.3' }];
  assert.equal(calculate(order).netCost, '365.0000');
  assert.equal(calculate(order, { expenseReceipts: [{ ...kyc, accountingMode: undefined }] }).netCost, '365.0000');
  assert.equal(calculate(order, { expenseReceipts: [{ ...kyc, voidedAt: quote.expiresAt }] }).netCost, '365.0000');
  const result = calculate(order, { expenseReceipts });
  assert.equal(result.netCost, '320.6700');
  assert.equal(result.profit, '-70.6700');
  assert.equal(result.basis, 'reference');
  assert.equal(result.items.find(item => item.key === 'kyc').expenseReceipt.reference, 'KYC-A');
  assert.equal(result.items.filter(item => item.key === 'fx-fee').length, 2);
  assert.equal(calculate(order, { expenseReceipts, currency: 'MYR' }).netCost, '200.4188');
  assert.match(calculate(order, { expenseReceipts: [...expenseReceipts, { ...fx, currency: 'EUR' }] }).reason, /EUR 汇率/);
  assert.match(calculate(order, { expenseReceipts: [kyc, { ...kyc, id: 'second-kyc' }] }).reason, /已有一笔/);
});

test('已含费用从实际总成本拆出，独立费用加计且不改变 Apple 的可收回成本', () => {
  const order = { ...bank(), product: 'Claude Max', payment: '苹果内购', paidConfirmed: true,
    appleIdId: 'apple-a', paidAmount: '3', paidCurrency: 'USD', costBasis: 'actual',
    actualCostAmount: '20', actualCostCurrency: 'MYR', appleRecoverableCostAmount: '10' };
  order.fxSnapshot = createOrderSnapshot({ ...quote, basis: 'settlement' }, order, clock);
  const appleLedger = { orderId: order.id, appleIdId: order.appleIdId, amount: '3', returned: '1' };
  const included = { id: 'kyc-a', orderId: order.id, category: 'kyc', chargedOn: '2026-11-04',
    amount: '1', currency: 'USD', settlementAmount: '4', settlementCurrency: 'MYR', accountingMode: 'included' };
  const fx = { ...included, id: 'fx-a', category: 'fx-fee', amount: '2', currency: 'CNY',
    settlementAmount: undefined, settlementCurrency: undefined, accountingMode: 'add-fx' };
  const baseline = calculate(order, { appleLedger });
  const separated = calculate(order, { appleLedger, expenseReceipts: [included] });
  assert.equal(separated.netCost, baseline.netCost);
  assert.equal(separated.items.find(row => row.key === 'actual-total').amount, '25.6000');
  assert.equal(separated.items.find(row => row.key === 'kyc').amount, '6.4000');
  const result = calculate(order, { appleLedger, expenseReceipts: [included, fx] });
  assert.equal(result.basis, 'actual');
  assert.equal(result.netCost, '28.6667');
  assert.equal(result.recoveredCost, baseline.recoveredCost);
  assert.match(calculate(order, { appleLedger, expenseReceipts: [{ ...included, settlementAmount: '21' }] }).reason,
    /超过原单实际总成本/);
  assert.match(calculate(order, { appleLedger, expenseReceipts: [{ ...included, settlementCurrency: 'CNY' }] }).reason,
    /同币种的账单金额/);
});

test('历史费用、汇率按订单冻结；统计币种切换使用每笔原快照', () => {
  const order = bank();
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  const later = { ...quote, rates: { ...quote.rates, MYR: '2', PHP: '0.2' } };
  const second = bank();
  second.fxSnapshot = createOrderSnapshot(later, second, clock);
  assert.equal(order.fxSnapshot.at, '2026-11-04T01:00:00.000Z');
  assert.equal(order.fxSnapshot.basisAt, '2026-11-04T02:30:00.000Z');
  assert.equal(calculate(order).originalCost, '131.7600');
  assert.equal(calculate(order).profit, '118.2400');
  assert.equal(calculate(order, { currency: 'MYR' }).profit, '73.9000');
  assert.equal(calculate(second, { currency: 'MYR' }).profit, '21.3200');
  second.costSettings.cardPercent = '0.04';
  assert.equal(calculate(order).profit, '118.2400');
  assert.equal(calculate(order, { clock: Date.parse('2027-01-01') }).profit, '118.2400');
});

test('银行卡部分退款与实际回款独立，按代付币种回收且保留手续费', () => {
  const order = bank();
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  order.refunds.push({ amount: '50', currency: 'CNY' }, { amount: '20', currency: 'CNY' });
  assert.equal(calculate(order).profit, '48.2400');
  order.bankReturns.push({ amount: '200', currency: 'PHP' });
  assert.equal(calculate(order).revenue, '180.0000');
  assert.equal(calculate(order).recoveredCost, '25.0000');
  assert.equal(calculate(order).netCost, '106.7600');
  assert.equal(calculate(order).profit, '73.2400');
  order.bankReturns[0].currency = 'USD';
  assert.match(calculate(order).reason, /银行卡回款币种/);
});

test('确认净收款不等利润，同币种无汇率也统计，跨币种只采用原单有效快照', () => {
  const order = { ...bank(), paidConfirmed: false, receiptConfirmed: true,
    refunds: [{ amount: '70', currency: 'CNY' }] };
  const receipt = (row, currency = 'CNY') => calculateConfirmedNetReceipt(row, { clock, currency });
  assert.equal(receipt(order), '180.0000');
  assert.equal(receipt(order, 'MYR'), null);
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  assert.equal(receipt(order, 'MYR'), '112.5000');
  assert.equal(receipt({ ...order, start: '2026-11-04T13:00' }, 'MYR'), null);
  assert.equal(receipt({ ...order, receiptConfirmed: false }), '180.0000');
  assert.equal(receipt({ ...order, source: '线上代充', receiptConfirmed: false }), null);
  assert.equal(receipt({ ...order, cancelled: true }), null);
  assert.equal(receipt({ ...order, refunds: undefined }), null);
  assert.equal(receipt({ ...order, refunds: [{ amount: '251', currency: 'CNY' }] }), null);
  assert.equal(receipt({ ...order, refunds: [{ amount: '250', currency: 'CNY' }] }), '0.0000');
});

const historicalClaudeSale = fields => ({
  ...bank(), product: 'Claude Max', source: '历史入库', businessType: '成品交付', accountId: 'claude-stock',
  paidAmount: '', paidCurrency: '', paidConfirmed: false, receiptConfirmed: true, entitlementStatus: 'active',
  saleAmount: '1500', costBasis: 'actual', actualCostAmount: '1350', actualCostCurrency: 'CNY', ...fields
});

test('Claude 历史成品销售按人民币实收和实际总成本核算，计入已终止的原单', () => {
  const orders = [
    historicalClaudeSale(),
    historicalClaudeSale({ payment: '苹果内购' }),
    historicalClaudeSale({ saleAmount: '2100', actualCostAmount: '1550', subscriptionEnded: true }),
    historicalClaudeSale({ saleAmount: '2100', actualCostAmount: '1600' })
  ];
  const results = orders.map(order => calculate(order));
  assert.ok(results.every(row => row.status === 'ready' && row.basis === 'actual' && !row.requiresPaymentConfirmation));
  assert.deepEqual(results.map(row => row.profit), ['150.0000', '150.0000', '550.0000', '500.0000']);
  assert.equal(results.reduce((total, row) => total + Number(row.profit), 0), 1350);
});

test('Claude 历史实账使用同币凭据，额外外币费用才需要原单汇率', () => {
  const order = historicalClaudeSale();
  const included = { orderId: order.id, category: 'kyc', chargedOn: '2026-11-04',
    amount: '20', currency: 'CNY', accountingMode: 'included' };
  const extra = { ...included, category: 'fx-fee', amount: '2.25', accountingMode: 'add-fx' };
  const result = calculate(order, { expenseReceipts: [included, extra] });
  assert.equal(result.profit, '147.7500');
  assert.equal(result.items.find(row => row.key === 'actual-total').amount, '1330.0000');
  assert.equal(result.requiresPaymentConfirmation, false);
  const foreign = { ...extra, amount: '1', currency: 'MYR' };
  assert.match(calculate(order, { expenseReceipts: [foreign] }).reason, /缺少有效汇率快照/);
  order.fxSnapshot = createOrderSnapshot({ ...quote, basis: 'settlement' }, order, clock);
  assert.equal(calculate(order, { expenseReceipts: [foreign] }).profit, '148.4000');
});

test('历史成品销售扣除客户退款，跨币种和渠道回款使用原单汇率及代付', () => {
  const order = historicalClaudeSale({ refunds: [{ amount: '50', currency: 'CNY' }] });
  assert.equal(calculate(order).profit, '100.0000');
  assert.match(calculate(order, { currency: 'MYR' }).reason, /缺少有效汇率快照/);
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  assert.equal(calculate(order, { currency: 'MYR' }).profit, '62.5000');
  assert.equal(calculate(order).basis, 'actual');
  assert.match(calculate({ ...order, refunds: [{ amount: '1501', currency: 'CNY' }] }).reason, /客户退款超过原实收/);
  assert.match(calculate(historicalClaudeSale({ businessType: '续费' })).reason, /缺少有效汇率快照/);

  const withReturn = historicalClaudeSale({ paidAmount: '100', paidCurrency: 'USD', paidConfirmed: true,
    bankReturns: [{ amount: '10', currency: 'USD' }] });
  assert.match(calculate(withReturn).reason, /缺少有效汇率快照/);
  withReturn.fxSnapshot = createOrderSnapshot(quote, withReturn, clock);
  assert.equal(calculate(withReturn).profit, '222.0000');
  const apple = historicalClaudeSale({ payment: '苹果内购', appleIdId: 'linked-apple',
    paidConfirmed: true, paidAmount: '100', paidCurrency: 'USD' });
  apple.fxSnapshot = createOrderSnapshot(quote, apple, clock);
  assert.match(calculate(apple).reason, /Apple 实际扣款及回款台账待核对/);
});

test('Claude Apple 待回款不计收益，实际到账按折扣回收并保留邮箱成本', () => {
  const order = {
    ...bank(), product: 'Claude Pro', payment: '苹果内购', appleIdId: 'apple-a',
    paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', saleAmount: '240',
    emailCostAmount: '15', emailCostCurrency: 'CNY',
    refunds: [{ id: 'refund-a', amount: '100', currency: 'CNY', appleAmount: '7' }]
  };
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  const ledger = { orderId: order.id, appleIdId: 'apple-a', amount: '20', returned: '0' };
  assert.equal(calculate(order).status, 'pending', '没有实际扣款证据时不能核算');
  assert.equal(calculate(order, { appleLedger: ledger }).profit, '9.8000');
  ledger.returned = '7';
  const result = calculate(order, { appleLedger: ledger });
  assert.equal(result.revenue, '140.0000');
  assert.equal(result.recoveredCost, '40.3200');
  assert.equal(result.netCost, '89.8800');
  assert.equal(result.profit, '50.1200');
  assert.equal(calculate(order, { appleLedger: { ...ledger, amount: '21' } }).status, 'pending');
});

test('实际 Apple 成本按明确可收回部分分摊，精确小数到最后才舍入', () => {
  const order = {
    ...bank(), payment: '苹果内购', appleIdId: 'apple-a', paidConfirmed: true,
    paidAmount: '3', paidCurrency: 'USD', costBasis: 'actual',
    actualCostAmount: '20', actualCostCurrency: 'MYR'
  };
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  const appleLedger = { orderId: order.id, appleIdId: order.appleIdId, amount: '3', returned: '1' };
  assert.match(calculate(order, { appleLedger }).reason, /可按 Apple 面额比例收回/);
  order.appleRecoverableCostAmount = '10';
  assert.equal(calculate(order, { appleLedger }).recoveredCost, '5.3333');
  assert.equal(calculate(order, { appleLedger, currency: 'MYR' }).recoveredCost, '3.3333');
  order.appleRecoverableCostAmount = '0';
  assert.equal(calculate(order, { appleLedger }).recoveredCost, '0.0000');
  order.appleRecoverableCostAmount = '30';
  assert.match(calculate(order, { appleLedger }).reason, /不得大于/);
});

test('缺失、失效、未来、非法或演示汇率都不能参与核算', () => {
  const order = bank();
  order.rates = quote.rates; // Historical demo/legacy maps carry no verified provenance.
  assert.match(calculate(order).reason, /缺少有效汇率/);
  const incomplete = { ...quote, rates: { MYR: '1.6', USD: '7.2' } };
  assert.throws(() => createOrderSnapshot(incomplete, order, clock), /PHP/);
  order.fxSnapshot = createManualSnapshot(incomplete, orderAt, clock);
  assert.match(calculate(order).reason, /缺少 PHP 汇率/);
  const expired = { ...quote, expiresAt: orderAt };
  assert.throws(() => createOrderSnapshot(expired, order, clock), /过期/);
  assert.throws(() => createManualSnapshot(quote, orderAt, Date.parse('2026-11-01')), /时点/);
  assert.throws(() => createManualSnapshot({ ...quote, source: '固定演示值' }, orderAt, clock), /演示/);
  assert.throws(() => createManualSnapshot({ ...quote, rates: { MYR: 1.6 } }, orderAt, clock), /十进制/);
  assert.throws(() => createManualSnapshot({ ...quote, at: '2026-02-30T09:00' }, orderAt, clock), /时点/);
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  order.start = '2026-11-04T12:00';
  assert.match(calculate(order).reason, /更正后的订阅时间/);
});

test('CLP、IDR 等原币可核算，大额和四位尾数不发生浮点丢失', () => {
  const order = {
    ...bank(), paidAmount: '1000', paidCurrency: 'IDR', saleCurrency: 'CLP', saleAmount: '1000',
    costBasis: 'actual', actualCostAmount: '1000', actualCostCurrency: 'IDR'
  };
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  assert.equal(calculate(order).profit, '7.0500');
  order.saleCurrency = 'CNY';
  order.saleAmount = '9007199254740993.0001';
  assert.equal(calculate(order).profit, '9007199254740992.5501');
});

test('服务端契约仅接受独立登记动作、有效快照与原订单版本，拒绝覆盖和混写', () => {
  const order = bank();
  const previous = { orders: [order], logs: [], customers: [] };
  const write = { action: snapshotAction, clock };
  const add = (snapshot) => ({ ...previous,
    logs: [{ id: 'audit-a', type: snapshotAction, entityId: order.id }], orders: [{ ...order, version: 2, fxSnapshot: snapshot,
    updatedAt: '2026-11-05 12:00', updatedBy: '测试操作员', updatedById: 'tester'
  }] });
  const next = add(createOrderSnapshot(quote, order, clock));
  assert.equal(checkFinanceSnapshots(previous, next, write), '');
  assert.match(checkFinanceSnapshots(previous, { ...next, logs: [] }, write), /操作记录/);
  assert.match(checkFinanceSnapshots(previous, next, { clock }), /汇率登记操作/);
  assert.match(checkFinanceSnapshots(previous, {
    ...next, orders: [{ ...next.orders[0], paidAmount: '500' }]
  }, write), /不可同时修改/);
  assert.match(checkFinanceSnapshots(previous, add({ ...next.orders[0].fxSnapshot,
    basisAt: '2026-11-04T01:00:00.000Z'
  }), write), /格式/);
  assert.match(checkFinanceSnapshots(next, previous, { clock }), /不可覆盖或删除/);
  const changedRules = structuredClone(next);
  changedRules.orders[0].costSettings.cardPercent = '0.02';
  assert.match(checkFinanceSnapshots(next, changedRules, { clock }), /费用规则快照/);
  const refund = structuredClone(next);
  refund.orders[0].refunds.push({ amount: '30', currency: 'CNY' });
  assert.equal(checkFinanceSnapshots(next, refund, { action: '退款登记', clock }), '');
});
