import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2ExchangeRatesApi } from './api';
import { createV2QueryKey, primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { useV2LatestRequest } from '@/v2/composables/useV2LatestRequest';
import { ensureV2BusinessNowInput, getV2BusinessNowInput } from '@/v2/runtime/businessClock';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import {
  currencyLabel,
  currencySymbol,
  defaultIntervals,
  failureLabel,
  failureReason,
  formatAmount,
  formatDate,
  formatPercent,
  formatRate,
  intervalLabel,
  operatorName,
  parseExchangeRateInput,
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
  V2ExchangeRateRunDetail,
  V2ExchangeRateRunListResult,
  V2ExchangeRateRuntime,
  V2ManualFxRate,
  V2ManualFxRateListResult,
  V2PurchaseQuote,
  V2PurchaseQuoteList,
  V2TrackedExchangeRateCurrency
} from './contracts';
import { useExchangeRateFilters } from './useExchangeRateFilters';
import { usePurchaseQuoteEditor } from './usePurchaseQuoteEditor';
import { usePurchaseRateAutomation } from './usePurchaseRateAutomation';

interface ExchangeRatePageSnapshot {
  overview: V2ExchangeRateOverview;
  runtime: V2ExchangeRateRuntime;
  runs?: V2ExchangeRateRunListResult;
  records?: V2ExchangeRateRecordListResult;
  manualEntries?: V2ManualFxRateListResult;
  purchaseQuotes?: V2PurchaseQuoteList;
}

export function useExchangeRatesPage() {
  const authStore = useAuthStore();
  const activeTab = ref<'purchase' | 'automatic' | 'manual'>('purchase');
  const overview = ref<V2ExchangeRateOverview | null>(null);
  const runtime = ref<V2ExchangeRateRuntime | null>(null);
  const collecting = ref(false);
  const records = ref<V2ExchangeRateRecord[]>([]);
  const recordTotal = ref(0);
  const recordResolved = ref(false);
  const recordDisplayedPage = ref(1);
  const recordDisplayedPageSize = ref(20);
  const manualEntries = ref<V2ManualFxRate[]>([]);
  const manualTotal = ref(0);
  const manualResolved = ref(false);
  const manualDisplayedPage = ref(1);
  const manualDisplayedPageSize = ref(20);
  const settingsVisible = ref(false);
  const settingsSaving = ref(false);
  const runDetailVisible = ref(false);
  const detailLoading = ref(false);
  const detailError = ref('');
  const runDetail = ref<V2ExchangeRateRunDetail | null>(null);
  const runDetailTarget = ref<string | null>(null);
  const runDetailRequest = useV2LatestRequest();
  const manualCreateVisible = ref(false);
  const manualCreating = ref(false);
  const manualDetailVisible = ref(false);
  const manualDetail = ref<V2ManualFxRate | null>(null);
  const purchaseQuotes = ref<V2PurchaseQuote[]>([]);
  const purchaseQuoteMeta = ref<Pick<
    V2PurchaseQuoteList,
    'calculationRule' | 'marketRateMode' | 'marketRateNotice'
  > | null>(null);
  const purchaseResolved = ref(false);

  const canCollect = computed(() =>
    hasUserPermission(authStore.user, 'apple.exchange_rate.collect')
  );
  const canManage = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.manage'));
  const canCreate = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.create'));
  const filters = useExchangeRateFilters({
    ensureFresh: () => exchangeRateQuery.ensureFresh()
  });
  const { recordQuery, manualQuery, recordDateRange, manualDateRange } = filters;
  const settingsForm = reactive({
    expectedUpdatedAt: '',
    autoEnabled: true,
    intervalMinutes: 15,
    targetAmountRmb: '5000',
    retentionDays: 30
  });
  const manualForm = reactive({
    currency: 'MYR' as V2TrackedExchangeRateCurrency,
    rateToCny: '',
    recordedAt: getV2BusinessNowInput(),
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
    const value = parseExchangeRateInput(manualForm.rateToCny);
    return value ? `${currencyLabel(manualForm.currency)} / CNY ${formatRate(value)}` : '-';
  });

  function getPageKey(tab = activeTab.value) {
    return createV2QueryKey({
      tab,
      query:
        tab === 'automatic'
          ? filters.getRecordRequest()
          : tab === 'manual'
            ? filters.getManualRequest()
            : undefined
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
    getRevalidateAt: (snapshot) => {
      const deadlines = [
        snapshot.overview.effective.expiresAt,
        snapshot.overview.lastSuccess?.expiresAt,
        ...(snapshot.purchaseQuotes?.items
          .map((quote) => quote.latestSnapshot)
          .filter((item) => item && !item.stale)
          .map((item) => item!.staleAt) ?? [])
      ]
        .filter(Boolean)
        .map((value) => new Date(value!).getTime())
        .filter((value) => Number.isFinite(value) && value > Date.now());
      return deadlines.length ? Math.min(...deadlines) : null;
    },
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
            manualEntries: result.manualEntries,
            purchaseQuotes: result.purchaseQuotes
          }
        });
        primeV2Query<ExchangeRatePageSnapshot>({
          scope: 'exchange-rates',
          key: getPageKey('purchase'),
          data: {
            overview: result.overview,
            runtime: result.runtime,
            purchaseQuotes: result.purchaseQuotes
          }
        });
        return {
          overview: result.overview,
          runtime: result.runtime,
          runs: result.runs,
          records: result.records,
          manualEntries: result.manualEntries,
          purchaseQuotes: result.purchaseQuotes
        };
      }

      const [nextOverview, nextRuntime, list] = await Promise.all([
        idBusinessV2ExchangeRatesApi.overview({ signal }),
        idBusinessV2ExchangeRatesApi.runtime({ signal }),
        activeTab.value === 'automatic'
          ? idBusinessV2ExchangeRatesApi.listRecords(filters.getRecordRequest(), { signal })
          : activeTab.value === 'manual'
            ? idBusinessV2ExchangeRatesApi.listManualRates(filters.getManualRequest(), { signal })
            : idBusinessV2ExchangeRatesApi.listPurchaseQuotes({ signal })
      ]);
      if (activeTab.value === 'automatic') {
        return {
          overview: nextOverview,
          runtime: nextRuntime,
          records: list as V2ExchangeRateRecordListResult
        };
      }
      if (activeTab.value === 'manual') {
        return {
          overview: nextOverview,
          runtime: nextRuntime,
          manualEntries: list as V2ManualFxRateListResult
        };
      }
      return {
        overview: nextOverview,
        runtime: nextRuntime,
        purchaseQuotes: list as V2PurchaseQuoteList
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
        recordDisplayedPage.value = snapshot.records.page;
        recordDisplayedPageSize.value = snapshot.records.pageSize;
        recordResolved.value = true;
      }
      if (snapshot.manualEntries) {
        manualEntries.value = snapshot.manualEntries.items;
        manualTotal.value = snapshot.manualEntries.total;
        manualDisplayedPage.value = snapshot.manualEntries.page;
        manualDisplayedPageSize.value = snapshot.manualEntries.pageSize;
        manualResolved.value = true;
      }
      if (snapshot.purchaseQuotes) {
        purchaseQuotes.value = snapshot.purchaseQuotes.items;
        purchaseQuoteMeta.value = {
          calculationRule: snapshot.purchaseQuotes.calculationRule,
          marketRateMode: snapshot.purchaseQuotes.marketRateMode,
          marketRateNotice: snapshot.purchaseQuotes.marketRateNotice
        };
        purchaseResolved.value = true;
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
  const purchaseLoading = computed(() => activeTab.value === 'purchase' && headerLoading.value);
  const recordError = computed(() => (activeTab.value === 'automatic' ? headerError.value : ''));
  const manualError = computed(() => (activeTab.value === 'manual' ? headerError.value : ''));
  const purchaseError = computed(() => (activeTab.value === 'purchase' ? headerError.value : ''));
  const receiptFxRates = computed(() =>
    (overview.value?.latestReceiptFxRates ?? []).filter(
      (rate) => rate.currency !== 'CNY' && rate.currency !== 'USDT'
    )
  );

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

  function loadPurchaseQuotes() {
    return activeTab.value === 'purchase'
      ? exchangeRateQuery.refresh()
      : Promise.resolve(undefined);
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
        expectedUpdatedAt: current.updatedAt,
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
      !settingsForm.expectedUpdatedAt ||
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
        expectedUpdatedAt: settingsForm.expectedUpdatedAt,
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
    const switchingTarget = runDetailTarget.value !== runId;
    runDetailTarget.value = runId;
    runDetailVisible.value = true;
    detailLoading.value = true;
    detailError.value = '';
    if (switchingTarget) runDetail.value = null;
    const request = runDetailRequest.begin();
    try {
      const result = await idBusinessV2ExchangeRatesApi.getRun(runId, { signal: request.signal });
      if (!request.isCurrent() || runDetailTarget.value !== runId) return;
      runDetail.value = result;
    } catch (error) {
      if (!request.isCurrent() || runDetailTarget.value !== runId) return;
      detailError.value = getApiErrorMessage(error);
    } finally {
      if (request.isCurrent() && runDetailTarget.value === runId) {
        detailLoading.value = false;
      }
      request.finish();
    }
  }

  function retryRunDetail() {
    if (runDetailTarget.value) void openRun(runDetailTarget.value);
  }

  function openRecordEvidence(record: V2ExchangeRateRecord) {
    if (record.exchangeRateRunId) void openRun(record.exchangeRateRunId);
  }

  async function openManualCreate() {
    const recordedAt = await ensureV2BusinessNowInput();
    if (!recordedAt) {
      ElMessage.error('无法读取服务器北京时间，请稍后重试');
      return;
    }
    Object.assign(manualForm, {
      currency: 'MYR',
      rateToCny: '',
      recordedAt,
      reason: '',
      sourceReference: ''
    });
    manualCreateVisible.value = true;
  }

  async function createManualEntry() {
    if (!parseExchangeRateInput(manualForm.rateToCny) || manualForm.reason.trim().length < 2) {
      return;
    }
    manualCreating.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.createManualRate({
        currency: manualForm.currency,
        rateToCny: manualForm.rateToCny.trim(),
        recordedAt: v2DateTimeInputToIso(manualForm.recordedAt),
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

  const purchaseQuoteEditor = usePurchaseQuoteEditor({
    refresh: () => exchangeRateQuery.refresh()
  });
  const purchaseAutomation = usePurchaseRateAutomation({
    enabled: () => activeTab.value === 'purchase' && purchaseResolved.value,
    quotes: () => purchaseQuotes.value,
    refreshQuotes: () => exchangeRateQuery.refresh()
  });

  watch(activeTab, () => {
    void exchangeRateQuery.ensureFresh();
  });

  watch(runDetailVisible, (visible) => {
    if (visible) return;
    runDetailRequest.cancel();
    detailLoading.value = false;
    detailError.value = '';
    runDetail.value = null;
    runDetailTarget.value = null;
  });

  return {
    defaultIntervals,
    trackedCurrencies,
    activeTab,
    overview,
    runtime,
    queryPhase: exchangeRateQuery.phase,
    isParameterTransition: exchangeRateQuery.isParameterTransition,
    headerLoading,
    headerError,
    collecting,
    records,
    recordTotal,
    recordDisplayedPage,
    recordDisplayedPageSize,
    recordLoading,
    recordError,
    recordResolved,
    ...filters,
    receiptFxRates,
    manualEntries,
    manualTotal,
    manualDisplayedPage,
    manualDisplayedPageSize,
    manualLoading,
    manualError,
    manualResolved,
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
    purchaseQuotes,
    purchaseQuoteMeta,
    purchaseResolved,
    purchaseLoading,
    purchaseError,
    ...purchaseQuoteEditor,
    purchaseAutomation,
    canCollect,
    canManage,
    canCreate,
    settingsForm,
    manualForm,
    latestFailureDescription,
    manualPreview,
    loadHeader,
    loadRecords,
    loadManualEntries,
    loadPurchaseQuotes,
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
    receiptFxSourceLabel
  };
}
