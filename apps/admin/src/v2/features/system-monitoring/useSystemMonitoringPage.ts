import { computed } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2SystemMonitoringApi } from './api';
import {
  exchangeRunStatusLabel,
  formatSystemMonitoringDate,
  systemMonitorStatusMeta,
  systemOverallStatusMeta
} from './system-monitoring-presentation';
import type { V2SystemMonitoringResponse } from './contracts';

export function useSystemMonitoringPage() {
  const systemQuery = useV2ModuleQuery<V2SystemMonitoringResponse>({
    moduleKey: 'system-monitoring',
    scope: 'dashboard',
    key: 'overview',
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 30_000,
    query: ({ signal }) => v2SystemMonitoringApi.overview({ signal })
  });

  const overview = computed(() => systemQuery.data.value ?? null);
  const loading = computed(
    () => systemQuery.isInitialLoading.value || systemQuery.isRefreshing.value
  );
  const error = computed(() =>
    systemQuery.error.value ? getApiErrorMessage(systemQuery.error.value) : ''
  );

  return {
    overview,
    loading,
    error,
    hasData: systemQuery.hasData,
    refresh: systemQuery.refresh,
    systemMonitorStatusMeta,
    systemOverallStatusMeta,
    formatSystemMonitoringDate,
    exchangeRunStatusLabel
  };
}
