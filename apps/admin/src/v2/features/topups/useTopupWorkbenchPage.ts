import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2BalancesApi, idBusinessV2ExchangeRatesApi } from './api';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  V2_DECIMAL_PLACES,
  addDecimalStrings,
  divideDecimalStrings,
  isV2UnsignedDecimal
} from '@/v2/utils/decimal';
import {
  buildManualGiftCardCreditPayload,
  normalizeGiftCardCode,
  resolveUsdtRateReference,
  type V2TopupUsdtRateReference
} from './gift-card-credit-form';
import { useTopupListQuery } from './topup-query';
import type {
  V2GiftCardPurchaseSources,
  V2GiftCardReversalAction,
  V2OptionSelector,
  V2ReversibleGiftCard,
  V2TopupSupplierFundSelector,
  V2TopupBalancePreset,
  V2TopupWorkbenchItem,
  V2TopupWorkbenchListQuery,
  V2TopupWorkbenchSortBy
} from './contracts';
import type { V2FinanceCurrency } from '@apple-business/shared';
import {
  buildPurchaseSourceOptions,
  calculateCreditCostPreview,
  effectiveRateUnavailableMessage,
  formatDate,
  formatDecimal,
  formatElapsed,
  formatTime,
  isValidBalanceInput,
  maskGiftCardCode,
  servicePath,
  toLocalDateTimeInput
} from './topup-workbench-support';

export function useTopupWorkbenchPage() {
  const items = ref<V2TopupWorkbenchItem[]>([]);
  const total = ref(0);
  const evaluatedAt = ref('');
  const countryOptions = ref<V2OptionSelector[]>([]);
  const topupSupplierOptions = ref<V2TopupSupplierFundSelector[]>([]);
  const purchaseSources = ref<V2GiftCardPurchaseSources>({
    financeAccounts: [],
    supplierWallets: []
  });
  const authStore = useAuthStore();
  const router = useRouter();
  const canTopup = computed(() => hasUserPermission(authStore.user, 'apple.balance.topup'));
  const canAdjustBalance = computed(() =>
    hasUserPermission(authStore.user, 'apple.balance.adjust')
  );
  const creditDrawerVisible = ref(false);
  const selectedAccount = ref<V2TopupWorkbenchItem | null>(null);
  const creditSubmitting = ref(false);
  const creditConfirmationVisible = ref(false);
  const creditIdempotencyKey = ref('');
  const exchangeRateLoading = ref(false);
  const exchangeRateResolved = ref(false);
  const exchangeRateMessage = ref('');
  const usdtRateReference = ref<V2TopupUsdtRateReference | null>(null);
  const reversalDrawerVisible = ref(false);
  const reversalAccount = ref<V2TopupWorkbenchItem | null>(null);
  const reversibleGiftCards = ref<V2ReversibleGiftCard[]>([]);
  const reversalLoading = ref(false);
  const reversalResolved = ref(false);
  const reversalError = ref('');
  const reversalLimited = ref(false);
  const reversalConfirmationVisible = ref(false);
  const pendingReversal = ref<{
    giftCard: V2ReversibleGiftCard;
    action: V2GiftCardReversalAction;
  } | null>(null);
  const reversalIdempotencyKey = ref('');
  const reversalSubmitting = ref(false);
  const creditForm = reactive({
    code: '',
    faceValue: '',
    purchaseOriginalAmount: '',
    purchaseCurrency: 'CNY' as V2FinanceCurrency,
    purchaseFxRateToCny: '',
    purchaseSourceId: '',
    purchaseManualRateReason: '',
    paidAt: toLocalDateTimeInput(new Date()),
    supplierOptionId: '',
    remark: ''
  });
  const reversalForm = reactive({
    reason: ''
  });
  const normalizedCreditCode = computed(() => normalizeGiftCardCode(creditForm.code));
  const creditCostPreview = computed(() => calculateCreditCostPreview(creditForm));
  const creditUnitCostPreview = computed(() => {
    if (
      !creditCostPreview.value ||
      !isV2UnsignedDecimal(creditForm.faceValue, { allowZero: false })
    ) {
      return '';
    }
    return divideDecimalStrings(creditCostPreview.value, creditForm.faceValue, 8);
  });
  const purchaseSourceOptions = computed(() =>
    buildPurchaseSourceOptions(purchaseSources.value, creditForm)
  );
  const selectedPurchaseSource = computed(
    () =>
      purchaseSourceOptions.value.find((source) => source.value === creditForm.purchaseSourceId) ??
      null
  );
  const creditProjectedSupplierBalance = computed(() => {
    if (
      selectedPurchaseSource.value?.kind !== 'wallet' ||
      !isV2UnsignedDecimal(creditForm.purchaseOriginalAmount)
    ) {
      return null;
    }
    return addDecimalStrings(
      selectedPurchaseSource.value.currentBalance,
      `-${creditForm.purchaseOriginalAmount}`
    );
  });
  const creditWillOverdraw = computed(
    () => creditProjectedSupplierBalance.value?.startsWith('-') ?? false
  );
  const creditDisabledReason = computed(() => {
    if (!selectedAccount.value) return '请先选择目标 ID';
    if (!topupSupplierOptions.value.length) return '暂无启用的加卡供应商';
    if (!creditForm.purchaseSourceId) return '请选择实际付款账户或供应商预存钱包';
    if (creditWillOverdraw.value) return '供应商钱包余额不足，不能继续加卡';
    return '';
  });
  const creditConfirmationMessage = computed(() => {
    if (!selectedAccount.value) return '';
    const supplierBalanceText =
      selectedPurchaseSource.value?.kind === 'wallet'
        ? `供应商钱包余额将从 ${formatDecimal(
            selectedPurchaseSource.value.currentBalance
          )} 变为 ${formatDecimal(creditProjectedSupplierBalance.value ?? '0')} ${
            creditForm.purchaseCurrency
          }。`
        : '';
    return `确认向 ${selectedAccount.value.appleIdMasked} 入账礼品卡 ${maskGiftCardCode(
      normalizedCreditCode.value
    )}，增加余额 ${creditForm.faceValue}，实际支付 ${formatDecimal(
      creditForm.purchaseOriginalAmount
    )} ${creditForm.purchaseCurrency}，人民币成本${
      creditCostPreview.value ? `约 ¥${formatDecimal(creditCostPreview.value)}` : '按交易汇率计算'
    }。${supplierBalanceText}确认后将立即写入两套独立的不可变流水。`;
  });
  const reversalDialogTitle = computed(() =>
    pendingReversal.value?.action === 'redeemed' ? '确认标记被赎回' : '确认撤回礼品卡'
  );
  const reversalConfirmText = computed(() =>
    pendingReversal.value?.action === 'redeemed' ? '确认被赎回并扣减' : '确认撤回并扣减'
  );
  const reversalConfirmationMessage = computed(() => {
    if (!pendingReversal.value || !reversalAccount.value) return '';
    const actionLabel = pendingReversal.value.action === 'redeemed' ? '标记为被赎回' : '撤回';
    return `确认将礼品卡 ${pendingReversal.value.giftCard.codeMasked} ${actionLabel}，并从 ${
      reversalAccount.value.appleIdMasked
    } 扣减余额 ${formatDecimal(
      pendingReversal.value.giftCard.faceValue
    )}。人民币成本将按执行时的移动平均成本结转。`;
  });
  let reversalLoadSequence = 0;

  const query = reactive({
    page: 1,
    pageSize: 20,
    countryOptionId: '',
    balancePreset: '' as V2TopupBalancePreset,
    balanceMin: '',
    balanceMax: '',
    onlyNormal: true,
    sortBy: 'updatedAt' as V2TopupWorkbenchSortBy,
    sortOrder: 'desc' as 'asc' | 'desc'
  });

  function getTopupListQuery(): V2TopupWorkbenchListQuery {
    return {
      page: query.page,
      pageSize: query.pageSize,
      countryOptionId: query.countryOptionId || undefined,
      balancePreset: query.balancePreset || undefined,
      balanceMin:
        query.balancePreset === 'custom' ? query.balanceMin.trim() || undefined : undefined,
      balanceMax:
        query.balancePreset === 'custom' ? query.balanceMax.trim() || undefined : undefined,
      onlyNormal: query.onlyNormal,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    };
  }

  const topupQuery = useTopupListQuery(getTopupListQuery);
  watch(
    topupQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      items.value = snapshot.list.items;
      total.value = snapshot.list.total;
      evaluatedAt.value = snapshot.list.evaluatedAt;
      countryOptions.value = snapshot.options.countries;
      topupSupplierOptions.value = snapshot.options.suppliers;
      purchaseSources.value = snapshot.options.purchaseSources;
    },
    { immediate: true }
  );
  const loading = computed(
    () => topupQuery.isInitialLoading.value || topupQuery.isRefreshing.value
  );
  const listError = computed(() =>
    topupQuery.error.value ? getApiErrorMessage(topupQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = topupQuery;

  function validateBalanceFilters() {
    if (query.balancePreset === 'custom') {
      const minimum = query.balanceMin.trim();
      const maximum = query.balanceMax.trim();
      if (!minimum && !maximum) {
        ElMessage.warning('自定义余额范围至少填写一项');
        return false;
      }
      if (!isValidBalanceInput(minimum) || !isValidBalanceInput(maximum)) {
        ElMessage.warning(`余额必须是最多 ${V2_DECIMAL_PLACES} 位小数的非负数字`);
        return false;
      }
      if (minimum && maximum && Number(minimum) > Number(maximum)) {
        ElMessage.warning('最低余额不能大于最高余额');
        return false;
      }
    }
    return true;
  }

  async function loadWorkbench() {
    if (!validateBalanceFilters()) return;
    await topupQuery.refresh();
  }

  function loadCurrentWorkbench() {
    if (!validateBalanceFilters()) return;
    void topupQuery.ensureFresh();
  }

  function handleSearch() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handleFilterChange() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handleBalancePresetChange() {
    if (query.balancePreset !== 'custom') {
      query.balanceMin = '';
      query.balanceMax = '';
      handleFilterChange();
    }
  }

  function resetFilters() {
    Object.assign(query, {
      page: 1,
      countryOptionId: '',
      balancePreset: '',
      balanceMin: '',
      balanceMax: '',
      onlyNormal: true,
      sortBy: 'updatedAt',
      sortOrder: 'desc'
    });
    loadCurrentWorkbench();
  }

  function handlePageSizeChange() {
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handlePageChange() {
    loadCurrentWorkbench();
  }

  function handleSortChange(sort: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    const supported = ['appleId', 'currentBalance', 'balanceCostAmount', 'updatedAt'] as const;
    query.sortBy =
      sort.prop && supported.includes(sort.prop as (typeof supported)[number])
        ? (sort.prop as V2TopupWorkbenchSortBy)
        : 'updatedAt';
    query.sortOrder = sort.order === 'descending' ? 'desc' : 'asc';
    query.page = 1;
    loadCurrentWorkbench();
  }

  function openCreditDrawer(account: V2TopupWorkbenchItem) {
    selectedAccount.value = account;
    creditDrawerVisible.value = true;
    creditConfirmationVisible.value = false;
    creditIdempotencyKey.value = createIdempotencyKey();
    Object.assign(creditForm, {
      code: '',
      faceValue: '',
      purchaseOriginalAmount: '',
      purchaseCurrency: 'CNY',
      purchaseFxRateToCny: '',
      purchaseSourceId: '',
      purchaseManualRateReason: '',
      paidAt: toLocalDateTimeInput(new Date()),
      supplierOptionId: '',
      remark: ''
    });
    usdtRateReference.value = null;
    exchangeRateMessage.value = '';
    exchangeRateResolved.value = false;
    void loadUsdtRateReference();
  }

  async function loadUsdtRateReference() {
    exchangeRateLoading.value = true;
    try {
      const overview = await idBusinessV2ExchangeRatesApi.overview();
      usdtRateReference.value = resolveUsdtRateReference(overview);
      exchangeRateMessage.value = usdtRateReference.value
        ? ''
        : effectiveRateUnavailableMessage(overview.effective.reason);
    } catch (error) {
      usdtRateReference.value = null;
      exchangeRateMessage.value = `USDT 汇率读取失败：${getApiErrorMessage(error)}`;
    } finally {
      exchangeRateResolved.value = true;
      exchangeRateLoading.value = false;
    }
  }

  function openAccountRecords(account: V2TopupWorkbenchItem, tab: 'giftCards' | 'ledger') {
    void router.push({
      path: '/v2/records/topups',
      query: {
        tab,
        accountId: account.id,
        accountLabel: account.appleIdMasked
      }
    });
  }

  function normalizeCandidateCode() {
    creditForm.code = normalizedCreditCode.value;
  }

  function handlePurchaseCurrencyChange() {
    creditForm.purchaseSourceId = '';
    if (creditForm.purchaseCurrency === 'CNY') {
      creditForm.purchaseFxRateToCny = '';
      creditForm.purchaseManualRateReason = '';
    }
  }

  function handleSupplierChange() {
    if (creditForm.purchaseSourceId.startsWith('wallet:')) {
      creditForm.purchaseSourceId = '';
    }
  }

  function openCreditConfirmation() {
    normalizeCandidateCode();
    if (creditDisabledReason.value) {
      ElMessage.warning(creditDisabledReason.value);
      return;
    }
    creditConfirmationVisible.value = true;
  }

  async function submitGiftCardCredit() {
    if (!selectedAccount.value || creditDisabledReason.value || creditSubmitting.value) return;

    creditSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.confirmGiftCardCredit(
        selectedAccount.value.id,
        buildManualGiftCardCreditPayload({
          code: normalizedCreditCode.value,
          faceValue: creditForm.faceValue,
          purchaseOriginalAmount: creditForm.purchaseOriginalAmount,
          purchaseCurrency: creditForm.purchaseCurrency,
          purchaseFxRateToCny: creditForm.purchaseFxRateToCny,
          purchaseSourceId: creditForm.purchaseSourceId,
          purchaseManualRateReason: creditForm.purchaseManualRateReason,
          paidAt: new Date(creditForm.paidAt).toISOString(),
          supplierOptionId: creditForm.supplierOptionId,
          idempotencyKey: creditIdempotencyKey.value,
          remark: creditForm.remark
        })
      );
      ElMessage.success(
        result.idempotentReplay ? '该请求已经完成，未重复入账' : '礼品卡已确认入账'
      );
      creditConfirmationVisible.value = false;
      creditDrawerVisible.value = false;
      await loadWorkbench();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      creditSubmitting.value = false;
    }
  }

  function openReversalDrawer(account: V2TopupWorkbenchItem) {
    if (!account.topupRecordCount) return;
    reversalAccount.value = account;
    reversibleGiftCards.value = [];
    reversalError.value = '';
    reversalResolved.value = false;
    reversalLimited.value = false;
    pendingReversal.value = null;
    reversalForm.reason = '';
    reversalConfirmationVisible.value = false;
    reversalDrawerVisible.value = true;
    void loadReversibleGiftCards();
  }

  async function loadReversibleGiftCards() {
    const account = reversalAccount.value;
    if (!account) return;

    const requestSequence = ++reversalLoadSequence;
    reversalLoading.value = true;
    reversalError.value = '';
    try {
      const result = await idBusinessV2BalancesApi.listReversibleGiftCards(account.id);
      if (requestSequence !== reversalLoadSequence || reversalAccount.value?.id !== account.id)
        return;
      reversibleGiftCards.value = result.items;
      reversalLimited.value = result.limited;
      reversalResolved.value = true;
    } catch (error) {
      if (requestSequence !== reversalLoadSequence || reversalAccount.value?.id !== account.id)
        return;
      reversibleGiftCards.value = [];
      reversalLimited.value = false;
      reversalError.value = getApiErrorMessage(error);
    } finally {
      if (requestSequence === reversalLoadSequence) reversalLoading.value = false;
    }
  }

  function openReversalConfirmation(
    giftCard: V2ReversibleGiftCard,
    action: V2GiftCardReversalAction
  ) {
    if (!canAdjustBalance.value) {
      ElMessage.error('当前账号没有余额修正权限');
      return;
    }
    pendingReversal.value = { giftCard, action };
    reversalForm.reason = '';
    reversalIdempotencyKey.value = createIdempotencyKey();
    reversalConfirmationVisible.value = true;
  }

  async function submitGiftCardReversal() {
    const pending = pendingReversal.value;
    const reason = reversalForm.reason.trim();
    if (!pending || reversalSubmitting.value) return;
    if (reason.length < 2) {
      ElMessage.warning('处理原因至少填写 2 个字符');
      return;
    }

    reversalSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.reverseGiftCard(pending.giftCard.id, {
        action: pending.action,
        reason,
        idempotencyKey: reversalIdempotencyKey.value
      });
      if (reversalAccount.value?.id === result.account.id) {
        reversalAccount.value = {
          ...reversalAccount.value,
          currentBalance: result.account.currentBalance,
          balanceCostAmount: result.account.balanceCostAmount,
          balanceChangeCount:
            reversalAccount.value.balanceChangeCount + (result.idempotentReplay ? 0 : 1)
        };
      }
      ElMessage.success(
        result.idempotentReplay
          ? '该反向请求已经完成，未重复扣减'
          : result.action === 'redeemed'
            ? '礼品卡已标记被赎回，余额与成本已扣减'
            : '礼品卡已撤回，余额与成本已扣减'
      );
      reversalConfirmationVisible.value = false;
      pendingReversal.value = null;
      await Promise.all([loadReversibleGiftCards(), loadWorkbench()]);
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      reversalSubmitting.value = false;
    }
  }

  function createIdempotencyKey() {
    return globalThis.crypto.randomUUID();
  }

  return {
    items,
    total,
    evaluatedAt,
    loading,
    listError,
    countryOptions,
    topupSupplierOptions,
    purchaseSources,
    canTopup,
    canAdjustBalance,
    creditDrawerVisible,
    selectedAccount,
    creditSubmitting,
    creditConfirmationVisible,
    exchangeRateLoading,
    exchangeRateResolved,
    exchangeRateMessage,
    usdtRateReference,
    reversalDrawerVisible,
    reversalAccount,
    reversibleGiftCards,
    reversalLoading,
    reversalResolved,
    reversalError,
    reversalLimited,
    reversalConfirmationVisible,
    pendingReversal,
    reversalForm,
    reversalSubmitting,
    creditForm,
    normalizedCreditCode,
    creditCostPreview,
    creditUnitCostPreview,
    purchaseSourceOptions,
    selectedPurchaseSource,
    creditProjectedSupplierBalance,
    creditWillOverdraw,
    creditDisabledReason,
    creditConfirmationMessage,
    reversalDialogTitle,
    reversalConfirmText,
    reversalConfirmationMessage,
    query,
    loadWorkbench,
    handleSearch,
    handleFilterChange,
    handleBalancePresetChange,
    resetFilters,
    handlePageSizeChange,
    handlePageChange,
    handleSortChange,
    openCreditDrawer,
    openAccountRecords,
    normalizeCandidateCode,
    handlePurchaseCurrencyChange,
    handleSupplierChange,
    openCreditConfirmation,
    submitGiftCardCredit,
    openReversalDrawer,
    loadReversibleGiftCards,
    openReversalConfirmation,
    submitGiftCardReversal,
    formatDecimal,
    formatDate,
    formatTime,
    servicePath,
    formatElapsed,
    hasLoadedOnce,
    isInitialLoading
  };
}
