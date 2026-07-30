import { computed, ref, type ComputedRef, type Ref } from 'vue';
import {
  calculateEstimatedBalanceCostAmount,
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateProfitRate,
  calculateSuggestedReceivedAmount
} from '@/v2/features/order-entry/order-pricing';
import type { V2ManualRenewalOptions, V2RenewalWorkbenchItem } from './contracts';

interface RenewalPricingForm {
  receivedAmount: string;
  targetProfitRate: string;
  balanceAmount: string;
}

export function useRenewalPricing(
  form: RenewalPricingForm,
  selectedRenewal: Ref<V2RenewalWorkbenchItem | null>,
  selectedPlatform: ComputedRef<V2ManualRenewalOptions['settlementPlatforms'][number] | null>
) {
  const recommendationApplied = ref(false);
  const previousManualPrice = ref('');
  const appliedSuggestedCny = ref('');
  const platformFeePreview = computed(
    () =>
      calculatePlatformFeeAmount(
        form.receivedAmount,
        selectedPlatform.value?.fixedFee ?? '0',
        selectedPlatform.value?.percentageFee ?? '0'
      ) ?? '0'
  );
  const estimatedBalanceCostPreview = computed(
    () =>
      calculateEstimatedBalanceCostAmount(
        selectedRenewal.value?.account.currentBalance,
        selectedRenewal.value?.account.balanceCostAmount,
        form.balanceAmount
      ) ?? '0'
  );
  const estimatedProfitPreview = computed(
    () =>
      calculateEstimatedProfitAmount(
        form.receivedAmount,
        platformFeePreview.value,
        '0',
        estimatedBalanceCostPreview.value
      ) ?? '0'
  );
  const estimatedProfitRatePreview = computed(() =>
    calculateProfitRate(estimatedProfitPreview.value, form.receivedAmount)
  );
  const suggestedReceived = computed(() =>
    form.targetProfitRate.trim()
      ? calculateSuggestedReceivedAmount({
          targetProfitRate: form.targetProfitRate,
          appliedAccountCostAmount: '0',
          estimatedBalanceCostAmount: estimatedBalanceCostPreview.value,
          fixedFee: selectedPlatform.value?.fixedFee ?? '0',
          percentageFee: selectedPlatform.value?.percentageFee ?? '0'
        })
      : {
          amount: null,
          exactAmount: null,
          platformFee: null,
          estimatedProfit: null,
          estimatedProfitRate: null,
          error: ''
        }
  );

  function applySuggestedReceivedAmount() {
    if (!suggestedReceived.value.amount) return;
    if (!recommendationApplied.value) previousManualPrice.value = form.receivedAmount;
    form.receivedAmount = suggestedReceived.value.amount;
    recommendationApplied.value = true;
    appliedSuggestedCny.value = suggestedReceived.value.amount;
  }

  function undoSuggestedReceivedAmount() {
    if (!recommendationApplied.value) return;
    form.receivedAmount = previousManualPrice.value;
    recommendationApplied.value = false;
    appliedSuggestedCny.value = '';
  }

  function handleManualPriceInput() {
    recommendationApplied.value = false;
    appliedSuggestedCny.value = '';
  }

  function resetRecommendation() {
    recommendationApplied.value = false;
    previousManualPrice.value = '';
    appliedSuggestedCny.value = '';
  }

  return {
    platformFeePreview,
    estimatedBalanceCostPreview,
    estimatedProfitPreview,
    estimatedProfitRatePreview,
    suggestedReceived,
    recommendationApplied,
    appliedSuggestedCny,
    applySuggestedReceivedAmount,
    undoSuggestedReceivedAmount,
    handleManualPriceInput,
    resetRecommendation
  };
}
