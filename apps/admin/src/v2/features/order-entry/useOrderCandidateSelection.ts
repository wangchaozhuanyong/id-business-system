import { computed, onActivated, onDeactivated, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2Query, type V2QueryPhase } from '@/v2/composables/useV2Query';
import { idBusinessV2OrdersApi } from './api';
import { isPositiveOrderAmount } from './order-pricing';
import type { V2OrderCandidate, V2OrderMatchingResult } from './contracts';

export type IdSelectionMode = 'auto' | 'manual';

interface OrderCandidateForm {
  serviceOptionId: string;
  balanceAmount: string;
  accountId: string;
  accountSource: 'inventory' | 'customer_owned';
  customerId: string;
}

export function useOrderCandidateSelection(form: OrderCandidateForm) {
  const idSelectionMode = ref<IdSelectionMode>('auto');
  const manualSearchKeyword = ref('');
  const matchingError = ref('');
  const matchingResult = ref<V2OrderMatchingResult | null>(null);
  const selectedCandidateSnapshot = ref<V2OrderCandidate | null>(null);
  let matchingTimer: ReturnType<typeof setTimeout> | undefined;
  let manualSearchTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeCandidateMatch = false;

  const candidateItems = computed<V2OrderCandidate[]>(() => matchingResult.value?.items ?? []);
  const selectedCandidate = computed(() => {
    const current = candidateItems.value.find((candidate) => candidate.id === form.accountId);
    if (current) return current;
    return selectedCandidateSnapshot.value?.id === form.accountId
      ? selectedCandidateSnapshot.value
      : null;
  });
  const canMatch = computed(
    () =>
      Boolean(form.serviceOptionId) &&
      isPositiveOrderAmount(form.balanceAmount) &&
      (form.accountSource === 'inventory' || Boolean(form.customerId))
  );
  const matchingEmptyMessage = computed(() => {
    const counts = matchingResult.value?.counts;
    if (!counts) return '';
    if (counts.activeInCountry === 0) return '当前国家没有启用的 ID';
    if (counts.normalStatus === 0) return '当前国家没有状态正常的 ID';
    if (counts.sufficientBalance === 0) return '正常 ID 的余额不足';
    if (
      idSelectionMode.value === 'manual' &&
      manualSearchKeyword.value &&
      !matchingResult.value?.items.length
    ) {
      return '没有找到与搜索词匹配的合格 ID';
    }
    return '符合条件的 ID 当前已被订单锁定';
  });

  const candidateQuery = useV2Query<V2OrderMatchingResult>({
    scope: 'order-entry-matching',
    key: () =>
      createV2QueryKey({
        serviceOptionId: form.serviceOptionId,
        balanceAmount: form.balanceAmount.trim(),
        accountSource: form.accountSource,
        customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
        limit: 50
      }),
    freshnessPolicy: 'event-with-deadline',
    getRevalidateAt: (result) => result.revalidateAt,
    keepPreviousData: false,
    query: ({ signal }) =>
      idBusinessV2OrdersApi.findMatchingCandidates(
        {
          serviceOptionId: form.serviceOptionId,
          balanceAmount: form.balanceAmount.trim(),
          accountSource: form.accountSource,
          customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
          limit: 50
        },
        { signal }
      )
  });
  const manualCandidateQuery = useV2Query<V2OrderMatchingResult>({
    scope: 'order-entry-manual-candidates',
    key: () =>
      createV2QueryKey({
        serviceOptionId: form.serviceOptionId,
        balanceAmount: form.balanceAmount.trim(),
        accountSource: form.accountSource,
        customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
        keyword: manualSearchKeyword.value.trim(),
        limit: 50
      }),
    freshnessPolicy: 'event-with-deadline',
    getRevalidateAt: (result) => result.revalidateAt,
    keepPreviousData: true,
    query: ({ signal }) =>
      idBusinessV2OrdersApi.searchManualCandidates(
        {
          serviceOptionId: form.serviceOptionId,
          balanceAmount: form.balanceAmount.trim(),
          accountSource: form.accountSource,
          customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
          keyword: manualSearchKeyword.value.trim() || undefined,
          limit: 50
        },
        { signal }
      )
  });
  const matchingLoading = computed(() =>
    idSelectionMode.value === 'auto'
      ? candidateQuery.isInitialLoading.value || candidateQuery.isRefreshing.value
      : manualCandidateQuery.isInitialLoading.value || manualCandidateQuery.isRefreshing.value
  );
  const matchingPhase = computed<V2QueryPhase>(() =>
    idSelectionMode.value === 'auto' ? candidateQuery.phase.value : manualCandidateQuery.phase.value
  );
  const matchingParameterTransition = computed(() =>
    idSelectionMode.value === 'auto'
      ? candidateQuery.isParameterTransition.value
      : manualCandidateQuery.isParameterTransition.value
  );

  function applyAutomaticResult(result: V2OrderMatchingResult | undefined) {
    if (!result || idSelectionMode.value !== 'auto' || !canMatch.value) return;
    const currentAccountId = form.accountId;
    matchingResult.value = result;
    matchingError.value = '';
    form.accountId =
      currentAccountId && result.items.some((candidate) => candidate.id === currentAccountId)
        ? currentAccountId
        : (result.selectedCandidateId ?? '');
  }

  function applyManualResult(result: V2OrderMatchingResult | undefined) {
    if (!result || idSelectionMode.value !== 'manual' || !canMatch.value) return;
    const currentAccountId = form.accountId;
    matchingResult.value = result;
    matchingError.value = '';
    if (currentAccountId && !result.items.some((candidate) => candidate.id === currentAccountId)) {
      form.accountId = '';
    }
  }

  watch(candidateQuery.data, applyAutomaticResult);
  watch(manualCandidateQuery.data, applyManualResult);
  watch(candidateQuery.error, (error) => {
    if (error && idSelectionMode.value === 'auto') matchingError.value = getApiErrorMessage(error);
  });
  watch(manualCandidateQuery.error, (error) => {
    if (error && idSelectionMode.value === 'manual') {
      matchingError.value = getApiErrorMessage(error);
    }
  });

  watch(
    () => form.accountId,
    (accountId) => {
      if (!accountId) {
        selectedCandidateSnapshot.value = null;
        return;
      }
      const candidate = candidateItems.value.find((item) => item.id === accountId);
      if (candidate) selectedCandidateSnapshot.value = candidate;
    }
  );

  function handleIdSelectionModeChange(value: unknown) {
    if (value !== 'auto' && value !== 'manual') return;
    idSelectionMode.value = value;
    manualSearchKeyword.value = '';
    clearCandidates();
    if (canMatch.value) scheduleCandidateMatch();
  }

  function searchManualCandidates(keyword: string) {
    if (manualSearchTimer) clearTimeout(manualSearchTimer);
    manualSearchKeyword.value = keyword.trim();
    if (idSelectionMode.value !== 'manual' || !canMatch.value) return;
    manualSearchTimer = setTimeout(() => {
      manualSearchTimer = undefined;
      void loadManualCandidates();
    }, 300);
  }

  function scheduleCandidateMatch() {
    if (matchingTimer) clearTimeout(matchingTimer);
    if (!canMatch.value) {
      clearCandidates();
      return;
    }
    candidateQuery.cancel();
    manualCandidateQuery.cancel();
    matchingResult.value = null;
    matchingError.value = '';
    form.accountId = '';
    matchingTimer = setTimeout(() => {
      matchingTimer = undefined;
      void loadCandidates();
    }, 350);
  }

  async function loadCandidates() {
    if (!canMatch.value) return;
    if (idSelectionMode.value === 'manual') {
      await loadManualCandidates();
      return;
    }
    const requestedKey = automaticQueryKey();
    matchingError.value = '';
    form.accountId = '';
    await candidateQuery.ensureFresh();
    if (requestedKey !== automaticQueryKey() || idSelectionMode.value !== 'auto') return;
    if (candidateQuery.error.value) {
      matchingError.value = getApiErrorMessage(candidateQuery.error.value);
      return;
    }
    const result = candidateQuery.data.value;
    applyAutomaticResult(result);
  }

  async function loadManualCandidates() {
    if (!canMatch.value || idSelectionMode.value !== 'manual') return;
    const requestedKey = manualQueryKey();
    matchingError.value = '';
    await manualCandidateQuery.ensureFresh();
    if (requestedKey !== manualQueryKey() || idSelectionMode.value !== 'manual') return;
    if (manualCandidateQuery.error.value) {
      matchingError.value = getApiErrorMessage(manualCandidateQuery.error.value);
      return;
    }
    const result = manualCandidateQuery.data.value;
    applyManualResult(result);
  }

  async function refreshCurrentCandidates() {
    if (!canMatch.value) return;
    const mode = idSelectionMode.value;
    const requestedKey = mode === 'auto' ? automaticQueryKey() : manualQueryKey();
    const query = mode === 'auto' ? candidateQuery : manualCandidateQuery;
    await query.ensureFresh();
    const currentKey = mode === 'auto' ? automaticQueryKey() : manualQueryKey();
    if (requestedKey !== currentKey || idSelectionMode.value !== mode) return;
    if (query.error.value) {
      matchingError.value = getApiErrorMessage(query.error.value);
      return;
    }
    if (mode === 'auto') applyAutomaticResult(candidateQuery.data.value);
    else applyManualResult(manualCandidateQuery.data.value);
  }

  function clearCandidates() {
    candidateQuery.cancel();
    manualCandidateQuery.cancel();
    matchingResult.value = null;
    matchingError.value = '';
    form.accountId = '';
    selectedCandidateSnapshot.value = null;
  }

  function resetCandidateSelection() {
    if (matchingTimer) {
      clearTimeout(matchingTimer);
      matchingTimer = undefined;
    }
    if (manualSearchTimer) {
      clearTimeout(manualSearchTimer);
      manualSearchTimer = undefined;
    }
    resumeCandidateMatch = false;
    idSelectionMode.value = form.accountSource === 'customer_owned' ? 'manual' : 'auto';
    manualSearchKeyword.value = '';
    clearCandidates();
  }

  function stopDeferredCandidateTasks() {
    if (matchingTimer) {
      clearTimeout(matchingTimer);
      matchingTimer = undefined;
      resumeCandidateMatch = true;
    }
    if (manualSearchTimer) {
      clearTimeout(manualSearchTimer);
      manualSearchTimer = undefined;
      resumeCandidateMatch = true;
    }
    if (matchingLoading.value) {
      resumeCandidateMatch = true;
    }
    candidateQuery.cancel();
    manualCandidateQuery.cancel();
  }

  function automaticQueryKey() {
    return createV2QueryKey({
      serviceOptionId: form.serviceOptionId,
      balanceAmount: form.balanceAmount.trim(),
      accountSource: form.accountSource,
      customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
      limit: 50
    });
  }

  function manualQueryKey() {
    return createV2QueryKey({
      serviceOptionId: form.serviceOptionId,
      balanceAmount: form.balanceAmount.trim(),
      accountSource: form.accountSource,
      customerId: form.accountSource === 'customer_owned' ? form.customerId : undefined,
      keyword: manualSearchKeyword.value.trim(),
      limit: 50
    });
  }

  onActivated(() => {
    if (!canMatch.value) return;
    if (resumeCandidateMatch && canMatch.value) {
      resumeCandidateMatch = false;
      scheduleCandidateMatch();
      return;
    }
    void refreshCurrentCandidates();
  });
  onDeactivated(stopDeferredCandidateTasks);

  return {
    idSelectionMode,
    matchingLoading,
    matchingPhase,
    matchingParameterTransition,
    matchingError,
    matchingResult,
    candidateItems,
    selectedCandidate,
    canMatch,
    matchingEmptyMessage,
    handleIdSelectionModeChange,
    searchManualCandidates,
    scheduleCandidateMatch,
    loadCandidates,
    clearCandidates,
    resetCandidateSelection
  };
}
