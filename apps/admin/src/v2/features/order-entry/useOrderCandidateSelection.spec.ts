import { effectScope, reactive } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { idBusinessV2OrdersApi } from './api';
import type { V2OrderMatchingResult } from './contracts';
import { useOrderCandidateSelection } from './useOrderCandidateSelection';

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createMatchingResult(): V2OrderMatchingResult {
  const evaluatedAt = new Date().toISOString();
  const option = { id: 'option-1', code: 'option', name: '选项' };
  return {
    criteria: {
      service: option,
      category: option,
      country: option,
      requiredBalance: '10',
      requiredStatusCode: 'normal',
      evaluatedAt
    },
    counts: {
      activeInCountry: 1,
      normalStatus: 1,
      sufficientBalance: 1,
      available: 1
    },
    selectedCandidateId: 'candidate-1',
    items: [
      {
        id: 'candidate-1',
        appleIdMasked: 'test***@example.com',
        country: option,
        status: option,
        currentBalance: '20',
        balanceCostAmount: '100',
        estimatedBalanceCostAmount: '50',
        averageCost: '5',
        purchaseCost: '0',
        balanceAfterMatch: '10',
        updatedAt: evaluatedAt
      }
    ],
    revalidateAt: null
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('useOrderCandidateSelection', () => {
  it('returns to a stable empty state when a successful order reset cancels matching', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const pendingMatch = createDeferred<V2OrderMatchingResult>();
    vi.spyOn(idBusinessV2OrdersApi, 'findMatchingCandidates').mockReturnValue(pendingMatch.promise);
    const form = reactive({
      serviceOptionId: 'service-1',
      balanceAmount: '10',
      accountId: ''
    });
    const scope = effectScope();
    const selection = scope.run(() => useOrderCandidateSelection(form));
    if (!selection) return;

    selection.scheduleCandidateMatch();
    await vi.advanceTimersByTimeAsync(350);
    expect(selection.matchingLoading.value).toBe(true);

    selection.resetCandidateSelection();
    expect(selection.matchingLoading.value).toBe(false);
    expect(selection.candidateItems.value).toEqual([]);
    expect(form.accountId).toBe('');

    pendingMatch.resolve(createMatchingResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(selection.matchingLoading.value).toBe(false);
    expect(selection.candidateItems.value).toEqual([]);
    expect(form.accountId).toBe('');
    scope.stop();
  });
});
