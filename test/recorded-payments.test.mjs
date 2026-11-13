import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCardIssueAllocations, calculateOrder, createOrderSnapshot, hasRecordedPaymentAmount
} from '../modules/finance/accounting.mjs';
import { demoClock, demoOrders } from '../server/finance/reconcile-demo.mjs';
import { reconcileOrders } from '../server/finance/reconcile-orders.mjs';
import { readOrderCompletion } from '../server/order-completion.mjs';
import { checkBankReturns, checkOrderFinancialHistory } from '../server/local-business-integrity.mjs';

const clock = Date.parse('2026-11-13T00:00:00Z');
const rules = { version: 1, appleDiscount: '0.8', claudeBankFeeMyr: '0', claudeAccountCostMyr: '0',
  cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' };
function legacy(changes = {}) {
  const order = {
    id: 'synthetic-payment', orderNo: 'SYN-PAYMENT', source: '管理员手工', product: 'Claude Pro', cardTypeId: 'card-type-real',
    businessType: '续费', customerId: 'customer', email: 'payment@example.test', payment: '银行卡',
    start: '2026-11-08T02:32', expiry: '2026-12-08T00:00',
    paidAmount: '21.13', paidCurrency: 'USD', paidConfirmed: false,
    saleAmount: '190', saleCurrency: 'CNY', receiptConfirmed: false,
    costBasis: 'standard', costSettings: { ...rules }, refunds: [], bankReturns: [], ...changes
  };
  if (!Object.hasOwn(changes, 'fxSnapshot')) order.fxSnapshot = createOrderSnapshot({
    source: '合成核算凭据', at: '2026-11-08T00:00', expiresAt: '2026-11-09T00:00',
    rates: { USD: '7', MYR: '1.6' }
  }, order, clock);
  return order;
}
const calculate = (order, options = {}) => calculateOrder(order, { clock, ...options });

test('手工及历史代付按有效原金额核算，不依赖旧标记也不回写财务记录', () => {
  for (const source of ['管理员手工', '历史入库', undefined]) {
    for (const paidConfirmed of [false, undefined, true]) {
      const order = legacy({ source, paidConfirmed });
      const before = structuredClone(order);
      assert.equal(hasRecordedPaymentAmount(order), true);
      const result = calculate(order);
      assert.equal(result.status, 'ready');
      assert.equal(result.netCost, '147.9100');
      assert.equal(result.profit, '42.0900');
      assert.equal(result.requiresPaymentConfirmation, false);
      assert.deepEqual(order, before);
    }
  }
});

test('真正缺少代付金额或币种时保留具体缺项', () => {
  for (const changes of [
    ...['', undefined, null, '0', '-1', 'NaN', '21.13001'].map(paidAmount => ({ paidAmount })),
    ...['', undefined, 'usd', '美元'].map(paidCurrency => ({ paidCurrency }))
  ]) {
    const order = legacy({ paidConfirmed: true, ...changes });
    assert.equal(hasRecordedPaymentAmount(order), false);
    const result = calculate(order);
    assert.equal(result.status, 'pending');
    assert.equal(result.requiresPaymentConfirmation, true);
    assert.match(result.reason, /缺少已登记的代付金额或币种/);
  }
});

test('原单缺汇率只报告真实汇率缺项，同币实际总成本可以直接核算', () => {
  const order = legacy({ fxSnapshot: null });
  const result = calculate(order);
  assert.equal(result.status, 'pending');
  assert.equal(result.requiresPaymentConfirmation, false);
  assert.match(result.reason, /缺少有效汇率快照/);
  assert.equal(calculate({ ...order, costBasis: 'actual', actualCostAmount: '160',
    actualCostCurrency: 'CNY' }).profit, '30.0000');
});

test('自动代充的预填金额不代表实际扣款，实收也必须来自实际记录', () => {
  for (const paidConfirmed of [false, undefined]) {
    const order = legacy({ source: '线上代充', paidConfirmed, receiptConfirmed: true });
    assert.equal(hasRecordedPaymentAmount(order), false);
    assert.match(calculate(order).reason, /自动代充尚未取得实际扣款结果/);
  }
  const order = legacy({ source: '线上代充', paidConfirmed: true, receiptConfirmed: true });
  assert.equal(calculate(order).profit, '42.0900');
  assert.match(calculate({ ...order, receiptConfirmed: false }).reason, /收款金额/);
});

test('Apple 只按匹配的实际回款抵扣，已登记代付可计算', () => {
  const order = legacy({ payment: '苹果内购', appleIdId: 'synthetic-apple' });
  const appleLedger = { orderId: order.id, appleIdId: order.appleIdId, amount: '21.13', returned: '0' };
  for (const ledger of [undefined, { ...appleLedger, amount: '20' },
    { ...appleLedger, appleIdId: 'another-apple' }, { ...appleLedger, orderId: 'another-order' }]) {
    const result = calculate(order, { appleLedger: ledger });
    assert.equal(result.requiresPaymentConfirmation, false);
    assert.match(result.appleLedgerNote, /Apple 扣款或回款未匹配/);
    assert.equal(result.profit, '71.6720');
  }
  const before = structuredClone({ order, appleLedger });
  assert.equal(calculate(order, { appleLedger }).profit, '71.6720');
  assert.deepEqual({ order, appleLedger }, before);
});

test('同卡已登记旧单参加开卡费分摊，缺金额和草稿不冒充已付款', () => {
  const a = legacy({ id: 'a', product: 'GPT', cardTypeId: '', cardId: 'synthetic-card',
    issueFeeSnapshot: { applied: true, cardId: 'synthetic-card', amountUsd: '0.5' } });
  const b = { ...a, id: 'b', issueFeeSnapshot: { applied: false, cardId: a.cardId } };
  const empty = { ...b, id: 'empty', paidAmount: '' };
  const draft = { ...b, id: 'draft', draft: true };
  const allocations = buildCardIssueAllocations([a, b, empty, draft], { clock });
  assert.equal(allocations.get(a.id).count, 2);
  assert.equal(allocations.get(a.id).amountUsd, '0.2500');
  assert.equal(allocations.get(b.id).amountUsd, '0.2500');
  assert.equal(allocations.get(empty.id).status, 'pending');
  assert.equal(allocations.has(draft.id), false);
});

test('对账和资料补全采用同一已登记金额口径，原单保持不变', () => {
  const input = demoOrders();
  const baseline = reconcileOrders(input, { clock: demoClock });
  const bank = input.commerce.orders.find(order => order.id === 'QA-BANK');
  bank.paidConfirmed = false;
  bank.receiptConfirmed = false;
  const before = structuredClone(input);
  const report = reconcileOrders(input, { clock: demoClock });
  assert.deepEqual(report.counts, baseline.counts);
  const result = report.orders.find(order => order.orderId === bank.id);
  assert.equal(result.calculations.CNY.profit, '73.2400');
  assert.doesNotMatch(result.pendingReasons.join(), /代付待确认|实收待确认|缺少已登记/);
  assert.deepEqual(input, before);
  const completed = readOrderCompletion({ orders: [legacy()], customers: [{ id: 'customer' }] }, {},
    { id: 'admin', role: 'admin' }, new URLSearchParams(), () => []);
  assert.ok(!completed.manualItems[0].missing.includes('实际代付'));
  assert.ok(!completed.manualItems[0].missing.includes('客户实收'));
});

test('已登记代付保留回款上限和历史保护，不允许旧标记绕过', () => {
  const order = legacy({ saleAmount: '0', cardId: 'synthetic-card' });
  const previous = { orders: [order] };
  const returned = { id: 'return', amount: '1', currency: 'USD', cardId: order.cardId };
  const next = { orders: [{ ...order, bankReturns: [returned] }] };
  assert.equal(checkBankReturns(previous, next), undefined);
  assert.match(checkBankReturns(previous, { orders: [{ ...order,
    bankReturns: [{ ...returned, amount: '21.1301' }] }] }), /不得超过/);
  assert.match(checkBankReturns(next, previous), /必须保留/);
  assert.match(checkBankReturns(previous, { orders: [{ ...next.orders[0], source: '线上代充' }] }), /不得超过/);
  assert.match(checkOrderFinancialHistory(previous, { orders: [] }), /必须保留/);
  assert.match(checkOrderFinancialHistory(previous, { orders: [{ ...order, cancelled: true }] }), /必须保留/);
  assert.match(checkOrderFinancialHistory(previous, { orders: [{ ...order, paidAmount: '' }] }), /财务事实/);
});
