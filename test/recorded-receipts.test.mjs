import assert from 'node:assert/strict';
import test from 'node:test';
import { orderReceiptRecorded, manualOrderDetailsMissing } from '../frontend/order-opening.mjs';
import { calculateConfirmedNetReceipt, calculateOrder, createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { checkOrderFinancialHistory } from '../server/local-business-integrity.mjs';
import { readOrderCompletion } from '../server/order-completion.mjs';

const legacy = (changes = {}) => ({
  id: 'synthetic-legacy', orderNo: 'SYN-RECEIPT', source: '管理员手工', product: 'Claude Pro',
  businessType: '续费', customerId: 'customer', email: 'receipt@example.test',
  payment: '银行卡', saleAmount: '190', saleCurrency: 'CNY', receiptConfirmed: false,
  paidAmount: '21.13', paidCurrency: 'USD', paidConfirmed: false,
  costBasis: 'actual', actualCostAmount: '160', actualCostCurrency: 'CNY', costSettings: { version: 2 },
  start: '2026-11-08T02:32', expiry: '2026-12-08T00:00', refunds: [], bankReturns: [], ...changes
});

test('手工和历史订单的有效实收不再依赖旧确认标记', () => {
  for (const source of ['管理员手工', '历史入库', undefined]) {
    for (const receiptConfirmed of [false, undefined, true]) {
      const order = legacy({ source, receiptConfirmed });
      const before = structuredClone(order);
      assert.equal(orderReceiptRecorded(order), true);
      assert.equal(calculateConfirmedNetReceipt(order), '190.0000');
      assert.deepEqual(order, before, '兼容旧单只读取原金额，不改写财务记录');
    }
  }
});

test('明确零金额可登记，空值和无效金额币种仍是缺项', () => {
  assert.equal(orderReceiptRecorded(legacy({ saleAmount: '0' })), true);
  assert.equal(calculateConfirmedNetReceipt(legacy({ saleAmount: '0' })), '0.0000');
  for (const saleAmount of ['', undefined, null, '-1', 'NaN', '1.00001']) {
    const order = legacy({ saleAmount, receiptConfirmed: true });
    assert.equal(orderReceiptRecorded(order), false);
    assert.equal(calculateConfirmedNetReceipt(order), null);
  }
  for (const saleCurrency of ['', undefined, 'cny', '人民币']) {
    assert.equal(orderReceiptRecorded(legacy({ saleCurrency })), false);
    assert.equal(calculateConfirmedNetReceipt(legacy({ saleCurrency })), null);
  }
});

test('自动代充的配置售价仍需实际录入收款', () => {
  for (const receiptConfirmed of [false, undefined]) {
    const order = legacy({ source: '线上代充', receiptConfirmed });
    assert.equal(orderReceiptRecorded(order), false);
    assert.equal(calculateConfirmedNetReceipt(order), null);
  }
  assert.equal(calculateConfirmedNetReceipt(legacy({ source: '线上代充', receiptConfirmed: true })), '190.0000');
});

test('旧单实收参与净收款和利润，代付与汇率的真实缺项独立保留', () => {
  const order = legacy({ paidConfirmed: true, refunds: [{ amount: '20', currency: 'CNY' }] });
  assert.equal(calculateConfirmedNetReceipt(order), '170.0000');
  assert.equal(calculateOrder(order).profit, '10.0000');
  assert.equal(calculateConfirmedNetReceipt(order, { currency: 'MYR' }), null);
  assert.equal(calculateConfirmedNetReceipt(legacy()), '190.0000');
  const pending = legacy();
  const clock = Date.parse('2026-11-13T00:00:00Z');
  pending.fxSnapshot = createOrderSnapshot({ source: '合成历史报价',
    at: '2026-11-07T00:00', expiresAt: '2026-11-09T00:00', rates: { USD: '7', MYR: '1.6' }
  }, pending, clock);
  assert.equal(calculateOrder(pending, { clock }).profit, '30.0000');
  const missingPayment = calculateOrder({ ...pending, paidAmount: '' }, { clock });
  assert.equal(missingPayment.profit, '30.0000');
  assert.equal(calculateConfirmedNetReceipt(legacy({ cancelled: true })), null);
  assert.equal(calculateConfirmedNetReceipt(legacy({ draft: true })), null);
});

test('旧确认标记不再制造补全任务或全额实收勾选', () => {
  const order = legacy({ source: '历史入库', businessType: '成品交付', accountId: 'account' });
  assert.equal(manualOrderDetailsMissing(order, [{ id: 'customer' }]).receipt, undefined);
  const result = readOrderCompletion({ orders: [order], customers: [{ id: 'customer' }] }, {},
    { id: 'admin', role: 'admin' }, new URLSearchParams(), () => []);
  assert.ok(!result.manualItems[0].missing.includes('实际代付'));
  assert.ok(!result.manualItems[0].missing.includes('客户实收'));
});

test('已录入实收允许登记实际退款，同时保留超额和财务历史保护', () => {
  const order = legacy({ paidAmount: '' });
  const previous = { orders: [order] };
  const refund = { id: 'refund', amount: '20', currency: 'CNY', payment: '银行卡' };
  const next = { orders: [{ ...order, refunds: [refund] }] };
  assert.equal(checkOrderFinancialHistory(previous, next), undefined);
  assert.match(checkOrderFinancialHistory(previous, { orders: [] }), /必须保留/);
  assert.match(checkOrderFinancialHistory(previous, { orders: [{ ...order, cancelled: true }] }), /必须保留/);
  assert.match(checkOrderFinancialHistory(previous, { orders: [{ ...order, saleAmount: '' }] }), /财务事实/);
  assert.match(checkOrderFinancialHistory(previous, {
    orders: [{ ...order, refunds: [{ ...refund, amount: '191' }] }]
  }), /不得超过/);
  assert.match(checkOrderFinancialHistory(next, previous), /退款记录必须保留/);
});
