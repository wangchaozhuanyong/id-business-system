import { computed, type Ref } from 'vue';
import {
  calculateProfitRate,
  isNonNegativeOrderAmount,
  isPositiveOrderAmount
} from '@/v2/features/order-entry/order-pricing';
import { useOrderPricingInputMode } from '@/v2/features/order-entry/useOrderPricingInputMode';
import type { V2Order, V2OrderCandidate, V2OrderEntrySettlementPlatform } from '../contracts';
import type { OrderEditForm } from './order-edit-form';

interface UseOrderEditProfitRateInputOptions {
  form: OrderEditForm;
  getOrder: () => V2Order | null;
  selectedPlatform: Readonly<Ref<V2OrderEntrySettlementPlatform | null>>;
  selectedCandidate: Readonly<Ref<V2OrderCandidate | null>>;
  optionsLoading: Readonly<Ref<boolean>>;
  matchingLoading: Readonly<Ref<boolean>>;
  receivedAmountPreview: Readonly<Ref<string>>;
  estimatedProfitPreview: Readonly<Ref<string>>;
  estimatedBalanceCostPreview: Readonly<Ref<string>>;
  appliedAccountCostPreview: Readonly<Ref<string>>;
}

export function useOrderEditProfitRateInput(options: UseOrderEditProfitRateInputOptions) {
  const unavailableReason = computed(() => {
    const order = options.getOrder();
    if (!options.form.receivedOriginalAmount.trim()) {
      return '填写原币实收后，将按当前成本自动反算';
    }
    if (!isPositiveOrderAmount(options.receivedAmountPreview.value)) {
      return '原币实收必须大于 0 才能反算利润率';
    }
    if (!options.selectedPlatform.value) {
      return options.optionsLoading.value ? '正在加载结算平台资料' : '请选择结算平台后自动反算';
    }
    if (!order || !options.form.accountId) {
      return '请选择使用 ID 并确认成本后自动反算';
    }
    if (
      order.operations.canEditCore &&
      (!options.selectedCandidate.value ||
        !isNonNegativeOrderAmount(options.selectedCandidate.value.estimatedBalanceCostAmount))
    ) {
      return options.matchingLoading.value
        ? '正在核算当前 ID 成本'
        : '请选择可用 ID 并确认成本后自动反算';
    }
    if (!isNonNegativeOrderAmount(options.estimatedBalanceCostPreview.value)) {
      return '当前余额成本无效，暂时不能反算利润率';
    }
    if (
      options.form.accountDisposition === 'sold' &&
      !isNonNegativeOrderAmount(options.appliedAccountCostPreview.value)
    ) {
      return '当前 ID 购买成本无效，暂时不能反算利润率';
    }
    return '';
  });
  const estimatedProfitRatePreview = computed(() =>
    unavailableReason.value
      ? null
      : calculateProfitRate(
          options.estimatedProfitPreview.value,
          options.receivedAmountPreview.value
        )
  );

  return {
    estimatedProfitRatePreview,
    ...useOrderPricingInputMode({
      getTargetProfitRate: () => options.form.targetProfitRate,
      setTargetProfitRate: (value) => {
        options.form.targetProfitRate = value;
      },
      getReversedProfitRate: () => estimatedProfitRatePreview.value,
      getReversedProfitRateUnavailableReason: () => unavailableReason.value
    })
  };
}
