import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2BalancesApi } from './api';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { V2_DECIMAL_PLACES, addDecimalStrings } from '@/v2/utils/decimal';
import { buildManualGiftCardCreditPayload, normalizeGiftCardCode } from './gift-card-credit-form';
import { useTopupListQuery } from './topup-query';
import type {
  V2GiftCardReversalAction,
  V2OptionSelector,
  V2ReversibleGiftCard,
  V2TopupSupplierFundSelector,
  V2TopupBalancePreset,
  V2TopupWorkbenchItem,
  V2TopupWorkbenchListQuery,
  V2TopupWorkbenchSortBy
} from './contracts';
import {
  calculateCreditCostPreview,
  formatDate,
  formatDecimal,
  formatElapsed,
  formatTime,
  isValidBalanceInput,
  servicePath,
  toLocalDateTimeInput
} from './topup-workbench-support';

export function useTopupWorkbenchPage() {
  const items = ref<V2TopupWorkbenchItem[]>([]);
  const total = ref(0);
  const evaluatedAt = ref('');
  const cardNameOptions = ref<V2OptionSelector[]>([]);
  const countryOptions = ref<V2OptionSelector[]>([]);
  const topupSupplierOptions = ref<V2TopupSupplierFundSelector[]>([]);
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
  const creditInitialSnapshot = ref('');
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
    cardNameOptionId: '',
    countryOptionId: '',
    code: '',
    faceValue: '',
    exchangeRate: '',
    supplierOptionId: '',
    creditedAt: toLocalDateTimeInput(new Date()),
    remark: ''
  });
  const reversalForm = reactive({
    reason: ''
  });
  const creditDirty = computed(
    () =>
      Boolean(creditInitialSnapshot.value) && snapshotCreditForm() !== creditInitialSnapshot.value
  );
  const normalizedCreditCode = computed(() => normalizeGiftCardCode(creditForm.code));
  const creditCostPreview = computed(() => calculateCreditCostPreview(creditForm));
  const selectedCardName = computed(
    () => cardNameOptions.value.find((item) => item.id === creditForm.cardNameOptionId) ?? null
  );
  const selectedCountry = computed(
    () => countryOptions.value.find((item) => item.id === creditForm.countryOptionId) ?? null
  );
  const selectedTopupSupplier = computed(
    () => topupSupplierOptions.value.find((item) => item.id === creditForm.supplierOptionId) ?? null
  );
  const creditProjectedSupplierBalance = computed(() => {
    if (
      !selectedTopupSupplier.value?.initialized ||
      selectedTopupSupplier.value.currentBalanceCny === null ||
      !creditCostPreview.value
    ) {
      return null;
    }
    return addDecimalStrings(
      selectedTopupSupplier.value.currentBalanceCny,
      `-${creditCostPreview.value}`
    );
  });
  const creditWillOverdraw = computed(
    () => creditProjectedSupplierBalance.value?.startsWith('-') ?? false
  );
  const creditDisabledReason = computed(() => {
    if (!selectedAccount.value) return '请先选择目标 ID';
    if (!cardNameOptions.value.length) return '暂无启用的卡片名称，请先到选项设置完成配置';
    if (!selectedCountry.value) return '目标 ID 国家不存在或已停用';
    if (!topupSupplierOptions.value.length) return '暂无启用的加卡供应商';
    if (selectedTopupSupplier.value && !selectedTopupSupplier.value.initialized) {
      return `加卡供应商“${selectedTopupSupplier.value.name}”资金账户尚未初始化`;
    }
    return '';
  });
  const creditConfirmationMessage = computed(() => {
    if (!selectedAccount.value) return '';
    const supplierBalanceText =
      selectedTopupSupplier.value?.currentBalanceCny != null &&
      creditProjectedSupplierBalance.value !== null
        ? `卡商预付款余额将从 ¥${formatDecimal(
            selectedTopupSupplier.value.currentBalanceCny
          )} 变为 ¥${formatDecimal(creditProjectedSupplierBalance.value)}。`
        : '';
    return `确认向 ${selectedAccount.value.appleIdMasked} 入账${
      selectedCardName.value?.name ?? '礼品卡'
    } ${normalizedCreditCode.value}，国家为 ${
      selectedCountry.value?.name ?? selectedAccount.value.country.name
    }，面值 ${creditForm.faceValue}，卡片汇率 ${creditForm.exchangeRate}，卡片价值${
      creditCostPreview.value ? ` ¥${formatDecimal(creditCostPreview.value)}` : '由系统计算'
    }。${supplierBalanceText}确认后将立即写入 ID 余额、卡商资金和财务流水。`;
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
      cardNameOptions.value = snapshot.options.cardNames;
      countryOptions.value = snapshot.options.countries;
      topupSupplierOptions.value = snapshot.options.suppliers;
    },
    { immediate: true }
  );
  const loading = computed(
    () => topupQuery.isInitialLoading.value || topupQuery.isRefreshing.value
  );
  const displayedPage = computed(() => topupQuery.data.value?.list.page ?? query.page);
  const displayedPageSize = computed(() => topupQuery.data.value?.list.pageSize ?? query.pageSize);
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

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    loadCurrentWorkbench();
  }

  function handlePageChange(page: number) {
    query.page = page;
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
      cardNameOptionId: cardNameOptions.value[0]?.id ?? '',
      countryOptionId: account.country.id,
      code: '',
      faceValue: '',
      exchangeRate: '',
      supplierOptionId: '',
      creditedAt: toLocalDateTimeInput(new Date()),
      remark: ''
    });
    creditInitialSnapshot.value = snapshotCreditForm();
  }

  function openAccountRecords(account: V2TopupWorkbenchItem, tab: 'giftCards' | 'ledger') {
    void navigateSafely(router, {
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

  function openCardNameOptions() {
    creditDrawerVisible.value = false;
    void navigateSafely(router, {
      path: '/v2/options',
      query: { type: 'gift_card_name' }
    });
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
          cardNameOptionId: creditForm.cardNameOptionId,
          countryOptionId: creditForm.countryOptionId,
          exchangeRate: creditForm.exchangeRate,
          supplierOptionId: creditForm.supplierOptionId,
          creditedAt: new Date(creditForm.creditedAt).toISOString(),
          idempotencyKey: creditIdempotencyKey.value,
          remark: creditForm.remark
        })
      );
      const successMessage = result.idempotentReplay
        ? '该请求已经完成，未重复入账'
        : '礼品卡已确认入账';
      if (result.supplierFunding?.isNegative) {
        ElMessage.warning(
          `${successMessage}；卡商预付款余额为负 ¥${formatDecimal(
            result.supplierFunding.shortfallCny
          )}`
        );
      } else {
        ElMessage.success(successMessage);
      }
      creditConfirmationVisible.value = false;
      creditDrawerVisible.value = false;
      void loadWorkbench();
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

  function snapshotCreditForm() {
    return JSON.stringify(creditForm);
  }

  return {
    items,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: topupQuery.phase,
    isParameterTransition: topupQuery.isParameterTransition,
    evaluatedAt,
    loading,
    listError,
    cardNameOptions,
    countryOptions,
    topupSupplierOptions,
    canTopup,
    canAdjustBalance,
    creditDrawerVisible,
    selectedAccount,
    creditSubmitting,
    creditConfirmationVisible,
    creditDirty,
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
    selectedCardName,
    selectedCountry,
    selectedTopupSupplier,
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
    openCardNameOptions,
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
