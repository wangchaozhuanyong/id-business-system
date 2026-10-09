import { describe, expect, it } from 'vitest';
import { emptyForm } from './bank-recharge-order-form';
import { bitOrderPricingFormDefaults } from './bit-order-pricing';
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
  capturedAt: null,
  expiresAt: '2026-10-11T00:00:00Z'
}));
const order = (value: Partial<BankRechargeOrder> = {}) =>
  ({
    source: 'manual',
    status: 'pending_details',
    accountingVersion: 'subscription_cost_v2',
    plan: 'go',
    chargeAmount: '1000',
    chargeCurrencyCode: 'PHP',
    ...value
  }) as BankRechargeOrder;
const form = () => ({ ...emptyForm(), plan: 'plus', chargeAmount: '2000' });
describe('按收费设置回填当前订单草稿', () => {
  it('手工金额与套餐修改后按当前草稿计算，不用旧单本金和售价', () => {
    const result = bitOrderPricingFormDefaults(order(), form(), settings, rates, now);
    expect(result.patch.receivedAmount).toBe('1000');
    expect(result.patch.usdtFeeAmount).toBe('0.9286');
    expect(result.patch.shoppingFeeAmount).toBe('1');
  });
  it('自动订单坚持官网套餐与当次实付，不使用可能变化的草稿值', () => {
    const result = bitOrderPricingFormDefaults(
      order({ source: 'automatic', chargeAmount: '100' }),
      form(),
      settings,
      rates,
      now
    );
    expect(result.patch.receivedAmount).toBe('500');
    expect(result.patch.usdtFeeAmount).toBe('0.0464');
  });
  it('费用按照表单保留的真实USDT汇率计算，与保存金额一致', () => {
    const draft = { ...form(), chargeAmount: '400', usdtFeeFxRateToCny: '6' };
    const result = bitOrderPricingFormDefaults(order(), draft, settings, rates, now);
    expect(result.patch.usdtFeeAmount).toBe('0.2167');
    expect(result.preview.usdtFx).toBe('6');
    expect(result.patch.usdtFeeFxRateToCny).toBeUndefined();
  });
  it('默认价格改币种时清理旧收款账户和旧汇率', () => {
    const draft = { ...form(), receivedFinanceAccountId: 'cny-account', receivedFxRateToCny: '1' };
    const result = bitOrderPricingFormDefaults(
      order(),
      draft,
      { ...settings, receivedCurrencyCode: 'MYR' },
      rates,
      now
    );
    expect(result.patch.receivedCurrencyCode).toBe('MYR');
    expect(result.patch.receivedFxRateToCny).toBe('1.5');
    expect(result.patch.receivedFinanceAccountId).toBe('');
    expect(result.patch.shoppingFeeCurrencyCode).toBe('MYR');
  });
  it('同币种但空实收不沿用未核实的旧汇率', () => {
    const draft = { ...form(), receivedCurrencyCode: 'MYR', receivedFxRateToCny: '2' };
    const result = bitOrderPricingFormDefaults(
      order(),
      draft,
      { ...settings, receivedCurrencyCode: 'MYR' },
      rates,
      now
    );
    expect(result.patch.receivedFxRateToCny).toBe('1.5');
  });
  it('已有实际到账和汇率保留，购物费按实际金额计算', () => {
    const draft = {
      ...form(),
      receivedAmount: '800',
      receivedCurrencyCode: 'MYR',
      receivedFxRateToCny: '2'
    };
    const result = bitOrderPricingFormDefaults(order(), draft, settings, rates, now);
    expect(result.patch.receivedAmount).toBe('800');
    expect(result.patch.receivedCurrencyCode).toBe('MYR');
    expect(result.patch.receivedFxRateToCny).toBeUndefined();
    expect(result.patch.shoppingFeeAmount).toBe('0.8');
  });
  it.each(['.', '100.', '-100', '1e3', '1.00001'])(
    '未完成/非法实收输入%s拒绝计算并保留原草稿',
    (receivedAmount) => {
      const draft = { ...form(), receivedAmount };
      const before = JSON.stringify(draft);
      expect(() => bitOrderPricingFormDefaults(order(), draft, settings, rates, now)).toThrow(
        '客户实收'
      );
      expect(JSON.stringify(draft)).toBe(before);
    }
  );
  it.each(['.', '0', '-1', '1.123456789'])('非法汇率%s拒绝并保留草稿', (usdtFeeFxRateToCny) => {
    const draft = { ...form(), usdtFeeFxRateToCny };
    expect(() => bitOrderPricingFormDefaults(order(), draft, settings, rates, now)).toThrow('汇率');
    expect(draft.usdtFeeFxRateToCny).toBe(usdtFeeFxRateToCny);
  });
  it('明确更正历史单时允许计算建议，但不会直接修改原订单', () => {
    const previous = order({ status: 'completed', profitAmountCny: '10' });
    const before = JSON.stringify(previous);
    const result = bitOrderPricingFormDefaults(previous, form(), settings, rates, now);
    expect(result.patch.usdtFeeAmount).toBe('0.9286');
    expect(JSON.stringify(previous)).toBe(before);
  });
});
