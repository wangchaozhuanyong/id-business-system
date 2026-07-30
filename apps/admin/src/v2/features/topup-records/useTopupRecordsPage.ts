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
import {
  deltaType,
  formatDate,
  formatDecimal,
  formatOptionalDecimal,
  formatSignedCurrency,
  formatSignedDecimal,
  giftCardStatusLabel,
  giftCardStatusType,
  ledgerTypeLabel,
  ledgerTypeTag,
  readAccountId,
  readQueryString,
  readRecordsTab
} from './topup-records-format';
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
  V2OptionSelector
} from './contracts';
import { useGiftCardReversal } from './useGiftCardReversal';

export type RecordsTab = 'giftCards' | 'ledger' | 'suppliers' | 'payments';
type RecordsDataTab = Extract<RecordsTab, 'giftCards' | 'ledger'>;

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
  const canViewSupplierFunds = computed(() =>
    hasUserPermission(authStore.user, 'apple.topup_supplier_fund.view')
  );
  const canManageSupplierFunds = computed(() =>
    hasUserPermission(authStore.user, 'apple.topup_supplier_fund.manage')
  );
  const canRevealGiftCard = computed(() =>
    hasUserPermission(authStore.user, 'apple.gift_card.view_full')
  );
  const canReassignSupplier = computed(
    () => canAdjustBalance.value && canManageSupplierFunds.value
  );
  const canReportAccountLoss = computed(
    () => canAdjustBalance.value && hasUserPermission(authStore.user, 'apple.account.update')
  );
  const requestedTab = readRecordsTab(route.query.tab);
  const activeTab = ref<RecordsTab>(
    (requestedTab === 'suppliers' || requestedTab === 'payments') && !canViewSupplierFunds.value
      ? 'giftCards'
      : requestedTab
  );
  const recordsDataTab = ref<RecordsDataTab>(activeTab.value === 'ledger' ? 'ledger' : 'giftCards');
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
  const supplierDrawerVisible = ref(false);
  const supplierSubmitting = ref(false);
  const revealDialogVisible = ref(false);
  const revealSubmitting = ref(false);
  const revealedGiftCardCode = ref('');
  const revealReason = ref('');

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
    remark: ''
  });
  const supplierForm = reactive({
    supplierOptionId: '',
    reason: '',
    idempotencyKey: ''
  });
  const metadataDisabledReason = computed(() =>
    selectedGiftCard.value ? '' : '未选择需要修改的礼品卡记录'
  );

  function getRecordsRequest(): RecordsRequest {
    const common = {
      keyword: filters.keyword.trim() || undefined,
      accountId: filters.accountId || undefined,
      countryOptionId: filters.countryOptionId || undefined,
      supplierOptionId: filters.supplierOptionId || undefined,
      dateFrom: filters.dateRange[0] || undefined,
      dateTo: filters.dateRange[1] || undefined
    };
    return recordsDataTab.value === 'giftCards'
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
        {}
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

  async function loadGiftCards() {
    if (activeTab.value !== 'giftCards') return;
    await recordsQuery.refresh();
  }
  const giftCardReversal = useGiftCardReversal({
    canAdjustBalance,
    canReportAccountLoss,
    reloadGiftCards: loadGiftCards
  });

  async function loadBalanceLedger() {
    if (activeTab.value !== 'ledger') return;
    await recordsQuery.refresh();
  }

  function loadActiveTab() {
    return activeTab.value === 'giftCards'
      ? loadGiftCards()
      : activeTab.value === 'ledger'
        ? loadBalanceLedger()
        : Promise.resolve();
  }

  function handleTabChange() {
    syncRouteScope();
    if (activeTab.value === 'giftCards' || activeTab.value === 'ledger') {
      recordsDataTab.value = activeTab.value;
      void recordsQuery.ensureFresh();
    }
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
    metadataForm.remark = giftCard.remark ?? '';
    metadataDrawerVisible.value = true;
  }

  async function submitMetadata() {
    const giftCard = selectedGiftCard.value;
    if (!giftCard || metadataSubmitting.value) return;

    metadataSubmitting.value = true;
    try {
      await idBusinessV2BalancesApi.updateGiftCardMetadata(giftCard.id, {
        remark: metadataForm.remark.trim() || null
      });
      ElMessage.success('备注已更新，账务字段未变更');
      metadataDrawerVisible.value = false;
      selectedGiftCard.value = null;
      await loadGiftCards();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      metadataSubmitting.value = false;
    }
  }

  function openSupplierDrawer(giftCard: V2GiftCardRecord) {
    selectedGiftCard.value = giftCard;
    Object.assign(supplierForm, {
      supplierOptionId: giftCard.supplierOptionId ?? '',
      reason: '',
      idempotencyKey: globalThis.crypto.randomUUID()
    });
    supplierDrawerVisible.value = true;
  }

  const supplierDisabledReason = computed(() => {
    const giftCard = selectedGiftCard.value;
    if (!giftCard) return '未选择需要更正的礼品卡记录';
    if (!canReassignSupplier.value) return '当前账号缺少余额调整或供应商资金管理权限';
    if (!supplierForm.supplierOptionId) return '请选择新的供应商';
    if (supplierForm.supplierOptionId === giftCard.supplierOptionId)
      return '新供应商不能与原供应商相同';
    const supplier = topupSupplierOptions.value.find(
      (item) => item.id === supplierForm.supplierOptionId
    );
    if (!supplier) return '所选供应商已不可用';
    if (supplierForm.reason.trim().length < 2) return '更正原因至少填写 2 个字符';
    return '';
  });

  async function submitSupplierReassignment() {
    const giftCard = selectedGiftCard.value;
    if (!giftCard || supplierSubmitting.value || supplierDisabledReason.value) return;
    supplierSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.reassignGiftCardSupplier(giftCard.id, {
        supplierOptionId: supplierForm.supplierOptionId,
        reason: supplierForm.reason.trim(),
        idempotencyKey: supplierForm.idempotencyKey
      });
      ElMessage.success(
        result.legacyCutoverRecord
          ? '切账前记录的供应商归属已更正，未生成资金流水'
          : '供应商已更正，原供应商返还与新供应商扣款已同时入账'
      );
      supplierDrawerVisible.value = false;
      selectedGiftCard.value = null;
      await loadGiftCards();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      supplierSubmitting.value = false;
    }
  }

  function openRevealDialog(giftCard: V2GiftCardRecord) {
    selectedGiftCard.value = giftCard;
    revealReason.value = '';
    revealedGiftCardCode.value = '';
    revealDialogVisible.value = true;
  }

  const revealDisabledReason = computed(() => {
    if (!selectedGiftCard.value) return '未选择礼品卡记录';
    if (!canRevealGiftCard.value) return '当前账号无权查看完整礼品卡号';
    const length = revealReason.value.trim().length;
    return length >= 2 && length <= 200 ? '' : '查看原因必须为 2 至 200 个字符';
  });

  async function submitRevealGiftCard() {
    const giftCard = selectedGiftCard.value;
    if (!giftCard || revealSubmitting.value || revealDisabledReason.value) return;
    revealSubmitting.value = true;
    try {
      const result = await idBusinessV2BalancesApi.revealGiftCardCode(giftCard.id, {
        reason: revealReason.value.trim()
      });
      revealedGiftCardCode.value = result.code;
      ElMessage.success('完整卡号已临时解密，本次查看已记录审计');
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      revealSubmitting.value = false;
    }
  }

  watch(revealDialogVisible, (visible) => {
    if (visible) return;
    revealedGiftCardCode.value = '';
    revealReason.value = '';
  });

  function giftCardRowNumber(index: number) {
    return (giftCardQuery.page - 1) * giftCardQuery.pageSize + index + 1;
  }

  function ledgerRowNumber(index: number) {
    return (ledgerQuery.page - 1) * ledgerQuery.pageSize + index + 1;
  }

  return {
    canAdjustBalance,
    canViewSupplierFunds,
    canManageSupplierFunds,
    canRevealGiftCard,
    canReassignSupplier,
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
    supplierDrawerVisible,
    supplierSubmitting,
    revealDialogVisible,
    revealSubmitting,
    revealedGiftCardCode,
    revealReason,
    selectedGiftCard,
    filters,
    giftCardQuery,
    ledgerQuery,
    metadataForm,
    supplierForm,
    metadataDisabledReason,
    supplierDisabledReason,
    revealDisabledReason,
    activeLoading,
    activeError,
    activeResolved,
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
    openSupplierDrawer,
    submitSupplierReassignment,
    openRevealDialog,
    submitRevealGiftCard,
    ...giftCardReversal,
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
