import { computed, ref } from 'vue';

export type OrderPricingInputMode = 'receipt' | 'target';

interface OrderPricingInputModeOptions {
  getTargetProfitRate: () => string;
  setTargetProfitRate: (value: string) => void;
  getReversedProfitRate: () => string | null;
  getReversedProfitRateUnavailableReason: () => string;
  receiptAmountLabel?: string;
}

export function useOrderPricingInputMode(options: OrderPricingInputModeOptions) {
  const pricingInputMode = ref<OrderPricingInputMode>('receipt');
  const profitRateInputValue = computed({
    get: () =>
      pricingInputMode.value === 'target'
        ? options.getTargetProfitRate()
        : (options.getReversedProfitRate() ?? ''),
    set: (value: string) => {
      pricingInputMode.value = 'target';
      options.setTargetProfitRate(String(value ?? ''));
    }
  });
  const profitRateInputHint = computed(() => {
    const receiptAmountLabel = options.receiptAmountLabel ?? '原币实收';
    if (pricingInputMode.value === 'target') {
      return options.getTargetProfitRate().trim()
        ? '当前按目标利润率计算推荐价格，点击“采用推荐价”后才会更新实收'
        : `填写目标利润率后计算推荐价格，不会自动覆盖${receiptAmountLabel}`;
    }
    return (
      options.getReversedProfitRateUnavailableReason() ||
      `已按当前${receiptAmountLabel}、平台手续费和成本自动反算`
    );
  });

  function useReceiptDrivenProfitRate() {
    pricingInputMode.value = 'receipt';
    options.setTargetProfitRate('');
  }

  function resetPricingInputMode() {
    useReceiptDrivenProfitRate();
  }

  return {
    pricingInputMode,
    profitRateInputValue,
    profitRateInputHint,
    useReceiptDrivenProfitRate,
    resetPricingInputMode
  };
}
