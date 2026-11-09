import assert from 'node:assert/strict';
import test from 'node:test';
import { validOrderCurrencies, validOrderCurrencyGroups, retainOrderCurrencySettings } from '../server/order-currency-settings.mjs';
import { validClaudePaidPrices, validGptPaidPrices, validOrderPrices } from '../server/order-policy.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { calculateOrder, createOrderSnapshot, requiredQuoteCurrencies } from '../modules/finance/accounting.mjs';

const gpt = [{ code: 'CNY', name: '人民币' }, { code: 'PHP', name: '菲律宾比索' }];
const claude = [{ code: 'MYR', name: '马币' }, { code: 'EUR', name: '欧元' }];

test('GPT 与 Claude 币种分别配置，拒绝空清单、重复代码和非法产品', () => {
  assert(validOrderCurrencyGroups({ GPT: gpt, Claude: claude }));
  assert(validOrderCurrencyGroups({ Claude: claude }));
  for (const rows of [[], null, {}, [{ code: 'eur', name: '欧元' }], [{ code: 'EURO', name: '欧元' }],
    [{ code: 'EUR', name: ' 欧元' }], [{ code: 'EUR', name: '欧\n元' }], [...claude, claude[1]]])
    assert.equal(validOrderCurrencies(rows), false);
  for (const groups of [null, [], { other: claude }, { GPT: [] }, { Claude: null }])
    assert.equal(Boolean(validOrderCurrencyGroups(groups)), false);
});

test('部分保存和其他设置旧客户端写入保留另一产品，兼容旧币种清单', () => {
  const previous = { orderCurrencies: gpt, orderCurrenciesByProduct: { GPT: gpt, Claude: claude } };
  const replacement = [{ code: 'CNY', name: '人民币' }];
  const next = retainOrderCurrencySettings({ orderCurrenciesByProduct: { Claude: replacement } }, previous);
  assert.deepEqual(next.orderCurrenciesByProduct, { GPT: gpt, Claude: replacement });
  assert.deepEqual(next.orderCurrencies, gpt);
  assert.deepEqual(retainOrderCurrencySettings({ costSettings: {} }, previous), { ...previous, costSettings: {} });
  assert.deepEqual(previous.orderCurrenciesByProduct.Claude, claude);
  assert(validOrderPrices({ GPT: { Plus: { CNY: '100.0001' } }, 'Claude Pro': { Pro: { EUR: '49.9900' } } }));
  assert.equal(validOrderPrices({ 'Claude Pro': { Pro: { EUR: '0.00001' } } }), false);
});

test('新增币种沿用精确金额和冻结汇率，缺少所需汇率时保持待核算', () => {
  const clock = Date.parse('2026-11-05T05:00:00Z');
  const order = { product: 'Claude Pro', plan: 'Pro', payment: '银行卡', costBasis: 'actual',
    paidAmount: '10.0001', paidCurrency: 'EUR', saleCurrency: 'CNY', actualCostCurrency: 'EUR', actualCostAmount: '10.0001',
    saleAmount: '150', start: '2026-11-05T12:30', costSettings: { version: 1 }, refunds: [], bankReturns: [] };
  assert(requiredQuoteCurrencies(order).includes('EUR'));
  const quote = { source: '银行凭据 CURRENCY-01', at: '2026-11-05T12:00', expiresAt: '2026-11-05T14:00', rates: { MYR: '1.6', EUR: '8' } };
  assert.throws(() => createOrderSnapshot({ ...quote, rates: { MYR: '1.6' } }, order, clock), /EUR/);
  assert.equal(calculateOrder(order, { clock }).status, 'pending');
  order.fxSnapshot = createOrderSnapshot(quote, order, clock);
  assert.equal(calculateOrder(order, { clock }).profit, '69.9992');
  quote.rates.EUR = '9';
  assert.equal(calculateOrder(order, { clock }).profit, '69.9992');
});

test('GPT 与 Claude 的代付价格限各自套餐和国家币种，其他设置保存时保留', () => {
  const presets = { Plus: { PHP: '983', CLP: '10000', IDR: '' } };
  const claudePresets = { 'Claude Pro': { Pro: { MYR: '89.0001' } }, 'Claude Max': { 'Max 5x': { USD: '105' } } };
  assert(validGptPaidPrices(presets));
  assert(validClaudePaidPrices(claudePresets));
  for (const invalid of [null, { Go: { PHP: '1' } }, { Plus: { EUR: '1' } },
    { Plus: { PHP: 983 } }, { Plus: { PHP: '-1' } }, { Plus: { PHP: '1.00001' } }])
    assert(!validGptPaidPrices(invalid));
  for (const invalid of [{ GPT: presets }, { 'Claude Max': { Pro: { USD: '1' } } },
    { 'Claude Pro': { Pro: { EUR: '1' } } }, { 'Claude Pro': { Pro: { MYR: '1.00001' } } }])
    assert(!validClaudePaidPrices(invalid));
  const store = createLocalBusinessStore(':memory:');
  try {
    const initial = { mailboxTypes: [], costSettings: {}, orderPrices: { GPT: { Plus: { CNY: '100' } } } };
    const command = (version, data, action) => [{ domain: 'settings', version, data, action }];
    store.saveBatch(command(0, { ...initial, gptPaidPrices: presets }, 'gpt_paid_prices_save'));
    assert.throws(() => store.saveBatch(command(0, initial, 'order_prices_save')), { status: 409 });
    assert.throws(() => store.saveBatch(command(1, { ...initial, claudePaidPrices: { GPT: presets } },
      'claude_paid_prices_save')), { status: 400 });
    store.saveBatch(command(1, { ...initial, claudePaidPrices: claudePresets }, 'claude_paid_prices_save'));
    store.saveBatch(command(2, { ...initial, orderCurrenciesByProduct: { Claude: claude } }, 'order_currencies_save'));
    assert.deepEqual(store.load('settings').data.gptPaidPrices, presets);
    assert.deepEqual(store.load('settings').data.claudePaidPrices, claudePresets);
    assert.deepEqual(store.load('settings').data.orderPrices, initial.orderPrices);
    assert(store.audit().some(row => row.action === 'gpt_paid_prices_save'));
    assert(store.audit().some(row => row.action === 'claude_paid_prices_save'));
  } finally { store.close(); }
});
