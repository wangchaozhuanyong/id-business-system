import { computed, reactive, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import {
  createV2QueryKey,
  getV2QueryData,
  primeV2Query,
  useV2ModuleQuery
} from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { idBusinessV2BalancesApi } from './api';
import type {
  V2BalanceLedgerEntryType,
  V2BalanceLedgerListQuery,
  V2BalanceLedgerListResult,
  V2BalanceLedgerRecord,
  V2BalanceLedgerSortBy,
  V2GiftCardRecord,
  V2GiftCardRecordListQuery,
  V2GiftCardRecordListResult,
  V2GiftCardRecordSortBy,
  V2GiftCardRecordStatus,
  V2GiftCardReversalAction,
  V2OptionSelector
} from './contracts';

type RecordsTab = 'giftCards' | 'ledger';

interface RecordsReferenceOptions {
  countries: V2OptionSelector[];
  suppliers: V2OptionSelector[];
}

type RecordsPageSnapshot =
  | {
      tab: 'giftCards';
      list: V2GiftCardRecordListResult;
      options: RecordsReferenceOptions;
    }
  | {
      tab: 'ledger';
      list: V2BalanceLedgerListResult;
      options: RecordsReferenceOptions;
    };

type RecordsRequest =
  | ({ tab: 'giftCards' } & V2GiftCardRecordListQuery)
  | ({ tab: 'ledger' } & V2BalanceLedgerListQuery);

const RECORDS_OPTIONS_SCOPE = 'balance-record-options';
const RECORDS_OPTIONS_KEY = 'selectors';

export function useTopupRecordsPage() {
  const route = useRoute();
  const router = useRouter();
  const authStore = useAuthStore();
  const canAdjustBalance = computed(() =>
    hasUserPermission(authStore.user, 'apple.balance.adjust')
  );
  const activeTab = ref<RecordsTab>(readRecordsTab(route.query.tab));
  const countryOptions = ref<V2OptionSelector[]>([]);
  const topupSupplierOptions = ref<V2OptionSelector[]>([]);
  const giftCards = ref<V2GiftCardRecord[]>([]);
  const giftCardTotal = ref(0);
  const giftCardResolved = ref(false);
  const ledgerEntries = ref<V2BalanceLedgerRecord[]>([]);
  const ledgerTotal = ref(0);
  const ledgerResolved = ref(false);
  const metadataDrawerVisible = ref(false);
  const metadataSubmitting = ref(false);
  const selectedGiftCard = ref<V2GiftCardRecord | null>(null);
  const reversalDialogVisible = ref(false);
  const reversalSubmitting = ref(false);
  const pendingReversal = ref<{
    giftCard: V2GiftCardRecord;
    action: V2GiftCardReversalAction;
  } | null>(null);
  const reversalReason = ref('');
  const reversalIdempotencyKey = ref('');

  const filters = reactive({
    keyword: '',
    accountId: readAccountId(route.query.accountId),
    accountLabel: readQueryString(route.query.accountLabel, 255),
    countryOptionId: '',
    supplierOptionId: '',
    dateRange: [] as string[]
  });
  const giftCardQuery = reactive({
    page: 1,
    pageSize: 20,
    status: '' as V2GiftCardRecordStatus | '',
    sortBy: 'statusChangedAt' as V2GiftCardRecordSortBy,
    sortOrder: 'desc' as 'asc' | 'desc'
  });
  const ledgerQuery = reactive({
    page: 1,
    pageSize: 20,
    entryType: '' as V2BalanceLedgerEntryType | '',
    sortBy: 'createdAt' as V2BalanceLedgerSortBy,
    sortOrder: 'desc' as 'asc' | 'desc'
  });
  const metadataForm = reactive({
    supplierOptionId: '',
    remark: ''
  });

  function getRecordsRequest(): RecordsRequest {
    const common = {
      keyword: filters.keyword.trim() || undefined,
      accountId: filters.accountId || undefined,
      countryOptionId: filters.countryOptionId || undefined,
      supplierOptionId: filters.supplierOptionId || undefined,
      dateFrom: filters.dateRange[0] || undefined,
      dateTo: filters.dateRange[1] || undefined
    };
    return activeTab.value === 'giftCards'
      ? {
          tab: 'giftCards',
          ...common,
          page: giftCardQuery.page,
          pageSize: giftCardQuery.pageSize,
          status: giftCardQuery.status || undefined,
          sortBy: giftCardQuery.sortBy,
          sortOrder: giftCardQuery.sortOrder
        }
      : {
          tab: 'ledger',
          ...common,
          page: ledgerQuery.page,
          pageSize: ledgerQuery.pageSize,
          entryType: ledgerQuery.entryType || undefined,
          sortBy: ledgerQuery.sortBy,
          sortOrder: ledgerQuery.sortOrder
        };
  }

  const recordsQuery = useV2ModuleQuery<RecordsPageSnapshot>({
    moduleKey: 'topup-records',
    scope: 'balance-records',
    key: () => createV2QueryKey(getRecordsRequest()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const params = getRecordsRequest();
      const cachedOptions = getV2QueryData<RecordsReferenceOptions>(
        RECORDS_OPTIONS_SCOPE,
        RECORDS_OPTIONS_KEY,
        { tier: 'reference' }
      );
      if (!cachedOptions) {
        const result = await idBusinessV2BalancesApi.bootstrapRecords(params, { signal });
        primeV2Query({
          scope: RECORDS_OPTIONS_SCOPE,
          key: RECORDS_OPTIONS_KEY,
          data: result.options
        });
        return result;
      }
      if (params.tab === 'giftCards') {
        const { tab, ...listParams } = params;
        void tab;
        return {
          tab: 'giftCards',
          list: await idBusinessV2BalancesApi.listGiftCardRecords(listParams, { signal }),
          options: cachedOptions
        };
      }
      const { tab, ...listParams } = params;
      void tab;
      return {
        tab: 'ledger',
        list: await idBusinessV2BalancesApi.listBalanceLedger(listParams, { signal }),
        options: cachedOptions
      };
    }
  });
  watch(
    recordsQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      countryOptions.value = snapshot.options.countries;
      topupSupplierOptions.value = snapshot.options.suppliers;
      if (snapshot.tab === 'giftCards') {
        giftCards.value = snapshot.list.items;
        giftCardTotal.value = snapshot.list.total;
        giftCardResolved.value = true;
      } else {
        ledgerEntries.value = snapshot.list.items;
        ledgerTotal.value = snapshot.list.total;
        ledgerResolved.value = true;
      }
    },
    { immediate: true }
  );
  const activeLoading = computed(
    () => recordsQuery.isInitialLoading.value || recordsQuery.isRefreshing.value
  );
  const giftCardLoading = computed(() => activeTab.value === 'giftCards' && activeLoading.value);
  const ledgerLoading = computed(() => activeTab.value === 'ledger' && activeLoading.value);
  const activeError = computed(() =>
    recordsQuery.error.value ? getApiErrorMessage(recordsQuery.error.value) : ''
  );
  const activeResolved = computed(() =>
    activeTab.value === 'giftCards' ? giftCardResolved.value : ledgerResolved.value
  );
  const { isInitialLoading } = recordsQuery;
  const reversalDialogTitle = computed(() =>
    pendingReversal.value?.action === 'redeemed' ? '确认标记被赎回' : '确认撤回礼品卡'
  );
  const reversalConfirmText = computed(() =>
    pendingReversal.value?.action === 'redeemed' ? '确认被赎回并扣减' : '确认撤回并扣减'
  );
  const reversalMessage = computed(() => {
    const pending = pendingReversal.value;
    if (!pending) return '';
    const actionLabel = pending.action === 'redeemed' ? '标记为被赎回' : '撤回';
    return `确认将 ${pending.giftCard.codeMasked} ${actionLabel}，并从 ${
      pending.giftCard.account.appleIdMasked
    } 扣减余额 ${formatDecimal(pending.giftCard.faceValue)}。`;
  });

  async function loadGiftCards() {
    if (activeTab.value !== 'giftCards') return;
    await recordsQuery.refresh();
  }

  async function loadBalanceLedger() {
    if (activeTab.value !== 'ledger') return;
    await recordsQuery.refresh();
  }

  function loadActiveTab() {
    return activeTab.value === 'giftCards' ? loadGiftCards() : loadBalanceLedger();
  }

  function handleTabChange() {
    syncRouteScope();
    void recordsQuery.ensureFresh();
  }

  function handleSearch() {
    giftCardQuery.page = 1;
    ledgerQuery.page = 1;
    void recordsQuery.ensureFresh();
  }

  function handleFilterChange() {
    handleSearch();
  }

  function resetFilters() {
    Object.assign(filters, {
      keyword: '',
      countryOptionId: '',
      supplierOptionId: '',
      dateRange: []
    });
    Object.assign(giftCardQuery, {
      page: 1,
      status: '',
      sortBy: 'statusChangedAt',
      sortOrder: 'desc'
    });
    Object.assign(ledgerQuery, {
      page: 1,
      entryType: '',
      sortBy: 'createdAt',
      sortOrder: 'desc'
    });
    void recordsQuery.ensureFresh();
  }

  function clearAccountScope() {
    filters.accountId = '';
    filters.accountLabel = '';
    giftCardQuery.page = 1;
    ledgerQuery.page = 1;
    syncRouteScope();
    void recordsQuery.ensureFresh();
  }

  function syncRouteScope() {
    const query: Record<string, string> = { tab: activeTab.value };
    if (filters.accountId) {
      query.accountId = filters.accountId;
      if (filters.accountLabel) query.accountLabel = filters.accountLabel;
    }
    void router.replace({ path: '/v2/records/topups', query });
  }

  function handleGiftCardPageSizeChange() {
    giftCardQuery.page = 1;
    void recordsQuery.ensureFresh();
  }

  function handleLedgerPageSizeChange() {
    ledgerQuery.page = 1;
    void recordsQuery.ensureFresh();
  }

  function handleGiftCardPageChange() {
    void recordsQuery.ensureFresh();
  }

  function handleLedgerPageChange() {
    void recordsQuery.ensureFresh();
  }

  function handleGiftCardSortChange(sort: {
    prop?: string;
    order?: 'ascending' | 'descending' | null;
  }) {
    const supported = [
      'faceValue',
      'exchangeRate',
      'costAmount',
      'status',
      'statusChangedAt',
      'createdAt',
      'updatedAt'
    ] as const;
    giftCardQuery.sortBy =
      sort.prop && supported.includes(sort.prop as (typeof supported)[number])
        ? (sort.prop as V2GiftCardRecordSortBy)
        : 'statusChangedAt';
    giftCardQuery.sortOrder = sort.order === 'ascending' ? 'asc' : 'desc';
    giftCardQuery.page = 1;
    void recordsQuery.ensureFresh();
  }

  function handleLedgerSortChange(sort: {
    prop?: string;
    order?: 'ascending' | 'descending' | null;
  }) {
    const supported = [
      'balanceAmount',
      'costAmount',
      'balanceAfter',
      'costAfter',
      'createdAt'
    ] as const;
    ledgerQuery.sortBy =
      sort.prop && supported.includes(sort.prop as (typeof supported)[number])
        ? (sort.prop as V2BalanceLedgerSortBy)
        : 'createdAt';
    ledgerQuery.sortOrder = sort.order === 'ascending' ? 'asc' : 'desc';
    ledgerQuery.page = 1;
    void recordsQuery.ensureFresh();
  }

  function openMetadataDrawer(giftCard: V2GiftCardRecord) {
    selectedGiftCard.value = giftCard;
    metadataForm.supplierOptionId = giftCard.supplierOptionId ?? '';
    metadataForm.remark = giftCard.remark ?? '';
    metadataDrawerVisible.value = true;
  }

  async function submitMetadata() {
    const giftCard = selectedGiftCard.value;
    if (!giftCard || metadataSubmitting.value) return;

    metadataSubmitting.value = true;
    try {
      await idBusinessV2BalancesApi.updateGiftCardMetadata(giftCard.id, {
        supplierOptionId: metadataForm.supplierOptionId || null,
        remark: metadataForm.remark.trim() || null
      });
      ElMessage.success('供应商和备注已更新，账务字段未变更');
      metadataDrawerVisible.value = false;
      selectedGiftCard.value = null;
      await loadGiftCards();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      metadataSubmitting.value = false;
    }
  }

  function openReversalConfirmation(giftCard: V2GiftCardRecord, action: V2GiftCardReversalAction) {
    if (!canAdjustBalance.value || giftCard.status !== 'credited') return;
    pendingReversal.value = { giftCard, action };
    reversalReason.value = '';
    reversalIdempotencyKey.value = globalThis.crypto.randomUUID();
    reversalDialogVisible.value = true;
  }

  async function submitReversal() {
    const pending = pendingReversal.value;
    const reason = reversalReason.value.trim();
    if (!pending || reason.length < 2 || reversalSubmitting.value) return;

    reversalSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.reverseGiftCard(pending.giftCard.id, {
        action: pending.action,
        reason,
        idempotencyKey: reversalIdempotencyKey.value
      });
      ElMessage.success(
        result.idempotentReplay
          ? '该反向请求已经完成，未重复扣减'
          : result.action === 'redeemed'
            ? '礼品卡已标记被赎回，反向流水已生成'
            : '礼品卡已撤回，反向流水已生成'
      );
      reversalDialogVisible.value = false;
      pendingReversal.value = null;
      await loadGiftCards();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      reversalSubmitting.value = false;
    }
  }

  function giftCardRowNumber(index: number) {
    return (giftCardQuery.page - 1) * giftCardQuery.pageSize + index + 1;
  }

  function ledgerRowNumber(index: number) {
    return (ledgerQuery.page - 1) * ledgerQuery.pageSize + index + 1;
  }

  function giftCardStatusLabel(status: V2GiftCardRecordStatus) {
    return {
      credited: '加卡成功',
      redeemed: '被赎回',
      withdrawn: '已撤回'
    }[status];
  }

  function giftCardStatusType(status: V2GiftCardRecordStatus) {
    return status === 'credited' ? 'success' : status === 'redeemed' ? 'warning' : 'info';
  }

  function ledgerTypeLabel(entryType: V2BalanceLedgerEntryType) {
    return {
      gift_card_credit: '礼品卡入账',
      gift_card_redeemed: '被赎回扣减',
      gift_card_withdrawal: '撤回扣减',
      order_consumption: '订单扣减',
      order_consumption_reversal: '订单退款恢复',
      opening_balance: '期初余额',
      manual_adjustment: '手工修正'
    }[entryType];
  }

  function ledgerTypeTag(entryType: V2BalanceLedgerEntryType) {
    return entryType === 'gift_card_credit' || entryType === 'opening_balance'
      ? 'success'
      : entryType === 'gift_card_redeemed' || entryType === 'order_consumption'
        ? 'warning'
        : 'info';
  }

  function deltaType(value: string) {
    return Number(value) < 0 ? 'debit' : 'credit';
  }

  function formatSignedDecimal(value: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) return value;
    const formatted = formatDecimal(String(Math.abs(number)));
    return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
  }

  function formatSignedCurrency(value: string) {
    const number = Number(value);
    if (!Number.isFinite(number)) return `¥${value}`;
    const formatted = `¥${formatDecimal(String(Math.abs(number)))}`;
    return number > 0 ? `+${formatted}` : number < 0 ? `-${formatted}` : formatted;
  }

  function formatOptionalDecimal(value?: string) {
    return value === undefined ? '-' : formatDecimal(value);
  }

  function formatDecimal(value: string, maximumFractionDigits = 4) {
    const number = Number(value);
    return Number.isFinite(number)
      ? number.toLocaleString('zh-CN', { maximumFractionDigits })
      : value;
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

  function readRecordsTab(value: unknown): RecordsTab {
    const normalized = Array.isArray(value) ? value[0] : value;
    return normalized === 'ledger' ? 'ledger' : 'giftCards';
  }

  function readAccountId(value: unknown) {
    const normalized = readQueryString(value, 36);
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      normalized
    )
      ? normalized
      : '';
  }

  function readQueryString(value: unknown, maximumLength: number) {
    const normalized = Array.isArray(value) ? value[0] : value;
    return typeof normalized === 'string' ? normalized.trim().slice(0, maximumLength) : '';
  }

  return {
    canAdjustBalance,
    activeTab,
    countryOptions,
    topupSupplierOptions,
    giftCards,
    giftCardTotal,
    giftCardLoading,
    ledgerEntries,
    ledgerTotal,
    ledgerLoading,
    metadataDrawerVisible,
    metadataSubmitting,
    selectedGiftCard,
    reversalDialogVisible,
    reversalSubmitting,
    reversalReason,
    filters,
    giftCardQuery,
    ledgerQuery,
    metadataForm,
    activeLoading,
    activeError,
    activeResolved,
    reversalDialogTitle,
    reversalConfirmText,
    reversalMessage,
    isInitialLoading,
    loadGiftCards,
    loadBalanceLedger,
    loadActiveTab,
    handleTabChange,
    handleSearch,
    handleFilterChange,
    resetFilters,
    clearAccountScope,
    handleGiftCardPageSizeChange,
    handleLedgerPageSizeChange,
    handleGiftCardPageChange,
    handleLedgerPageChange,
    handleGiftCardSortChange,
    handleLedgerSortChange,
    openMetadataDrawer,
    submitMetadata,
    openReversalConfirmation,
    submitReversal,
    giftCardRowNumber,
    ledgerRowNumber,
    giftCardStatusLabel,
    giftCardStatusType,
    ledgerTypeLabel,
    ledgerTypeTag,
    deltaType,
    formatSignedDecimal,
    formatSignedCurrency,
    formatOptionalDecimal,
    formatDecimal,
    formatDate
  };
}
