import { describe, expect, it } from 'vitest';
import { estimateBitOrder } from './bit-order-pricing';
import type {
  BankRechargeOrder,
  BitOrderPricingSettings,
  BitOrderPricingRate
} from './bank-recharge-api';
const now = Date.parse('2026-10-10T00:00:00Z');
const settings: BitOrderPricingSettings = {
  receivedCurrencyCode: 'CNY',
  shoppingFeePercent: '0.1',
  usdtFeePercent: '2.5',
  planPrices: { go: '500', plus: '1000' },
  updatedAt: null
};
const rates: BitOrderPricingRate[] = ['PHP', 'USDT', 'MYR'].map((currency, index) => ({
  currency,
  rateToCny: ['0.13', '7', '1.5'][index]!,
  id: currency,
  capturedAt: '2026-10-09T00:00:00Z',
  expiresAt: '2026-10-11T00:00:00Z'
}));
const order = (value: Partial<BankRechargeOrder> = {}) =>
  ({
    accountingVersion: 'subscription_cost_v2',
    status: 'pending_details',
    plan: 'plus',
    chargeAmount: '400',
    chargeCurrencyCode: 'PHP',
    receivedAmount: null,
    receivedCurrencyCode: null,
    usdtFeeAmount: null,
    shoppingFeeAmount: null,
    profitAmountCny: null,
    ...value
  }) as BankRechargeOrder;
describe('比特订单收费参考与人民币利润', () => {
  it('空实收只有旧币种时，当前套餐参考价始终使用设置的币种', () => {
    const result = estimateBitOrder(
      order({ receivedAmount: null, receivedCurrencyCode: 'MYR', receivedFxRateToCny: '2' }),
      settings,
      rates,
      now
    );
    expect(result.receipt).toBe('1000');
    expect(result.currency).toBe('CNY');
    expect(result.receiptFx).toBe('1');
    expect(result.shoppingFee).toBe('1');
    expect(result.shoppingCurrency).toBe('CNY');
    expect(result.profit).toBe('945.7001');
    expect(result.receiptEstimated).toBe(true);
  });

  it('参考价币种改变后不能套用空收款记录原币种的汇率', () => {
    const result = estimateBitOrder(
      order({ receivedAmount: null, receivedCurrencyCode: 'CNY', receivedFxRateToCny: '1' }),
      { ...settings, receivedCurrencyCode: 'MYR' },
      rates,
      now
    );
    expect(result.receipt).toBe('1000');
    expect(result.currency).toBe('MYR');
    expect(result.receiptFx).toBe('1.5');
    expect(result.shoppingCurrency).toBe('MYR');
    expect(result.profit).toBe('1445.2001');
  });

  it('升级按当次补差本金，客户价格不会改变代付金额', () => {
    const result = estimateBitOrder(order(), settings, rates, now);
    expect(result.receipt).toBe('1000');
    expect(result.usdtFee).toBe('0.1857');
    expect(result.shoppingFee).toBe('1');
    expect(result.profit).toBe('945.7001');
    expect(result.receiptEstimated && result.profitEstimated).toBe(true);
  });
  it('购物网百分比以实际客户到账金额为基数，保留小百分比', () => {
    const result = estimateBitOrder(
      order({ receivedAmount: '800', receivedCurrencyCode: 'MYR' }),
      { ...settings, shoppingFeePercent: '0.01' },
      rates,
      now
    );
    expect(result.receipt).toBe('800');
    expect(result.shoppingFee).toBe('0.08');
    expect(result.shoppingCurrency).toBe('MYR');
    expect(result.receiptEstimated).toBe(false);
    expect(result.profit).toBe('1146.5801');
  });
  it('已核实费用和汇率优先于当前默认设置及新汇率', () => {
    const result = estimateBitOrder(
      order({
        receivedAmount: '100',
        receivedCurrencyCode: 'MYR',
        receivedFxRateToCny: '2',
        chargeFxRateToCny: '0.1',
        usdtFeeAmount: '2',
        usdtFeeCurrencyCode: 'USDT',
        usdtFeeFxRateToCny: '6',
        shoppingFeeAmount: '3',
        shoppingFeeCurrencyCode: 'CNY'
      }),
      settings,
      rates,
      now
    );
    expect(result.profit).toBe('145');
    expect(result.shoppingEstimated || result.usdtEstimated).toBe(false);
  });
  it.each(['completed', 'refunded', 'cancelled'] as const)(
    '已结束的 %s 订单不套用新配置重算',
    (status) => {
      const result = estimateBitOrder(
        order({ status, profitAmountCny: '25' }),
        settings,
        rates,
        now
      );
      expect(result.profit).toBe('25');
      expect(result.receipt).toBeNull();
      expect(result.usdtFee).toBeNull();
    }
  );
  it('旧费用口径不使用新比例补算利润', () => {
    const result = estimateBitOrder(order({ accountingVersion: 'legacy' }), settings, rates, now);
    expect(result.profit).toBeNull();
    expect(result.receipt).toBeNull();
  });
  it('汇率过期时不给出人民币利润或 USDT 费用猜测', () => {
    const result = estimateBitOrder(order(), settings, rates, Date.parse('2026-10-12T00:00:00Z'));
    expect(result.usdtFee).toBeNull();
    expect(result.profit).toBeNull();
    expect(result.shoppingFee).toBe('1');
  });
  it('未配置收费和费用显示待核对，不把空值变成零', () => {
    const result = estimateBitOrder(order(), undefined, rates, now);
    expect(result.receipt).toBeNull();
    expect(result.usdtFee).toBeNull();
    expect(result.profit).toBeNull();
  });
  it('明确零手续费无需对应费用汇率，仍需本金汇率计算利润', () => {
    const result = estimateBitOrder(
      order(),
      { ...settings, shoppingFeePercent: '0', usdtFeePercent: '0' },
      rates.filter((r) => r.currency === 'PHP'),
      now
    );
    expect(result.usdtFee).toBe('0');
    expect(result.shoppingFee).toBe('0');
    expect(result.profit).toBe('948');
  });
  it('允许负利润，按 Decimal 计算，不截断亏损', () => {
    const result = estimateBitOrder(
      order({ receivedAmount: '1', receivedCurrencyCode: 'CNY' }),
      settings,
      rates,
      now
    );
    expect(result.profit).toBe('-52.2999');
  });
});
