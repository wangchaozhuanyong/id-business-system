import { computed, reactive, ref, watch } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { idBusinessV2ExchangeRatesApi } from './api';
import type {
  V2PurchaseQuote,
  V2PurchaseQuoteTextResult,
  V2PurchaseRateHistoryResult,
  V2PurchaseRateRun,
  V2PurchaseRateRunListResult,
  V2PurchaseRateRuntime
} from './contracts';

interface PurchaseRateAutomationSnapshot {
  runtime: V2PurchaseRateRuntime;
  runs: V2PurchaseRateRunListResult;
}

export function usePurchaseRateAutomation(options: {
  enabled: () => boolean;
  quotes: () => V2PurchaseQuote[];
  refreshQuotes: () => Promise<unknown>;
}) {
  const refreshing = ref(false);
  const settingsVisible = ref(false);
  const settingsSaving = ref(false);
  const settingsForm = reactive({
    autoEnabled: true,
    staleMinutes: 1800,
    abnormalChangePercent: '10'
  });
  const bulkVisible = ref(false);
  const bulkSaving = ref(false);
  const bulkForm = reactive({ currencyCodes: [] as string[], purchaseRatioPercent: '' });
  const historyVisible = ref(false);
  const runPage = ref(1);
  const runPageSize = ref(20);
  const historyPage = ref(1);
  const historyPageSize = ref(20);
  const historyCurrencyCode = ref('');
  const detailVisible = ref(false);
  const detailRunId = ref('');
  const reviewSubmitting = ref(false);
  const reviewRemark = ref('');
  const textVisible = ref(false);
  const textFormat = ref<'wechat' | 'monospace' | 'plain'>('wechat');

  const automationQuery = useV2ModuleQuery<PurchaseRateAutomationSnapshot>({
    moduleKey: 'exchange-rates',
    scope: 'exchange-rates',
    key: () =>
      createV2QueryKey({
        section: 'purchase-rate-automation',
        page: runPage.value,
        pageSize: runPageSize.value
      }),
    enabled: options.enabled,
    trackRouteData: false,
    query: async ({ signal }) => {
      const [runtime, runs] = await Promise.all([
        idBusinessV2ExchangeRatesApi.purchaseRateRuntime({ signal }),
        idBusinessV2ExchangeRatesApi.listPurchaseRateRuns(
          { page: runPage.value, pageSize: runPageSize.value },
          { signal }
        )
      ]);
      return { runtime, runs };
    }
  });

  const historyQuery = useV2ModuleQuery<V2PurchaseRateHistoryResult>({
    moduleKey: 'exchange-rates',
    scope: 'exchange-rates',
    key: () =>
      createV2QueryKey({
        section: 'purchase-rate-history',
        page: historyPage.value,
        pageSize: historyPageSize.value,
        currencyCode: historyCurrencyCode.value || undefined
      }),
    enabled: () => options.enabled() && historyVisible.value,
    trackRouteData: false,
    keepPreviousData: true,
    query: ({ signal }) =>
      idBusinessV2ExchangeRatesApi.listPurchaseRateHistory(
        {
          page: historyPage.value,
          pageSize: historyPageSize.value,
          currencyCode: historyCurrencyCode.value || undefined
        },
        { signal }
      )
  });

  const detailQuery = useV2ModuleQuery<V2PurchaseRateRun>({
    moduleKey: 'exchange-rates',
    scope: 'exchange-rates',
    key: () => createV2QueryKey({ section: 'purchase-rate-run', id: detailRunId.value }),
    enabled: () => options.enabled() && detailVisible.value && Boolean(detailRunId.value),
    trackRouteData: false,
    query: ({ signal }) =>
      idBusinessV2ExchangeRatesApi.getPurchaseRateRun(detailRunId.value, { signal })
  });

  const textQuery = useV2ModuleQuery<V2PurchaseQuoteTextResult>({
    moduleKey: 'exchange-rates',
    scope: 'exchange-rates',
    key: () => createV2QueryKey({ section: 'purchase-quote-text', format: textFormat.value }),
    enabled: () => options.enabled() && textVisible.value,
    trackRouteData: false,
    keepPreviousData: true,
    query: ({ signal }) =>
      idBusinessV2ExchangeRatesApi.generatePurchaseQuoteText(textFormat.value, { signal })
  });

  const runtime = computed(() => automationQuery.data.value?.runtime ?? null);
  const runs = computed(() => automationQuery.data.value?.runs.items ?? []);
  const latestRun = computed(() => runtime.value?.latestRun ?? runs.value[0] ?? null);
  const staleQuoteCount = computed(
    () => options.quotes().filter((quote) => quote.enabled && quote.latestSnapshot?.stale).length
  );
  const missingQuoteCount = computed(
    () => options.quotes().filter((quote) => quote.enabled && !quote.latestSnapshot).length
  );
  const pendingReviewRun = computed(
    () => runs.value.find((run) => run.status === 'pending_review') ?? null
  );

  function openSettings() {
    const settings = runtime.value?.settings;
    if (settings) {
      Object.assign(settingsForm, {
        autoEnabled: settings.autoEnabled,
        staleMinutes: settings.staleMinutes,
        abnormalChangePercent: settings.abnormalChangePercent
      });
    }
    settingsVisible.value = true;
  }

  async function saveSettings() {
    if (
      !Number.isInteger(settingsForm.staleMinutes) ||
      settingsForm.staleMinutes < (runtime.value?.settings.allowedStaleMinutes.min ?? 1440) ||
      settingsForm.staleMinutes > (runtime.value?.settings.allowedStaleMinutes.max ?? 4320) ||
      !isV2UnsignedDecimal(settingsForm.abnormalChangePercent, {
        allowZero: false,
        decimalPlaces: 8
      }) ||
      Number(settingsForm.abnormalChangePercent) > 100
    ) {
      ElMessage.warning('请检查过期提醒时间和异常波动阈值');
      return;
    }
    settingsSaving.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.updatePurchaseRateSettings({
        autoEnabled: settingsForm.autoEnabled,
        staleMinutes: settingsForm.staleMinutes,
        abnormalChangePercent: settingsForm.abnormalChangePercent.trim()
      });
      settingsVisible.value = false;
      ElMessage.success(settingsForm.autoEnabled ? '自动采集设置已保存' : '自动采集已关闭');
      await refreshAll();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      settingsSaving.value = false;
    }
  }

  async function refreshNow() {
    refreshing.value = true;
    try {
      const result = await idBusinessV2ExchangeRatesApi.refreshPurchaseRates();
      if (result.status === 'success') ElMessage.success('收购汇率已刷新并发布');
      else if (result.status === 'pending_review') {
        ElMessage.warning('检测到异常波动，候选报价已暂停发布并等待审核');
      } else if (result.status === 'skipped') ElMessage.warning('已有采集任务运行中，请稍后再试');
      else ElMessage.error(result.errorMessage || '收购汇率刷新失败，已保留原报价');
      await refreshAll();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
      await refreshAll();
    } finally {
      refreshing.value = false;
    }
  }

  function openBulk() {
    Object.assign(bulkForm, {
      currencyCodes: options
        .quotes()
        .filter((quote) => quote.enabled)
        .map((quote) => quote.code),
      purchaseRatioPercent: ''
    });
    bulkVisible.value = true;
  }

  async function saveBulk() {
    if (bulkForm.currencyCodes.length === 0) {
      ElMessage.warning('请至少选择一个币种');
      return;
    }
    if (
      !isV2UnsignedDecimal(bulkForm.purchaseRatioPercent, {
        allowZero: false,
        decimalPlaces: 8
      }) ||
      Number(bulkForm.purchaseRatioPercent) > 100
    ) {
      ElMessage.warning('收购比例必须大于 0% 且不超过 100%');
      return;
    }
    bulkSaving.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.bulkUpdatePurchaseQuotes({
        currencyCodes: bulkForm.currencyCodes,
        purchaseRatioPercent: bulkForm.purchaseRatioPercent.trim()
      });
      bulkVisible.value = false;
      ElMessage.success(`已批量更新 ${bulkForm.currencyCodes.length} 个币种的收购比例`);
      await refreshAll();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      bulkSaving.value = false;
    }
  }

  function openHistory() {
    historyVisible.value = true;
  }

  function openRun(run: V2PurchaseRateRun) {
    detailRunId.value = run.id;
    reviewRemark.value = '';
    detailVisible.value = true;
  }

  async function review(confirm: boolean) {
    if (!detailRunId.value) return;
    reviewSubmitting.value = true;
    try {
      if (confirm) {
        await idBusinessV2ExchangeRatesApi.confirmPurchaseRateRun(
          detailRunId.value,
          reviewRemark.value.trim()
        );
        ElMessage.success('异常报价已确认并发布');
      } else {
        await idBusinessV2ExchangeRatesApi.rejectPurchaseRateRun(
          detailRunId.value,
          reviewRemark.value.trim()
        );
        ElMessage.success('异常报价已驳回，原报价继续有效');
      }
      detailVisible.value = false;
      await refreshAll();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      reviewSubmitting.value = false;
    }
  }

  function openText() {
    textVisible.value = true;
  }

  async function copyText() {
    const text = textQuery.data.value?.text;
    if (!text) return;
    try {
      await writeClipboardText(text);
      ElMessage.success('报价文本已复制');
    } catch {
      ElMessage.error('无法复制，请手动选择文本复制');
    }
  }

  async function refreshAll() {
    await Promise.all([automationQuery.refresh(), options.refreshQuotes()]);
    if (historyVisible.value) await historyQuery.refresh();
  }

  watch([historyCurrencyCode, historyPageSize], () => {
    historyPage.value = 1;
  });

  watch(detailVisible, (visible) => {
    if (!visible) detailRunId.value = '';
  });

  return {
    automationQuery,
    historyQuery,
    detailQuery,
    textQuery,
    runtime,
    runs,
    latestRun,
    staleQuoteCount,
    missingQuoteCount,
    pendingReviewRun,
    refreshing,
    settingsVisible,
    settingsSaving,
    settingsForm,
    bulkVisible,
    bulkSaving,
    bulkForm,
    historyVisible,
    runPage,
    runPageSize,
    historyPage,
    historyPageSize,
    historyCurrencyCode,
    detailVisible,
    reviewSubmitting,
    reviewRemark,
    textVisible,
    textFormat,
    openSettings,
    saveSettings,
    refreshNow,
    openBulk,
    saveBulk,
    openHistory,
    openRun,
    review,
    openText,
    copyText,
    refreshAll
  };
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // 浏览器可能因权限或非安全上下文拒绝 Clipboard API，继续使用兼容回退。
    }
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.readOnly = true;
  textarea.setAttribute('aria-hidden', 'true');
  textarea.style.position = 'fixed';
  textarea.style.inset = '0 auto auto -9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  try {
    textarea.focus();
    textarea.select();
    if (!document.execCommand('copy')) throw new Error('浏览器拒绝复制文本');
  } finally {
    textarea.remove();
  }
}
