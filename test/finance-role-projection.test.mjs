import assert from 'node:assert/strict';
import test from 'node:test';
import { financeCommerce } from '../server/access-roles.mjs';
import { calculateOrder, createOrderSnapshot } from '../modules/finance/accounting.mjs';

const clock = Date.parse('2026-11-05T05:00:00Z');
function sample(overrides = {}) {
  const order = { id: 'synthetic-projection-order', version: 1, product: 'Claude Pro', plan: 'Pro',
    source: '管理员手工', businessType: '新开', payment: '银行卡', paidConfirmed: true, receiptConfirmed: true,
    paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '500', saleCurrency: 'CNY',
    start: '2026-11-04T10:30', expiry: '2026-12-04T10:30', entitlementStatus: 'active',
    costBasis: 'standard', cardTypeId: 'card-type-real', cardTypeName: '真实卡', kyc: true,
    costSettings: { version: 1, appleDiscount: '0.8', claudeBankFeeMyr: '100', claudeAccountCostMyr: '50',
      cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' },
    refunds: [], bankReturns: [], ...overrides };
  order.fxSnapshot = createOrderSnapshot({ source: 'Synthetic quote', at: '2026-11-04T09:00',
    expiresAt: '2026-11-04T12:00', rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' } }, order, clock);
  return order;
}
const projected = order => financeCommerce({ version: 1, data: { orders: [order] } }).data.orders[0];
const calculate = order => calculateOrder(order, { clock });

test('DA-F05: finance projection preserves KYC cost and profit for the same order', () => {
  const order = sample(), before = structuredClone(order), view = projected(order);
  const full = calculate(order), finance = calculate(view);
  assert.equal(full.status, 'ready'); assert.equal(finance.status, 'ready');
  // Independent arithmetic: 1000 PHP x .125 + 100 MYR x 1.6 + 50 MYR x 1.6 = 365 CNY.
  assert.equal(full.netCost, '365.0000'); assert.equal(full.profit, '135.0000');
  assert.equal(finance.netCost, '365.0000'); assert.equal(finance.profit, '135.0000');
  assert.equal(view.kyc, true); assert.deepEqual(order, before);
});

test('DA-F05: preserves real card classification without a display name', () => {
  const order = sample({ cardTypeName: undefined, kyc: false });
  assert.equal(calculate(order).status, 'ready'); assert.equal(calculate(order).netCost, '285.0000');
  const finance = calculate(projected(order));
  assert.equal(finance.status, 'ready'); assert.equal(finance.netCost, '285.0000');
});

test('control: actual total cost remains equal after finance projection', () => {
  const order = sample({ costBasis: 'actual', actualCostAmount: '123.45', actualCostCurrency: 'CNY' });
  const full = calculate(order), finance = calculate(projected(order));
  assert.equal(full.netCost, '123.4500'); assert.equal(finance.netCost, full.netCost);
  assert.equal(finance.profit, full.profit);
});

test('a masked manual card retains an unknown classification instead of becoming a cardless one-time card', () => {
  const order = sample({ cardTypeId: undefined, cardTypeName: undefined, proMaterialMode: 'manual_card',
    proCardNumber: '4242424242424242', paymentId: undefined });
  assert.equal(calculate(order).status, 'pending');
  const view = projected(order);
  assert.deepEqual(calculate(view), calculate(order));
  assert.doesNotMatch(JSON.stringify(view), /4242424242424242/);
  const withoutCard = sample({ cardTypeId: undefined, cardTypeName: undefined });
  assert.equal(calculate(withoutCard).status, 'ready');
  assert.deepEqual(calculate(projected(withoutCard)), calculate(withoutCard));
});

test('legacy card references keep the same accounting classification after masking', () => {
  for (const changes of [
    { paymentId: 'legacy-private-card-reference', proCardNumber: '4242424242424242' },
    { paymentId: 'legacy-private-card-reference' },
    { proCardNumber: '4242 4242 4242 4242' }
  ]) {
    const order = sample({ cardTypeId: undefined, cardTypeName: undefined,
      proMaterialMode: 'manual_card', ...changes });
    const view = projected(order);
    assert.equal(calculate(order).status, 'pending');
    assert.deepEqual(calculate(view), calculate(order));
    assert.doesNotMatch(JSON.stringify(view), /legacy-private-card-reference|4242424242424242|4242 4242/);
  }
});

test('finance retains original card classification and renewal exclusions without exposing card secrets', () => {
  for (const changes of [
    { cardTypeId: undefined, cardTypeName: undefined, proMaterialMode: 'tenant_card' },
    { proRenewalSourceId: 'prior-order' },
    { claudeRenewalId: 'legacy-prior-order' },
    { cardId: 'new-card', cardTypeId: 'virtual', cardTypeName: '虚拟卡', corrections: [{
      kind: 'materials', previous: { cardId: 'old-card', payment: '银行卡', paidConfirmed: true,
        paidAmount: '1000', paidCurrency: 'PHP', cardTypeId: 'card-type-real', proMaterialMode: 'tenant_card',
        proCardNumber: '4242424242424242', proCardSerial: 'private-test-serial' } }] }
  ]) {
    const order = sample({ ...changes, proCardNumber: '4242424242424242', proCardSerial: 'private-test-serial' });
    const view = projected(order);
    assert.deepEqual(calculate(view), calculate(order));
    assert.doesNotMatch(JSON.stringify(view), /4242424242424242|private-test-serial/);
  }
});
