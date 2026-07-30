import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import type { V2Order, V2OrderCandidate, V2OrderEntrySettlementPlatform } from '../contracts';
import { createEmptyOrderEditForm } from './order-edit-form';
import { useOrderEditProfitRateInput } from './useOrderEditProfitRateInput';

describe('order edit profit rate input', () => {
  function createState() {
    const form = createEmptyOrderEditForm();
    form.accountId = 'account-1';
    form.receivedOriginalAmount = '100';
    const order = ref({
      operations: { canEditCore: true }
    } as V2Order);
    const selectedPlatform = ref({
      id: 'platform-1'
    } as V2OrderEntrySettlementPlatform);
    const selectedCandidate = ref<V2OrderCandidate | null>({
      estimatedBalanceCostAmount: '38.374'
    } as V2OrderCandidate);
    const optionsLoading = ref(false);
    const matchingLoading = ref(false);
    const receivedAmountPreview = ref('100');
    const estimatedProfitPreview = ref('56.626');
    const estimatedBalanceCostPreview = ref('38.374');
    const appliedAccountCostPreview = ref('0');
    const state = useOrderEditProfitRateInput({
      form,
      getOrder: () => order.value,
      selectedPlatform,
      selectedCandidate,
      optionsLoading,
      matchingLoading,
      receivedAmountPreview,
      estimatedProfitPreview,
      estimatedBalanceCostPreview,
      appliedAccountCostPreview
    });
    return { form, selectedCandidate, ...state };
  }

  it('shows the live reversed rate and preserves target pricing as a separate mode', () => {
    const state = createState();

    expect(state.estimatedProfitRatePreview.value).toBe('56.626');
    expect(state.profitRateInputValue.value).toBe('56.626');
    expect(state.form.targetProfitRate).toBe('');

    state.profitRateInputValue.value = '20';
    expect(state.form.targetProfitRate).toBe('20');
    expect(state.pricingInputMode.value).toBe('target');
  });

  it('does not expose a stale rate while editable ID cost evidence is missing', () => {
    const state = createState();
    state.selectedCandidate.value = null;

    expect(state.estimatedProfitRatePreview.value).toBeNull();
    expect(state.profitRateInputValue.value).toBe('');
    expect(state.profitRateInputHint.value).toContain('请选择可用 ID');
  });
});
