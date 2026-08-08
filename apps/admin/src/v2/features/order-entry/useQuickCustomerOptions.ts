import { computed } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useV2Query } from '@/v2/composables/useV2Query';
import type { V2OptionSelector } from './contracts';
import { idBusinessV2CustomersApi } from './api';

interface QuickCustomerOptions {
  sources: V2OptionSelector[];
  tags: V2OptionSelector[];
}

export function useQuickCustomerOptions() {
  const optionsQuery = useV2Query<QuickCustomerOptions>({
    scope: 'customers-options',
    key: 'order-entry-quick-customer',
    freshnessPolicy: 'event-driven',
    query: async ({ signal }) => {
      const result = await idBusinessV2CustomersApi.bootstrap(
        {
          page: 1,
          pageSize: 1,
          sortBy: 'updatedAt',
          sortOrder: 'desc'
        },
        { signal }
      );
      return {
        sources: result.options.sources,
        tags: result.options.tags
      };
    }
  });

  return {
    sourceOptions: computed(() => optionsQuery.data.value?.sources ?? []),
    tagOptions: computed(() => optionsQuery.data.value?.tags ?? []),
    optionsLoading: computed(
      () => optionsQuery.isInitialLoading.value || optionsQuery.isRefreshing.value
    ),
    optionsError: computed(() =>
      optionsQuery.error.value ? getApiErrorMessage(optionsQuery.error.value) : ''
    ),
    loadOptions: optionsQuery.ensureFresh,
    retryOptions: optionsQuery.refresh
  };
}
