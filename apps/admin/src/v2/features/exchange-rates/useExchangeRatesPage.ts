import { computed, reactive, ref, watch } from 'vue';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2ExchangeRatesApi } from './api';
import { createV2QueryKey, primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2Decimal, isV2UnsignedDecimal, multiplyDecimalStrings } from '@/v2/utils/decimal';
import {
  currencyLabel,
  currencySymbol,
  defaultIntervals,
  failureLabel,
  failureReason,
  providerLabel,
  receiptFxSourceLabel,
  receiptFxStatusLabel,
  receiptFxStatusType,
  recordStatusLabel,
  recordStatusType,
  runStatusLabel,
  runStatusType,
  sideLabel,
  trackedCurrencies,
  triggerLabel
} from './exchangeRatePresentation';
import type {
  V2ExchangeRateRecord,
  V2ExchangeRateRecordListResult,
  V2ExchangeRateOverview,
  V2ExchangeRateReceiptFxRate,
  V2ExchangeRateRunDetail,
  V2ExchangeRateRunListResult,
  V2ExchangeRateRuntime,
  V2ManualFxRate,
  V2ManualFxRateListResult,
  V2TrackedExchangeRateCurrency
} from './contracts';

interface ExchangeRatePageSnapshot {
  overview: V2ExchangeRateOverview;
  runtime: V2ExchangeRateRuntime;
  runs?: V2ExchangeRateRunListResult;
  records?: V2ExchangeRateRecordListResult;
  manualEntries?: V2ManualFxRateListResult;
}

export function useExchangeRatesPage() {
  const authStore = useAuthStore();
  const activeTab = ref<'automatic' | 'manual'>('automatic');
  const overview = ref<V2ExchangeRateOverview | null>(null);
  const runtime = ref<V2ExchangeRateRuntime | null>(null);
  const collecting = ref(false);
  const records = ref<V2ExchangeRateRecord[]>([]);
  const recordTotal = ref(0);
  const recordResolved = ref(false);
  const recordDateRange = ref<[string, string] | []>([]);
  const manualEntries = ref<V2ManualFxRate[]>([]);
  const manualTotal = ref(0);
  const manualResolved = ref(false);
  const manualDateRange = ref<[string, string] | []>([]);
  const settingsVisible = ref(false);
  const settingsSaving = ref(false);
  const runDetailVisible = ref(false);
  const detailLoading = ref(false);
  const detailError = ref('');
  const runDetail = ref<V2ExchangeRateRunDetail | null>(null);
  const runDetailTarget = ref<string | null>(null);
  const manualCreateVisible = ref(false);
  const manualCreating = ref(false);
  const manualDetailVisible = ref(false);
  const manualDetail = ref<V2ManualFxRate | null>(null);

  const canCollect = computed(() =>
    hasUserPermission(authStore.user, 'apple.exchange_rate.collect')
  );
  const canManage = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.manage'));
  const canCreate = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.create'));
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
  const settingsForm = reactive({
    autoEnabled: true,
    intervalMinutes: 15,
    targetAmountRmb: '5000',
    retentionDays: 30
  });
  const manualForm = reactive({
    currency: 'MYR' as V2TrackedExchangeRateCurrency,
    rateToCny: '',
    recordedAt: new Date(),
    reason: '',
    sourceReference: ''
  });

  const latestFailureDescription = computed(() => {
    const run = overview.value?.latestRun;
    if (!run?.error) return '';
    return `${providerLabel(run.error.provider)} ${sideLabel(run.error.side)}：${failureReason(
      run.error
    )}。上次成功值已标记过期，不会自动带入加卡。`;
  });
  const manualPreview = computed(() => {
    const value = parseRate(manualForm.rateToCny);
    return value ? `${currencyLabel(manualForm.currency)} / CNY ${formatRate(value)}` : '-';
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

  function getPageKey(tab = activeTab.value) {
    return createV2QueryKey({
      tab,
      query: tab === 'automatic' ? getRecordRequest() : getManualRequest()
    });
  }

  function isDefaultAutomaticRequest() {
    return (
      activeTab.value === 'automatic' &&
      recordQuery.page === 1 &&
      recordQuery.pageSize === 20 &&
      !recordQuery.currency &&
      !recordQuery.source &&
      !recordQuery.status &&
      !recordDateRange.value.length &&
      manualQuery.page === 1 &&
      manualQuery.pageSize === 20 &&
      !manualQuery.keyword.trim() &&
      !manualQuery.currency &&
      !manualDateRange.value.length
    );
  }

  const exchangeRateQuery = useV2ModuleQuery<ExchangeRatePageSnapshot>({
    moduleKey: 'exchange-rates',
    scope: 'exchange-rates',
    key: () => getPageKey(),
    keepPreviousData: true,
    getRevalidateAt: (snapshot) =>
      snapshot.overview.effective.expiresAt ?? snapshot.overview.lastSuccess?.expiresAt ?? null,
    query: async ({ signal }) => {
      if (isDefaultAutomaticRequest()) {
        const result = await idBusinessV2ExchangeRatesApi.bootstrap(
          {
            runPage: 1,
            runPageSize: 10,
            recordPage: recordQuery.page,
            recordPageSize: recordQuery.pageSize,
            manualPage: manualQuery.page,
            manualPageSize: manualQuery.pageSize
          },
          { signal }
        );
        primeV2Query<ExchangeRatePageSnapshot>({
          scope: 'exchange-rates',
          key: getPageKey('manual'),
          data: {
            overview: result.overview,
            runtime: result.runtime,
            records: result.records,
            manualEntries: result.manualEntries
          }
        });
        return {
          overview: result.overview,
          runtime: result.runtime,
          runs: result.runs,
          records: result.records,
          manualEntries: result.manualEntries
        };
      }

      const [nextOverview, nextRuntime, list] = await Promise.all([
        idBusinessV2ExchangeRatesApi.overview({ signal }),
        idBusinessV2ExchangeRatesApi.runtime({ signal }),
        activeTab.value === 'automatic'
          ? idBusinessV2ExchangeRatesApi.listRecords(getRecordRequest(), { signal })
          : idBusinessV2ExchangeRatesApi.listManualRates(getManualRequest(), { signal })
      ]);
      return activeTab.value === 'automatic'
        ? {
            overview: nextOverview,
            runtime: nextRuntime,
            records: list as V2ExchangeRateRecordListResult
          }
        : {
            overview: nextOverview,
            runtime: nextRuntime,
            manualEntries: list as V2ManualFxRateListResult
          };
    }
  });
  watch(
    exchangeRateQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      overview.value = snapshot.overview;
      runtime.value = snapshot.runtime;
      if (snapshot.records) {
        records.value = snapshot.records.items;
        recordTotal.value = snapshot.records.total;
        recordResolved.value = true;
      }
      if (snapshot.manualEntries) {
        manualEntries.value = snapshot.manualEntries.items;
        manualTotal.value = snapshot.manualEntries.total;
        manualResolved.value = true;
      }
    },
    { immediate: true }
  );
  const headerLoading = computed(
    () => exchangeRateQuery.isInitialLoading.value || exchangeRateQuery.isRefreshing.value
  );
  const headerError = computed(() =>
    exchangeRateQuery.error.value ? getApiErrorMessage(exchangeRateQuery.error.value) : ''
  );
  const recordLoading = computed(() => activeTab.value === 'automatic' && headerLoading.value);
  const manualLoading = computed(() => activeTab.value === 'manual' && headerLoading.value);
  const recordError = computed(() => (activeTab.value === 'automatic' ? headerError.value : ''));
  const manualError = computed(() => (activeTab.value === 'manual' ? headerError.value : ''));
  const receiptFxRates = computed(() => overview.value?.latestReceiptFxRates ?? []);

  function loadHeader() {
    return exchangeRateQuery.refresh();
  }

  function loadRecords() {
    return activeTab.value === 'automatic'
      ? exchangeRateQuery.refresh()
      : Promise.resolve(undefined);
  }

  function loadManualEntries() {
    return activeTab.value === 'manual' ? exchangeRateQuery.refresh() : Promise.resolve(undefined);
  }

  function loadAll() {
    return exchangeRateQuery.refresh();
  }

  function searchRecords() {
    recordQuery.page = 1;
    void exchangeRateQuery.ensureFresh();
  }
  function resetRecordPage() {
    recordQuery.page = 1;
    void exchangeRateQuery.ensureFresh();
  }
  function searchManual() {
    manualQuery.page = 1;
    void exchangeRateQuery.ensureFresh();
  }
  function resetManualPage() {
    manualQuery.page = 1;
    void exchangeRateQuery.ensureFresh();
  }

  async function collectNow() {
    collecting.value = true;
    try {
      const result = await idBusinessV2ExchangeRatesApi.collect();
      if (result.status === 'success') {
        ElMessage.success(`汇率采集成功：${result.successfulCurrencies.join('、')}`);
      } else if (result.status === 'partial_failed') {
        ElMessage.warning(
          `汇率部分成功：${result.successfulCurrencies.join('、')}；失败：${result.failedCurrencies.join('、')}`
        );
      } else {
        ElMessage.error(`汇率采集失败：${result.failedCurrencies.join('、')}`);
      }
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      collecting.value = false;
      await exchangeRateQuery.refresh();
    }
  }

  function openSettings() {
    const current = runtime.value?.settings;
    if (current) {
      Object.assign(settingsForm, {
        autoEnabled: current.autoEnabled,
        intervalMinutes: current.intervalMinutes,
        targetAmountRmb: current.targetAmountRmb,
        retentionDays: current.retentionDays
      });
    }
    settingsVisible.value = true;
  }

  async function saveSettings() {
    const amount = Number(settingsForm.targetAmountRmb);
    if (
      !isV2UnsignedDecimal(settingsForm.targetAmountRmb, { allowZero: false }) ||
      !Number.isFinite(amount) ||
      amount > 1_000_000 ||
      !Number.isInteger(settingsForm.retentionDays) ||
      settingsForm.retentionDays < (runtime.value?.settings.allowedRetentionDays.min ?? 7) ||
      settingsForm.retentionDays > (runtime.value?.settings.allowedRetentionDays.max ?? 3650)
    ) {
      return;
    }
    settingsSaving.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.updateSettings({
        autoEnabled: settingsForm.autoEnabled,
        intervalMinutes: settingsForm.intervalMinutes,
        targetAmountRmb: settingsForm.targetAmountRmb.trim(),
        retentionDays: settingsForm.retentionDays
      });
      settingsVisible.value = false;
      ElMessage.success(settingsForm.autoEnabled ? '设置已保存，已安排立即采集' : '自动采集已关闭');
      await exchangeRateQuery.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      settingsSaving.value = false;
    }
  }

  async function openRun(runId: string) {
    runDetailTarget.value = runId;
    runDetailVisible.value = true;
    detailLoading.value = true;
    detailError.value = '';
    runDetail.value = null;
    try {
      runDetail.value = await idBusinessV2ExchangeRatesApi.getRun(runId);
    } catch (error) {
      detailError.value = getApiErrorMessage(error);
    } finally {
      detailLoading.value = false;
    }
  }

  function retryRunDetail() {
    if (runDetailTarget.value) void openRun(runDetailTarget.value);
  }

  function openRecordEvidence(record: V2ExchangeRateRecord) {
    if (record.exchangeRateRunId) void openRun(record.exchangeRateRunId);
  }

  function openManualCreate() {
    Object.assign(manualForm, {
      currency: 'MYR',
      rateToCny: '',
      recordedAt: new Date(),
      reason: '',
      sourceReference: ''
    });
    manualCreateVisible.value = true;
  }

  async function createManualEntry() {
    if (!parseRate(manualForm.rateToCny) || manualForm.reason.trim().length < 2) {
      return;
    }
    manualCreating.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.createManualRate({
        currency: manualForm.currency,
        rateToCny: manualForm.rateToCny.trim(),
        recordedAt: manualForm.recordedAt.toISOString(),
        reason: manualForm.reason.trim(),
        sourceReference: manualForm.sourceReference.trim() || null
      });
      manualCreateVisible.value = false;
      activeTab.value = 'manual';
      ElMessage.success('人工汇率已保存，不会覆盖自动采集值');
      await exchangeRateQuery.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      manualCreating.value = false;
    }
  }

  function openManualDetail(entry: V2ManualFxRate) {
    manualDetail.value = entry;
    manualDetailVisible.value = true;
  }

  function parseRate(value: string) {
    const normalized = value.trim();
    return isV2UnsignedDecimal(normalized, {
      allowZero: false,
      decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
    })
      ? normalized
      : null;
  }
  function formatRate(value: string | null | undefined) {
    return formatV2Decimal(value);
  }
  function formatAmount(value: string | null | undefined) {
    return formatV2Decimal(value);
  }
  function formatDate(value: string | null | undefined) {
    if (!value) return '-';
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date(value));
  }
  function formatPercent(value: string | null | undefined) {
    if (!value) return '-';
    return `${formatV2Decimal(multiplyDecimalStrings(value, '100'))}%`;
  }
  function intervalLabel(minutes: number | undefined) {
    if (!minutes) return '-';
    if (minutes < 60) return `${minutes} 分钟`;
    if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
    return `${minutes / 60} 小时`;
  }
  function operatorName(entry: { createdBy: { username: string } | null }) {
    return entry.createdBy?.username || '-';
  }
  function receiptFxCapturedLabel(rate: V2ExchangeRateReceiptFxRate) {
    return rate.capturedAt ? `采集于 ${formatDate(rate.capturedAt)}` : '暂无记录';
  }

  watch(activeTab, () => {
    void exchangeRateQuery.ensureFresh();
  });

  return {
    defaultIntervals,
    trackedCurrencies,
    activeTab,
    overview,
    runtime,
    headerLoading,
    headerError,
    collecting,
    records,
    recordTotal,
    recordLoading,
    recordError,
    recordResolved,
    recordDateRange,
    receiptFxRates,
    manualEntries,
    manualTotal,
    manualLoading,
    manualError,
    manualResolved,
    manualDateRange,
    settingsVisible,
    settingsSaving,
    runDetailVisible,
    detailLoading,
    detailError,
    runDetail,
    runDetailTarget,
    manualCreateVisible,
    manualCreating,
    manualDetailVisible,
    manualDetail,
    canCollect,
    canManage,
    canCreate,
    recordQuery,
    manualQuery,
    settingsForm,
    manualForm,
    latestFailureDescription,
    manualPreview,
    loadHeader,
    loadRecords,
    loadManualEntries,
    loadAll,
    searchRecords,
    resetRecordPage,
    searchManual,
    resetManualPage,
    collectNow,
    openSettings,
    saveSettings,
    openRun,
    openRecordEvidence,
    retryRunDetail,
    openManualCreate,
    createManualEntry,
    openManualDetail,
    formatRate,
    formatAmount,
    formatDate,
    formatPercent,
    intervalLabel,
    runStatusLabel,
    runStatusType,
    triggerLabel,
    currencyLabel,
    currencySymbol,
    providerLabel,
    sideLabel,
    failureLabel,
    failureReason,
    operatorName,
    recordStatusLabel,
    recordStatusType,
    receiptFxStatusLabel,
    receiptFxStatusType,
    receiptFxSourceLabel,
    receiptFxCapturedLabel
  };
}
