import { computed, reactive, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2OptionsApi } from '@/v2/api/options';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { formatV2Decimal } from '@/v2/utils/decimal';
import { idBusinessV2AccountLossesApi } from './api';
import { useAccountLossRecovery } from './useAccountLossRecovery';
import type {
  V2AccountLossListQuery,
  V2AccountLossListResult,
  V2OptionSelector
} from './contracts';

interface AccountLossesPageSnapshot {
  list: V2AccountLossListResult;
  countries: V2OptionSelector[];
}

export function useAccountLossesPage() {
  const reportedRange = ref<[string, string] | []>([]);
  const query = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    countryOptionId: '',
    saleState: '' as 'available' | 'sold' | '',
    status: 'active' as 'active' | 'reversed' | '',
    sortBy: 'reportedAt' as NonNullable<V2AccountLossListQuery['sortBy']>,
    sortOrder: 'desc' as 'asc' | 'desc'
  });

  function getListQuery(): V2AccountLossListQuery {
    return {
      page: query.page,
      pageSize: query.pageSize,
      keyword: query.keyword.trim() || undefined,
      countryOptionId: query.countryOptionId || undefined,
      saleState: query.saleState || undefined,
      status: query.status || undefined,
      reportedFrom: reportedRange.value[0] || undefined,
      reportedTo: reportedRange.value[1] || undefined,
      sortBy: query.sortBy,
      sortOrder: query.sortOrder
    };
  }

  const accountLossesQuery = useV2ModuleQuery<AccountLossesPageSnapshot>({
    moduleKey: 'account-losses',
    scope: 'account-losses',
    key: () => createV2QueryKey(getListQuery()),
    keepPreviousData: true,
    query: async ({ signal }) => {
      const [list, countries] = await Promise.all([
        idBusinessV2AccountLossesApi.list(getListQuery(), { signal }),
        idBusinessV2OptionsApi.listSelectors('country')
      ]);
      return {
        list,
        countries: countries.items
      };
    }
  });

  const items = computed(() => accountLossesQuery.data.value?.list.items ?? []);
  const total = computed(() => accountLossesQuery.data.value?.list.total ?? 0);
  const displayedPage = computed(() => accountLossesQuery.data.value?.list.page ?? query.page);
  const displayedPageSize = computed(
    () => accountLossesQuery.data.value?.list.pageSize ?? query.pageSize
  );
  const countryOptions = computed(() => accountLossesQuery.data.value?.countries ?? []);
  const loading = computed(
    () => accountLossesQuery.isInitialLoading.value || accountLossesQuery.isRefreshing.value
  );
  const listError = computed(() =>
    accountLossesQuery.error.value ? getApiErrorMessage(accountLossesQuery.error.value) : ''
  );
  const { hasLoadedOnce, isInitialLoading } = accountLossesQuery;
  const accountLossRecovery = useAccountLossRecovery({
    refreshRecords: loadAccountLosses
  });

  function loadAccountLosses() {
    return accountLossesQuery.refresh();
  }

  function handleSearch() {
    query.page = 1;
    void accountLossesQuery.refresh();
  }

  function resetFilters() {
    query.page = 1;
    query.keyword = '';
    query.countryOptionId = '';
    query.saleState = '';
    query.status = 'active';
    query.sortBy = 'reportedAt';
    query.sortOrder = 'desc';
    reportedRange.value = [];
    void accountLossesQuery.refresh();
  }

  function handleSortChange(input: { prop?: string; order?: 'ascending' | 'descending' | null }) {
    if (
      input.prop !== 'reportedAt' &&
      input.prop !== 'lossBalance' &&
      input.prop !== 'lossCostAmount'
    ) {
      return;
    }
    query.sortBy = input.prop;
    query.sortOrder = input.order === 'ascending' ? 'asc' : 'desc';
    query.page = 1;
    void accountLossesQuery.refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void accountLossesQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void accountLossesQuery.ensureFresh();
  }

  function formatDate(value: string) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(new Date(value));
  }

  return {
    query,
    reportedRange,
    items,
    total,
    displayedPage,
    displayedPageSize,
    queryPhase: accountLossesQuery.phase,
    isParameterTransition: accountLossesQuery.isParameterTransition,
    countryOptions,
    loading,
    listError,
    hasLoadedOnce,
    isInitialLoading,
    ...accountLossRecovery,
    loadAccountLosses,
    handleSearch,
    handleFilterChange: handleSearch,
    resetFilters,
    handleSortChange,
    handlePageChange,
    handlePageSizeChange,
    formatDecimal: formatV2Decimal,
    formatDate
  };
}
