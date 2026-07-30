import { ref } from 'vue';
import { describe, expect, it } from 'vitest';
import { useOrderPricingInputMode } from './useOrderPricingInputMode';

describe('order pricing input mode', () => {
  function createState() {
    const targetProfitRate = ref('');
    const reversedProfitRate = ref<string | null>('56.626');
    const unavailableReason = ref('');
    const state = useOrderPricingInputMode({
      getTargetProfitRate: () => targetProfitRate.value,
      setTargetProfitRate: (value) => {
        targetProfitRate.value = value;
      },
      getReversedProfitRate: () => reversedProfitRate.value,
      getReversedProfitRateUnavailableReason: () => unavailableReason.value
    });
    return {
      targetProfitRate,
      reversedProfitRate,
      unavailableReason,
      ...state
    };
  }

  it('shows the reversed rate without writing it into the target field', () => {
    const state = createState();

    expect(state.pricingInputMode.value).toBe('receipt');
    expect(state.profitRateInputValue.value).toBe('56.626');
    expect(state.targetProfitRate.value).toBe('');

    state.reversedProfitRate.value = '-12.5';
    expect(state.profitRateInputValue.value).toBe('-12.5');
    expect(state.targetProfitRate.value).toBe('');
  });

  it('switches to target pricing when the rate field is edited', () => {
    const state = createState();

    state.profitRateInputValue.value = '20';

    expect(state.pricingInputMode.value).toBe('target');
    expect(state.targetProfitRate.value).toBe('20');
    expect(state.profitRateInputValue.value).toBe('20');
    expect(state.profitRateInputHint.value).toContain('采用推荐价');
  });

  it('returns to live reverse calculation after a manual receipt edit', () => {
    const state = createState();
    state.profitRateInputValue.value = '20';
    state.reversedProfitRate.value = '18.125';

    state.useReceiptDrivenProfitRate();

    expect(state.pricingInputMode.value).toBe('receipt');
    expect(state.targetProfitRate.value).toBe('');
    expect(state.profitRateInputValue.value).toBe('18.125');
  });

  it('shows an availability reason instead of a stale reversed value', () => {
    const state = createState();
    state.reversedProfitRate.value = null;
    state.unavailableReason.value = '请选择可用 ID 并确认成本后自动反算';

    expect(state.profitRateInputValue.value).toBe('');
    expect(state.profitRateInputHint.value).toBe('请选择可用 ID 并确认成本后自动反算');
  });
});
