import { reactive, ref } from 'vue';
import type { FormInstance } from 'element-plus';
import type { V2FinanceCurrency, V2OrderReceiptFxQuote } from '@apple-business/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { idBusinessV2OrdersApi } from './api';
import { createInitialOrderEntryForm } from './order-entry-form';
import { useOrderReceiptPricing } from './useOrderReceiptPricing';

vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: {
    warning: vi.fn()
  }
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createQuote(
  currency: V2FinanceCurrency,
  rateToCny: string,
  snapshotId: string
): V2OrderReceiptFxQuote {
  return {
    snapshotId,
    currency,
    rateToCny,
    source: currency === 'MYR' ? 'ecb_cross' : 'combined_p2p',
    capturedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString()
  };
}

function createPricing() {
  const form = reactive(createInitialOrderEntryForm());
  const pricing = useOrderReceiptPricing({
    form,
    formRef: ref<FormInstance>(),
    getSuggestedReceived: () => ({
      amount: '100',
      exactAmount: '100.0000',
      platformFee: '0.0000',
      estimatedProfit: '10.0000',
      estimatedProfitRate: '10.0000',
      error: ''
    }),
    getSettlementPlatform: () => ({ fixedFee: '0', percentageFee: '0' }),
    getAppliedAccountCost: () => '90.0000',
    getEstimatedBalanceCost: () => '0.0000'
  });
  return { form, pricing };
}

describe('useOrderReceiptPricing', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('ignores a late response after the currency has changed', async () => {
    const myrRequest = deferred<V2OrderReceiptFxQuote>();
    const usdtRequest = deferred<V2OrderReceiptFxQuote>();
    vi.spyOn(idBusinessV2OrdersApi, 'quoteReceiptFx').mockImplementation((currency) =>
      currency === 'MYR' ? myrRequest.promise : usdtRequest.promise
    );
    const { form, pricing } = createPricing();

    form.receivedCurrency = 'MYR';
    const myrLoad = pricing.loadReceiptFxQuote();
    form.receivedCurrency = 'USDT';
    const usdtLoad = pricing.loadReceiptFxQuote();
    usdtRequest.resolve(createQuote('USDT', '6.80000000', 'usdt-snapshot'));
    await usdtLoad;
    myrRequest.resolve(createQuote('MYR', '1.65000000', 'myr-snapshot'));
    await myrLoad;

    expect(form.receivedFxSnapshotId).toBe('usdt-snapshot');
    expect(form.automaticFxRateToCny).toBe('6.80000000');
    expect(pricing.receiptFxQuote.value?.currency).toBe('USDT');
    pricing.resetOrderReceiptPricing();
  });

  it('does not overwrite a manual rate when an automatic quote arrives late', async () => {
    const automaticRequest = deferred<V2OrderReceiptFxQuote>();
    vi.spyOn(idBusinessV2OrdersApi, 'quoteReceiptFx').mockReturnValue(automaticRequest.promise);
    const { form, pricing } = createPricing();

    form.receivedCurrency = 'MYR';
    const loading = pricing.loadReceiptFxQuote();
    form.receivedFxRateToCny = '1.70000000';
    form.receivedManualRateReason = '客户确认成交汇率';
    pricing.handleManualFxRateInput();
    automaticRequest.resolve(createQuote('MYR', '1.65000000', 'myr-snapshot'));
    await loading;

    expect(form.receivedFxRateToCny).toBe('1.70000000');
    expect(form.receivedFxSnapshotId).toBe('');
    expect(form.automaticFxRateToCny).toBe('');
    pricing.resetOrderReceiptPricing();
  });

  it('converts the exact CNY target before rounding the final original-currency recommendation', () => {
    const form = reactive(createInitialOrderEntryForm());
    form.receivedCurrency = 'MYR';
    form.receivedFxRateToCny = '0.10000000';
    const pricing = useOrderReceiptPricing({
      form,
      formRef: ref<FormInstance>(),
      getSuggestedReceived: () => ({
        amount: '100',
        exactAmount: '100.4900',
        platformFee: '0',
        estimatedProfit: '10',
        estimatedProfitRate: '10',
        error: ''
      }),
      getSettlementPlatform: () => ({ fixedFee: '0', percentageFee: '0' }),
      getAppliedAccountCost: () => '90',
      getEstimatedBalanceCost: () => '0'
    });

    expect(pricing.suggestedReceipt.value.originalAmount).toBe('1005');
    expect(pricing.suggestedReceipt.value.equivalentCnyAmount).toBe('100.5');
    pricing.resetOrderReceiptPricing();
  });
});
