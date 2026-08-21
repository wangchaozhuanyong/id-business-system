import { reactive, ref } from 'vue';
import type { V2TrackedExchangeRateCurrency } from './contracts';

export function useExchangeRateFilters(options: { ensureFresh: () => Promise<unknown> }) {
  const recordDateRange = ref<[string, string] | []>([]);
  const manualDateRange = ref<[string, string] | []>([]);
  const recordQuery = reactive({
    page: 1,
    pageSize: 20,
    currency: '' as '' | V2TrackedExchangeRateCurrency,
    source: '' as '' | 'combined_p2p' | 'binance' | 'okx' | 'ecb_cross',
    status: '' as '' | 'available' | 'expired'
  });
  const manualQuery = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    currency: '' as '' | V2TrackedExchangeRateCurrency
  });

  function getRecordRequest() {
    return {
      ...recordQuery,
      currency: recordQuery.currency || undefined,
      source: recordQuery.source || undefined,
      status: recordQuery.status || undefined,
      capturedFrom: recordDateRange.value[0] || undefined,
      capturedTo: recordDateRange.value[1] || undefined,
      sortOrder: 'desc' as const
    };
  }

  function getManualRequest() {
    return {
      ...manualQuery,
      keyword: manualQuery.keyword.trim() || undefined,
      currency: manualQuery.currency || undefined,
      recordedFrom: manualDateRange.value[0] || undefined,
      recordedTo: manualDateRange.value[1] || undefined,
      sortOrder: 'desc' as const
    };
  }

  function searchRecords() {
    recordQuery.page = 1;
    void options.ensureFresh();
  }

  function handleRecordPageChange(page: number) {
    recordQuery.page = page;
    void options.ensureFresh();
  }

  function resetRecordPage(pageSize: number) {
    recordQuery.pageSize = pageSize;
    recordQuery.page = 1;
    void options.ensureFresh();
  }

  function searchManual() {
    manualQuery.page = 1;
    void options.ensureFresh();
  }

  function handleManualPageChange(page: number) {
    manualQuery.page = page;
    void options.ensureFresh();
  }

  function resetManualPage(pageSize: number) {
    manualQuery.pageSize = pageSize;
    manualQuery.page = 1;
    void options.ensureFresh();
  }

  return {
    recordDateRange,
    manualDateRange,
    recordQuery,
    manualQuery,
    getRecordRequest,
    getManualRequest,
    searchRecords,
    handleRecordPageChange,
    resetRecordPage,
    searchManual,
    handleManualPageChange,
    resetManualPage
  };
}
