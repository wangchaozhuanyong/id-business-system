import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { idBusinessV2ExchangeRatesApi } from './api';
import { createV2QueryKey, primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  addDecimalStrings,
  divideDecimalStrings,
  formatV2Decimal,
  isV2UnsignedDecimal,
  multiplyDecimalStrings
} from '@/v2/utils/decimal';
import type {
  V2ExchangeRateEntry,
  V2ExchangeRateListResult,
  V2ExchangeRateOverview,
  V2ExchangeRateRun,
  V2ExchangeRateRunDetail,
  V2ExchangeRateRunListResult,
  V2ExchangeRateRuntime
} from './contracts';

interface ExchangeRatePageSnapshot {
  overview: V2ExchangeRateOverview;
  runtime: V2ExchangeRateRuntime;
  runs?: V2ExchangeRateRunListResult;
  manualEntries?: V2ExchangeRateListResult;
}

const defaultIntervals = [5, 15, 30, 60, 180, 360, 720, 1440];
const failureReasonByCode: Record<string, string> = {
  binance_otc_http_error: '平台接口返回异常',
  binance_otc_timeout: '请求超时',
  binance_otc_network_error: '网络连接失败',
  binance_otc_invalid_response: '返回数据格式异常',
  binance_otc_provider_error: '平台拒绝了采集请求',
  binance_otc_empty_side: '未返回有效报价',
  binance_otc_invalid_target: '成交额参数无效',
  okx_otc_http_error: '平台接口返回异常',
  okx_otc_timeout: '请求超时',
  okx_otc_network_error: '网络连接失败',
  okx_otc_invalid_response: '返回数据格式异常',
  okx_otc_provider_error: '平台拒绝了采集请求',
  okx_otc_empty_side: '未返回有效报价',
  okx_otc_invalid_target: '成交额参数无效',
  otc_average_provider_collection_failed: '至少一个平台采集失败',
  otc_average_invalid_collection: '采集结果无效',
  otc_average_insufficient_valid_quotes: '有效报价数量不足',
  exchange_rate_stale_run_recovered: '超时采集任务已自动终止',
  exchange_rate_unexpected_failure: '采集过程发生未知错误'
};
export function useExchangeRatesPage() {
  const authStore = useAuthStore();
  const activeTab = ref<'automatic' | 'manual'>('automatic');
  const overview = ref<V2ExchangeRateOverview | null>(null);
  const runtime = ref<V2ExchangeRateRuntime | null>(null);
  const collecting = ref(false);
  const runs = ref<V2ExchangeRateRun[]>([]);
  const runTotal = ref(0);
  const runResolved = ref(false);
  const runDateRange = ref<[string, string] | []>([]);
  const manualEntries = ref<V2ExchangeRateEntry[]>([]);
  const manualTotal = ref(0);
  const manualResolved = ref(false);
  const manualDateRange = ref<[string, string] | []>([]);
  const settingsVisible = ref(false);
  const settingsSaving = ref(false);
  const runDetailVisible = ref(false);
  const detailLoading = ref(false);
  const detailError = ref('');
  const runDetail = ref<V2ExchangeRateRunDetail | null>(null);
  const runDetailTarget = ref<V2ExchangeRateRun | null>(null);
  const manualCreateVisible = ref(false);
  const manualCreating = ref(false);
  const manualDetailVisible = ref(false);
  const manualDetail = ref<V2ExchangeRateEntry | null>(null);

  const canCollect = computed(() =>
    hasUserPermission(authStore.user, 'apple.exchange_rate.collect')
  );
  const canManage = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.manage'));
  const canCreate = computed(() => hasUserPermission(authStore.user, 'apple.exchange_rate.create'));
  const runQuery = reactive({
    page: 1,
    pageSize: 20,
    keyword: '',
    status: '' as '' | 'running' | 'success' | 'failed',
    triggerType: '' as '' | 'manual' | 'scheduled' | 'system'
  });
  const manualQuery = reactive({ page: 1, pageSize: 20, keyword: '' });
  const settingsForm = reactive({
    autoEnabled: true,
    intervalMinutes: 15,
    targetAmountRmb: '5000'
  });
  const manualForm = reactive({
    binanceMerchantBuyRateToRmb: '',
    binanceMerchantSellRateToRmb: '',
    okxMerchantBuyRateToRmb: '',
    okxMerchantSellRateToRmb: '',
    recordedAt: new Date(),
    remark: ''
  });

  const latestFailureDescription = computed(() => {
    const run = overview.value?.latestRun;
    if (!run?.error) return '';
    return `${providerLabel(run.error.provider)} ${sideLabel(run.error.side)}：${failureReason(
      run.error
    )}。上次成功值已标记过期，不会自动带入加卡。`;
  });
  const manualPreview = computed(() => {
    const values = [
      manualForm.binanceMerchantBuyRateToRmb,
      manualForm.binanceMerchantSellRateToRmb,
      manualForm.okxMerchantBuyRateToRmb,
      manualForm.okxMerchantSellRateToRmb
    ].map(parseRate);
    if (values.some((value) => value === null)) return '-';
    const total = (values as string[]).reduce((sum, value) => addDecimalStrings(sum, value), '0');
    return divideDecimalStrings(total, '4');
  });

  function getRunRequest() {
    return {
      ...runQuery,
      keyword: runQuery.keyword.trim() || undefined,
      status: runQuery.status || undefined,
      triggerType: runQuery.triggerType || undefined,
      collectedFrom: runDateRange.value[0] || undefined,
      collectedTo: runDateRange.value[1] || undefined
    };
  }

  function getManualRequest() {
    return {
      ...manualQuery,
      keyword: manualQuery.keyword.trim() || undefined,
      recordedFrom: manualDateRange.value[0] || undefined,
      recordedTo: manualDateRange.value[1] || undefined,
      sortBy: 'recordedAt' as const,
      sortOrder: 'desc' as const
    };
  }

  function getPageKey(tab = activeTab.value) {
    return createV2QueryKey({
      tab,
      query: tab === 'automatic' ? getRunRequest() : getManualRequest()
    });
  }

  function isDefaultAutomaticRequest() {
    return (
      activeTab.value === 'automatic' &&
      runQuery.page === 1 &&
      runQuery.pageSize === 20 &&
      !runQuery.keyword.trim() &&
      !runQuery.status &&
      !runQuery.triggerType &&
      !runDateRange.value.length &&
      manualQuery.page === 1 &&
      manualQuery.pageSize === 20 &&
      !manualQuery.keyword.trim() &&
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
            runPage: runQuery.page,
            runPageSize: runQuery.pageSize,
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
            manualEntries: result.manualEntries
          }
        });
        return {
          overview: result.overview,
          runtime: result.runtime,
          runs: result.runs,
          manualEntries: result.manualEntries
        };
      }

      const [nextOverview, nextRuntime, list] = await Promise.all([
        idBusinessV2ExchangeRatesApi.overview({ signal }),
        idBusinessV2ExchangeRatesApi.runtime({ signal }),
        activeTab.value === 'automatic'
          ? idBusinessV2ExchangeRatesApi.listRuns(getRunRequest(), { signal })
          : idBusinessV2ExchangeRatesApi.listManualEntries(getManualRequest(), { signal })
      ]);
      return activeTab.value === 'automatic'
        ? {
            overview: nextOverview,
            runtime: nextRuntime,
            runs: list as V2ExchangeRateRunListResult
          }
        : {
            overview: nextOverview,
            runtime: nextRuntime,
            manualEntries: list as V2ExchangeRateListResult
          };
    }
  });
  watch(
    exchangeRateQuery.data,
    (snapshot) => {
      if (!snapshot) return;
      overview.value = snapshot.overview;
      runtime.value = snapshot.runtime;
      if (snapshot.runs) {
        runs.value = snapshot.runs.items;
        runTotal.value = snapshot.runs.total;
        runResolved.value = true;
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
  const runLoading = computed(() => activeTab.value === 'automatic' && headerLoading.value);
  const manualLoading = computed(() => activeTab.value === 'manual' && headerLoading.value);
  const runError = computed(() => (activeTab.value === 'automatic' ? headerError.value : ''));
  const manualError = computed(() => (activeTab.value === 'manual' ? headerError.value : ''));

  function loadHeader() {
    return exchangeRateQuery.refresh();
  }

  function loadRuns() {
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

  function searchRuns() {
    runQuery.page = 1;
    void exchangeRateQuery.ensureFresh();
  }
  function resetRunPage() {
    runQuery.page = 1;
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
      ElMessage.success(`双平台采集成功，中间价 ${formatRate(result.midRateToRmb)}`);
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
        targetAmountRmb: current.targetAmountRmb
      });
    }
    settingsVisible.value = true;
  }

  async function saveSettings() {
    const amount = Number(settingsForm.targetAmountRmb);
    if (
      !isV2UnsignedDecimal(settingsForm.targetAmountRmb, { allowZero: false }) ||
      !Number.isFinite(amount) ||
      amount > 1_000_000
    ) {
      return;
    }
    settingsSaving.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.updateSettings({
        autoEnabled: settingsForm.autoEnabled,
        intervalMinutes: settingsForm.intervalMinutes,
        targetAmountRmb: settingsForm.targetAmountRmb.trim()
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

  async function openRun(run: V2ExchangeRateRun) {
    runDetailTarget.value = run;
    runDetailVisible.value = true;
    detailLoading.value = true;
    detailError.value = '';
    runDetail.value = null;
    try {
      runDetail.value = await idBusinessV2ExchangeRatesApi.getRun(run.id);
    } catch (error) {
      detailError.value = getApiErrorMessage(error);
    } finally {
      detailLoading.value = false;
    }
  }

  function retryRunDetail() {
    if (runDetailTarget.value) void openRun(runDetailTarget.value);
  }

  function openManualCreate() {
    Object.assign(manualForm, {
      binanceMerchantBuyRateToRmb: '',
      binanceMerchantSellRateToRmb: '',
      okxMerchantBuyRateToRmb: '',
      okxMerchantSellRateToRmb: '',
      recordedAt: new Date(),
      remark: ''
    });
    manualCreateVisible.value = true;
  }

  async function createManualEntry() {
    const values = [
      manualForm.binanceMerchantBuyRateToRmb,
      manualForm.binanceMerchantSellRateToRmb,
      manualForm.okxMerchantBuyRateToRmb,
      manualForm.okxMerchantSellRateToRmb
    ];
    if (values.some((value) => parseRate(value) === null)) {
      return;
    }
    manualCreating.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.createManualEntry({
        binanceMerchantBuyRateToRmb: manualForm.binanceMerchantBuyRateToRmb.trim(),
        binanceMerchantSellRateToRmb: manualForm.binanceMerchantSellRateToRmb.trim(),
        okxMerchantBuyRateToRmb: manualForm.okxMerchantBuyRateToRmb.trim(),
        okxMerchantSellRateToRmb: manualForm.okxMerchantSellRateToRmb.trim(),
        recordedAt: manualForm.recordedAt.toISOString(),
        remark: manualForm.remark.trim() || null
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

  function openManualDetail(entry: V2ExchangeRateEntry) {
    manualDetail.value = entry;
    manualDetailVisible.value = true;
  }

  function parseRate(value: string) {
    const normalized = value.trim();
    return isV2UnsignedDecimal(normalized, { allowZero: false }) ? normalized : null;
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
  function runStatusLabel(status: V2ExchangeRateRun['status']) {
    return { running: '采集中', success: '成功', failed: '失败' }[status];
  }
  function runStatusType(status: V2ExchangeRateRun['status']) {
    return status === 'success' ? 'success' : status === 'failed' ? 'danger' : 'warning';
  }
  function triggerLabel(trigger: V2ExchangeRateRun['triggerType']) {
    return { scheduled: '定时采集', manual: '立即采集', system: '系统采集' }[trigger];
  }
  function providerLabel(provider: string | null | undefined) {
    if (provider === 'binance') return 'Binance';
    if (provider === 'okx') return 'OKX';
    if (provider === 'multiple') return 'Binance、OKX';
    if (provider === 'system') return '系统';
    return '-';
  }
  function sideLabel(side: string | null | undefined) {
    if (side === 'merchant_buy') return '商家买入';
    if (side === 'merchant_sell') return '商家卖出';
    return '';
  }
  function failureLabel(run: Pick<V2ExchangeRateRun, 'error'>) {
    if (!run.error) return '-';
    return `${providerLabel(run.error.provider)} ${sideLabel(run.error.side)} ${failureReason(
      run.error
    )}`.trim();
  }
  function failureReason(error: NonNullable<V2ExchangeRateRun['error']>) {
    return failureReasonByCode[error.code] || error.message || '采集失败，请查看批次详情';
  }
  function operatorName(entry: V2ExchangeRateEntry) {
    return entry.createdBy?.displayName || entry.createdBy?.username || '-';
  }

  watch(activeTab, () => {
    void exchangeRateQuery.ensureFresh();
  });

  return {
    defaultIntervals,
    activeTab,
    overview,
    runtime,
    headerLoading,
    headerError,
    collecting,
    runs,
    runTotal,
    runLoading,
    runError,
    runResolved,
    runDateRange,
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
    runQuery,
    manualQuery,
    settingsForm,
    manualForm,
    latestFailureDescription,
    manualPreview,
    loadHeader,
    loadRuns,
    loadManualEntries,
    loadAll,
    searchRuns,
    resetRunPage,
    searchManual,
    resetManualPage,
    collectNow,
    openSettings,
    saveSettings,
    openRun,
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
    providerLabel,
    sideLabel,
    failureLabel,
    failureReason,
    operatorName
  };
}
