import { computed, reactive, ref, watch } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2BalancesApi, idBusinessV2ExchangeRatesApi } from './api';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  V2_DECIMAL_PLACES,
  formatV2Decimal,
  isV2UnsignedDecimal,
  multiplyDecimalStrings
} from '@/v2/utils/decimal';
import {
  buildManualGiftCardCreditPayload,
  resolveUsdtRateReference,
  type V2TopupUsdtRateReference
} from './gift-card-credit-form';
import { useTopupListQuery } from './topup-query';
import type {
  V2GiftCardReversalAction,
  V2OptionSelector,
  V2ReversibleGiftCard,
  V2TopupServiceSummary,
  V2TopupBalancePreset,
  V2TopupWorkbenchItem,
  V2TopupWorkbenchListQuery,
  V2TopupWorkbenchSortBy
} from './contracts';

export function useTopupWorkbenchPage() {
  const items = ref<V2TopupWorkbenchItem[]>([]);
  const total = ref(0);
  const evaluatedAt = ref('');
  const countryOptions = ref<V2OptionSelector[]>([]);
  const topupSupplierOptions = ref<V2OptionSelector[]>([]);
  const authStore = useAuthStore();
  const router = useRouter();
  const canTopup = computed(() => hasUserPermission(authStore.user, 'apple.balance.topup'));
  const canAdjustBalance = computed(() =>
    hasUserPermission(authStore.user, 'apple.balance.adjust')
  );
  const creditDrawerVisible = ref(false);
  const selectedAccount = ref<V2TopupWorkbenchItem | null>(null);
  const candidateCode = ref('');
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
  const reversalReason = ref('');
  const reversalIdempotencyKey = ref('');
  const reversalSubmitting = ref(false);
  const creditForm = reactive({
    faceValue: '',
    exchangeRate: '',
    supplierOptionId: '',
    remark: ''
  });
  const normalizedCreditCode = computed(() =>
    candidateCode.value.toUpperCase().replace(/[^A-Z0-9]/g, '')
  );
  const creditCostPreview = computed(() => {
    if (
      !isV2UnsignedDecimal(creditForm.faceValue) ||
      !isV2UnsignedDecimal(creditForm.exchangeRate)
    ) {
      return '0';
    }
    return multiplyDecimalStrings(creditForm.faceValue, creditForm.exchangeRate);
  });
  const canConfirmCredit = computed(
    () =>
      Boolean(selectedAccount.value) &&
      /^[A-Z0-9]{10,64}$/.test(normalizedCreditCode.value) &&
      /[A-Z]/.test(normalizedCreditCode.value) &&
      /\d/.test(normalizedCreditCode.value) &&
      isValidPositiveDecimal(creditForm.faceValue) &&
      isValidPositiveDecimal(creditForm.exchangeRate) &&
      Boolean(creditForm.supplierOptionId) &&
      !creditSubmitting.value
  );
  const creditConfirmationMessage = computed(() => {
    if (!selectedAccount.value) return '';
    return `确认向 ${selectedAccount.value.appleIdMasked} 入账礼品卡 ${maskGiftCardCode(
      normalizedCreditCode.value
    )}，增加余额 ${creditForm.faceValue}，人民币成本约 ¥${formatDecimal(
      creditCostPreview.value
    )}。确认后将立即写入余额与不可变流水。`;
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
    candidateCode.value = '';
    Object.assign(creditForm, {
      faceValue: '',
      exchangeRate: '',
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
    candidateCode.value = normalizedCreditCode.value;
  }

  function openCreditConfirmation() {
    normalizeCandidateCode();
    if (!canConfirmCredit.value) {
      ElMessage.warning('请核对礼品卡号、面值、汇率和供应商');
      return;
    }
    creditConfirmationVisible.value = true;
  }

  async function submitGiftCardCredit() {
    if (!selectedAccount.value || !canConfirmCredit.value || creditSubmitting.value) return;

    creditSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.confirmGiftCardCredit(
        selectedAccount.value.id,
        buildManualGiftCardCreditPayload({
          code: normalizedCreditCode.value,
          faceValue: creditForm.faceValue,
          exchangeRate: creditForm.exchangeRate,
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
    reversalReason.value = '';
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
    reversalReason.value = '';
    reversalIdempotencyKey.value = createIdempotencyKey();
    reversalConfirmationVisible.value = true;
  }

  async function submitGiftCardReversal() {
    const pending = pendingReversal.value;
    const reason = reversalReason.value.trim();
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

  function effectiveRateUnavailableMessage(reason: string | null) {
    if (reason === 'latest_attempt_failed') {
      return '最新一次 USDT 汇率采集失败，当前没有可展示的参考值。';
    }
    if (reason === 'stale') {
      return '最近一次 USDT 汇率已经过期，当前没有可展示的参考值。';
    }
    if (reason === 'emergency_disabled') {
      return 'USDT 汇率网络采集已关闭。';
    }
    if (reason === 'collection_in_progress') {
      return 'USDT 汇率正在采集中，请稍后查看。';
    }
    return '暂无可展示的 USDT 参考汇率。';
  }

  function maskGiftCardCode(value: string) {
    if (value.length < 8) return value;
    return `${value.slice(0, 4)}****${value.slice(-4)}`;
  }

  function isValidPositiveDecimal(value: string) {
    return isV2UnsignedDecimal(value, { allowZero: false });
  }

  function formatDecimal(value: string) {
    return formatV2Decimal(value);
  }

  function isValidBalanceInput(value: string) {
    return !value || isV2UnsignedDecimal(value);
  }

  function formatDate(value: string) {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  function formatTime(value: string) {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  function servicePath(service: V2TopupServiceSummary) {
    return service.parent ? `${service.parent.name} / ${service.name}` : service.name;
  }

  function formatElapsed(value: string | null) {
    if (!value) return '-';
    const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
    const hours = Math.floor(elapsed / 3_600_000);
    if (hours < 48) {
      return `${Math.max(1, hours)} 小时前`;
    }
    return `${Math.max(2, Math.floor(hours / 24))} 天前`;
  }

  return {
    items,
    total,
    evaluatedAt,
    loading,
    listError,
    countryOptions,
    topupSupplierOptions,
    canTopup,
    canAdjustBalance,
    creditDrawerVisible,
    selectedAccount,
    candidateCode,
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
    reversalReason,
    reversalSubmitting,
    creditForm,
    normalizedCreditCode,
    creditCostPreview,
    canConfirmCredit,
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
