import { computed, ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery, useV2Query } from '@/v2/composables/useV2Query';
import { idBusinessV2OrdersApi } from './api';
import type { V2OrderEntryCustomer, V2OrderEntryOptions } from './contracts';

type OrderEntryOptionsQueryConfig =
  | {
      mode: 'module';
      moduleKey: 'order-entry';
    }
  | {
      mode: 'manual';
      freshnessPolicy: 'event-driven';
    };

const ORDER_ENTRY_OPTIONS_SCOPE = 'order-entry-options';

function normalizeCustomerKeyword(keyword: string) {
  return keyword.trim();
}

export function preserveSelectedOrderEntryCustomer(
  options: V2OrderEntryOptions,
  selectedCustomer: V2OrderEntryCustomer | null | undefined
) {
  if (
    !selectedCustomer ||
    options.customers.some((customer) => customer.id === selectedCustomer.id)
  ) {
    return options;
  }
  return {
    ...options,
    customers: [selectedCustomer, ...options.customers]
  };
}

export function getVisibleOrderEntryCustomers(
  customers: V2OrderEntryCustomer[],
  selectedCustomerId: string,
  pendingNewKeyword: boolean
) {
  if (!pendingNewKeyword) return customers;
  const selectedCustomer = customers.find((customer) => customer.id === selectedCustomerId);
  return selectedCustomer ? [selectedCustomer] : [];
}

export function useOrderEntryOptionsQuery(config: OrderEntryOptionsQueryConfig) {
  const customerKeyword = ref('');
  const key = () => createV2QueryKey({ customerKeyword: customerKeyword.value });
  const fetchOptions = ({ signal }: { signal: AbortSignal }) =>
    idBusinessV2OrdersApi.getEntryOptions(customerKeyword.value || undefined, { signal });

  const query =
    config.mode === 'module'
      ? useV2ModuleQuery<V2OrderEntryOptions>({
          moduleKey: config.moduleKey,
          scope: ORDER_ENTRY_OPTIONS_SCOPE,
          key,
          keepPreviousData: true,
          query: fetchOptions
        })
      : useV2Query<V2OrderEntryOptions>({
          scope: ORDER_ENTRY_OPTIONS_SCOPE,
          key,
          freshnessPolicy: config.freshnessPolicy,
          keepPreviousData: true,
          query: fetchOptions
        });

  const loading = computed(() => query.isInitialLoading.value || query.isRefreshing.value);
  const error = computed(() => (query.error.value ? getApiErrorMessage(query.error.value) : ''));
  const resolved = computed(() => query.hasData.value);
  const customerOptionsPending = computed(() => query.isPlaceholderData.value);

  function loadOptions(keyword = customerKeyword.value) {
    customerKeyword.value = normalizeCustomerKeyword(keyword);
    return query.ensureFresh();
  }

  function searchCustomers(keyword: string) {
    return loadOptions(keyword);
  }

  function retryOptions() {
    return query.refresh();
  }

  return {
    data: query.data,
    loading,
    error,
    resolved,
    customerOptionsPending,
    customerKeyword,
    loadOptions,
    searchCustomers,
    retryOptions,
    cancel: query.cancel
  };
}
