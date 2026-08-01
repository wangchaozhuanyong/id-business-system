import { computed, reactive } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { v2BusinessMonitoringApi } from './api';
import {
  businessMonitoringCategoryLabel,
  businessMonitoringSeverityMeta,
  formatBusinessMonitoringDate
} from './business-monitoring-presentation';
import type {
  V2BusinessMonitoringCategory,
  V2BusinessMonitoringListQuery,
  V2BusinessMonitoringResponse,
  V2BusinessMonitoringSeverity
} from './contracts';

export function useBusinessMonitoringPage() {
  const router = useRouter();
  const query = reactive({
    page: 1,
    pageSize: 20,
    severity: '' as V2BusinessMonitoringSeverity | '',
    category: '' as V2BusinessMonitoringCategory | ''
  });

  function listQuery(): V2BusinessMonitoringListQuery {
    return {
      page: query.page,
      pageSize: query.pageSize,
      severity: query.severity || undefined,
      category: query.category || undefined
    };
  }

  const monitoringQuery = useV2ModuleQuery<V2BusinessMonitoringResponse>({
    moduleKey: 'business-monitoring',
    scope: 'dashboard',
    key: () => createV2QueryKey(listQuery()),
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 30_000,
    query: ({ signal }) => v2BusinessMonitoringApi.findings(listQuery(), { signal })
  });

  const items = computed(() => monitoringQuery.data.value?.result.items ?? []);
  const total = computed(() => monitoringQuery.data.value?.result.total ?? 0);
  const summary = computed(() => monitoringQuery.data.value?.summary ?? null);
  const rules = computed(() => monitoringQuery.data.value?.rules ?? []);
  const generatedAt = computed(() => monitoringQuery.data.value?.generatedAt ?? null);
  const loading = computed(
    () => monitoringQuery.isInitialLoading.value || monitoringQuery.isRefreshing.value
  );
  const error = computed(() =>
    monitoringQuery.error.value ? getApiErrorMessage(monitoringQuery.error.value) : ''
  );

  function refresh() {
    return monitoringQuery.refresh();
  }

  function handleFilterChange() {
    query.page = 1;
    void refresh();
  }

  function resetFilters() {
    query.page = 1;
    query.severity = '';
    query.category = '';
    void refresh();
  }

  function handlePageChange(page: number) {
    query.page = page;
    void monitoringQuery.ensureFresh();
  }

  function handlePageSizeChange(pageSize: number) {
    query.pageSize = pageSize;
    query.page = 1;
    void monitoringQuery.ensureFresh();
  }

  function openSource(route: string) {
    void navigateSafely(router, route);
  }

  return {
    query,
    items,
    total,
    summary,
    rules,
    generatedAt,
    loading,
    error,
    hasData: monitoringQuery.hasData,
    refresh,
    handleFilterChange,
    resetFilters,
    handlePageChange,
    handlePageSizeChange,
    openSource,
    businessMonitoringCategoryLabel,
    businessMonitoringSeverityMeta,
    formatBusinessMonitoringDate
  };
}
