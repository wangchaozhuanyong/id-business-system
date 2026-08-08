import { describe, expect, it } from 'vitest';
import dialogs from './components/V2AccountDialogs.vue?raw';
import purchaseFields from './components/V2AccountPurchaseFields.vue?raw';
import purchaseSources from './useAccountPurchaseSources.ts?raw';

describe('account purchase fields UI contract', () => {
  it('uses the requested ID purchase labels and places calculated CNY cost below the amount', () => {
    const currencyIndex = purchaseFields.indexOf('label="ID采购币种"');
    const amountIndex = purchaseFields.indexOf('label="ID采购金额"');
    const costIndex = purchaseFields.indexOf('label="人民币成本"');
    const paymentIndex = purchaseFields.indexOf('label="付款账户"');

    expect(currencyIndex).toBeGreaterThan(-1);
    expect(amountIndex).toBeGreaterThan(currencyIndex);
    expect(costIndex).toBeGreaterThan(amountIndex);
    expect(paymentIndex).toBeGreaterThan(costIndex);
    expect(purchaseFields).toContain('根据 ID采购金额与交易汇率自动计算，无需手动填写。');
    expect(purchaseFields).toContain('readonly');
    expect(purchaseFields).not.toContain('label="采购币种"');
    expect(purchaseFields).not.toContain('label="原币金额"');
  });

  it('keeps validation wording consistent with the visible fields', () => {
    expect(dialogs).toContain('请选择 ID采购币种');
    expect(dialogs).toContain("includes('ID采购金额')");
    expect(dialogs).toContain('请选择付款账户');
    expect(purchaseSources).toContain('非负 ID采购金额');
  });
});
