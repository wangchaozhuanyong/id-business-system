import { computed, nextTick, onActivated, onDeactivated, onUnmounted, ref, type Ref } from 'vue';
import type { FormInstance } from 'element-plus';
import type { V2OrderReceiptFxQuote } from '@apple-business/shared';
import { getApiErrorMessage, isRequestCanceled } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { multiplyDecimalStrings } from '@/v2/utils/decimal';
import { idBusinessV2OrdersApi } from './api';
import type { V2OrderEntryForm } from './order-entry-form';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateProfitRate,
  calculateSuggestedOriginalAmount,
  type SuggestedReceiptQuote,
  type SuggestedReceivedAmount
} from './order-pricing';
import { resetReceiptCurrencyEvidence } from './order-receipt';

interface UseOrderReceiptPricingOptions {
  form: V2OrderEntryForm;
  formRef: Ref<FormInstance | undefined>;
  getSuggestedReceived: () => SuggestedReceivedAmount;
  getSettlementPlatform: () => {
    fixedFee: string;
    percentageFee: string;
  } | null;
  getAppliedAccountCost: () => string;
  getEstimatedBalanceCost: () => string;
}

export function useOrderReceiptPricing(options: UseOrderReceiptPricingOptions) {
  const { form, formRef } = options;
  const recommendationApplied = ref(false);
  const previousManualPrice = ref('');
  const appliedSuggestedOriginal = ref('');
  const receiptFxQuote = ref<V2OrderReceiptFxQuote | null>(null);
  const receiptFxLoading = ref(false);
  const receiptFxError = ref('');
  let receiptFxExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let receiptFxRequestController: AbortController | undefined;
  let receiptFxRequestVersion = 0;

  const suggestedReceipt = computed<SuggestedReceiptQuote>(() => {
    const suggestedReceived = options.getSuggestedReceived();
    const cnyAmount = suggestedReceived.amount;
    if (!cnyAmount) {
      return {
        cnyAmount: null,
        originalAmount: null,
        equivalentCnyAmount: null,
        platformFee: null,
        estimatedProfit: null,
        estimatedProfitRate: null,
        error: suggestedReceived.error
      };
    }

    const rate = form.receivedFxRateToCny || form.automaticFxRateToCny;
    const calculationCnyAmount = suggestedReceived.exactAmount ?? cnyAmount;
    const originalAmount = calculateSuggestedOriginalAmount(
      calculationCnyAmount,
      form.receivedCurrency,
      rate
    );
    if (!originalAmount) {
      return {
        cnyAmount,
        originalAmount: null,
        equivalentCnyAmount: null,
        platformFee: suggestedReceived.platformFee,
        estimatedProfit: suggestedReceived.estimatedProfit,
        estimatedProfitRate: suggestedReceived.estimatedProfitRate,
        error:
          form.receivedCurrency !== 'CNY'
            ? receiptFxLoading.value
              ? `正在采集 ${form.receivedCurrency}/CNY 汇率`
              : receiptFxError.value || '缺少有效汇率，暂时无法换算原币推荐价'
            : suggestedReceived.error
      };
    }

    let equivalentCnyAmount = cnyAmount;
    if (form.receivedCurrency !== 'CNY') {
      try {
        equivalentCnyAmount = multiplyDecimalStrings(originalAmount, rate);
      } catch {
        return {
          cnyAmount,
          originalAmount: null,
          equivalentCnyAmount: null,
          platformFee: suggestedReceived.platformFee,
          estimatedProfit: suggestedReceived.estimatedProfit,
          estimatedProfitRate: suggestedReceived.estimatedProfitRate,
          error: '汇率格式无效，无法换算原币推荐价'
        };
      }
    }

    const platform = options.getSettlementPlatform();
    const platformFee =
      calculatePlatformFeeAmount(
        equivalentCnyAmount,
        platform?.fixedFee ?? '0',
        platform?.percentageFee ?? '0'
      ) ?? null;
    const estimatedProfit =
      platformFee === null
        ? null
        : calculateEstimatedProfitAmount(
            equivalentCnyAmount,
            platformFee,
            options.getAppliedAccountCost(),
            options.getEstimatedBalanceCost()
          );

    return {
      cnyAmount,
      originalAmount,
      equivalentCnyAmount,
      platformFee,
      estimatedProfit,
      estimatedProfitRate:
        estimatedProfit === null ? null : calculateProfitRate(estimatedProfit, equivalentCnyAmount),
      error: ''
    };
  });

  function handleReceivedCurrencyChange() {
    stopReceiptFxTasks();
    resetReceiptCurrencyEvidence(form);
    form.receivedOriginalAmount = '';
    receiptFxQuote.value = null;
    receiptFxError.value = '';
    recommendationApplied.value = false;
    previousManualPrice.value = '';
    appliedSuggestedOriginal.value = '';
    void nextTick(() => {
      formRef.value?.clearValidate([
        'receivedOriginalAmount',
        'receivedFxRateToCny',
        'receivedManualRateReason'
      ]);
    });
    if (form.receivedCurrency !== 'CNY') {
      void loadReceiptFxQuote();
    }
  }

  async function loadReceiptFxQuote() {
    const currency = form.receivedCurrency;
    if (currency === 'CNY') return false;

    receiptFxRequestController?.abort();
    const controller = new AbortController();
    receiptFxRequestController = controller;
    const requestVersion = ++receiptFxRequestVersion;
    receiptFxLoading.value = true;
    receiptFxError.value = '';

    try {
      const quote = await requestReceiptFxQuoteWithRetry(currency, controller.signal);
      if (
        !quote ||
        controller.signal.aborted ||
        requestVersion !== receiptFxRequestVersion ||
        form.receivedCurrency !== currency
      ) {
        return false;
      }
      receiptFxQuote.value = quote;
      if (!form.receivedFxRateToCny) {
        form.receivedFxSnapshotId = quote.snapshotId ?? '';
        form.automaticFxRateToCny = quote.rateToCny;
        scheduleReceiptFxExpiry(quote);
      }
      void nextTick(() => {
        formRef.value?.clearValidate(['receivedFxRateToCny', 'receivedManualRateReason']);
      });
      return true;
    } catch (error) {
      if (
        isRequestCanceled(error) ||
        requestVersion !== receiptFxRequestVersion ||
        form.receivedCurrency !== currency
      ) {
        return false;
      }
      receiptFxQuote.value = null;
      form.receivedFxSnapshotId = '';
      form.automaticFxRateToCny = '';
      receiptFxError.value = getApiErrorMessage(error);
      return false;
    } finally {
      if (requestVersion === receiptFxRequestVersion) {
        receiptFxLoading.value = false;
        if (receiptFxRequestController === controller) {
          receiptFxRequestController = undefined;
        }
      }
    }
  }

  async function requestReceiptFxQuoteWithRetry(
    currency: V2OrderReceiptFxQuote['currency'],
    signal: AbortSignal
  ) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await idBusinessV2OrdersApi.quoteReceiptFx(currency, { signal });
      } catch (error) {
        if (isRequestCanceled(error) || signal.aborted) throw error;
        lastError = error;
        if (attempt < 2 && !(await waitForReceiptFxRetry(600 * 2 ** attempt, signal))) {
          return null;
        }
      }
    }
    throw lastError;
  }

  function waitForReceiptFxRetry(delayMs: number, signal: AbortSignal) {
    return new Promise<boolean>((resolve) => {
      if (signal.aborted) {
        resolve(false);
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', abort);
        resolve(true);
      }, delayMs);
      const abort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  function handleManualFxRateInput() {
    clearReceiptFxExpiryTimer();
    if (form.receivedFxRateToCny) {
      form.receivedFxSnapshotId = '';
      form.automaticFxRateToCny = '';
    } else {
      form.receivedManualRateReason = '';
      const quote = receiptFxQuote.value;
      if (quote && !isReceiptFxQuoteExpired(quote)) {
        form.receivedFxSnapshotId = quote.snapshotId ?? '';
        form.automaticFxRateToCny = quote.rateToCny;
        scheduleReceiptFxExpiry(quote);
      } else if (form.receivedCurrency !== 'CNY') {
        void loadReceiptFxQuote();
      }
    }
    void nextTick(() => {
      formRef.value?.clearValidate(['receivedFxRateToCny', 'receivedManualRateReason']);
    });
  }

  function scheduleReceiptFxExpiry(quote: V2OrderReceiptFxQuote) {
    clearReceiptFxExpiryTimer();
    if (!quote.expiresAt) return;
    const delay = Math.max(0, new Date(quote.expiresAt).getTime() - Date.now() + 50);
    receiptFxExpiryTimer = setTimeout(() => {
      receiptFxExpiryTimer = undefined;
      if (
        form.receivedCurrency !== quote.currency ||
        form.receivedFxRateToCny ||
        form.receivedFxSnapshotId !== quote.snapshotId
      ) {
        return;
      }
      form.receivedFxSnapshotId = '';
      form.automaticFxRateToCny = '';
      receiptFxError.value = '自动汇率已过期，正在重新采集';
      void loadReceiptFxQuote();
    }, delay);
  }

  function clearReceiptFxExpiryTimer() {
    if (receiptFxExpiryTimer) {
      clearTimeout(receiptFxExpiryTimer);
      receiptFxExpiryTimer = undefined;
    }
  }

  function isReceiptFxQuoteExpired(quote: V2OrderReceiptFxQuote) {
    return Boolean(quote.expiresAt && new Date(quote.expiresAt).getTime() <= Date.now());
  }

  async function ensureReceiptFxReadyForSubmit() {
    if (form.receivedCurrency === 'CNY' || form.receivedFxRateToCny) return true;
    const quote = receiptFxQuote.value;
    if (
      receiptFxLoading.value ||
      !quote ||
      !form.receivedFxSnapshotId ||
      !form.automaticFxRateToCny ||
      isReceiptFxQuoteExpired(quote)
    ) {
      const refreshed = await loadReceiptFxQuote();
      ElMessage.warning(
        refreshed
          ? '自动汇率已更新，请核对原币实收和预计利润后重新提交'
          : receiptFxError.value || '自动汇率暂不可用，请重试或填写人工汇率'
      );
      return false;
    }
    return true;
  }

  function applySuggestedReceivedAmount() {
    if (!suggestedReceipt.value.originalAmount) return;
    if (!recommendationApplied.value) {
      previousManualPrice.value = form.receivedOriginalAmount;
    }
    form.receivedOriginalAmount = suggestedReceipt.value.originalAmount;
    recommendationApplied.value = true;
    appliedSuggestedOriginal.value = suggestedReceipt.value.originalAmount;
    void nextTick(() => formRef.value?.clearValidate('receivedOriginalAmount'));
  }

  function undoSuggestedReceivedAmount() {
    if (!recommendationApplied.value) return;
    form.receivedOriginalAmount = previousManualPrice.value;
    recommendationApplied.value = false;
    appliedSuggestedOriginal.value = '';
    void nextTick(() => formRef.value?.clearValidate('receivedOriginalAmount'));
  }

  function handleManualPriceInput() {
    if (!recommendationApplied.value) return;
    recommendationApplied.value = false;
    appliedSuggestedOriginal.value = '';
  }

  function resetOrderReceiptPricing() {
    stopReceiptFxTasks();
    recommendationApplied.value = false;
    previousManualPrice.value = '';
    appliedSuggestedOriginal.value = '';
    receiptFxQuote.value = null;
    receiptFxError.value = '';
  }

  function stopReceiptFxTasks() {
    receiptFxRequestController?.abort();
    receiptFxRequestController = undefined;
    receiptFxRequestVersion += 1;
    clearReceiptFxExpiryTimer();
    receiptFxLoading.value = false;
  }

  onActivated(() => {
    if (
      form.receivedCurrency !== 'CNY' &&
      !form.receivedFxRateToCny &&
      (!receiptFxQuote.value || isReceiptFxQuoteExpired(receiptFxQuote.value))
    ) {
      void loadReceiptFxQuote();
    } else if (receiptFxQuote.value && !form.receivedFxRateToCny) {
      scheduleReceiptFxExpiry(receiptFxQuote.value);
    }
  });
  onDeactivated(stopReceiptFxTasks);
  onUnmounted(stopReceiptFxTasks);

  return {
    suggestedReceipt,
    recommendationApplied,
    appliedSuggestedOriginal,
    receiptFxQuote,
    receiptFxLoading,
    receiptFxError,
    handleReceivedCurrencyChange,
    handleManualFxRateInput,
    loadReceiptFxQuote,
    ensureReceiptFxReadyForSubmit,
    applySuggestedReceivedAmount,
    undoSuggestedReceivedAmount,
    handleManualPriceInput,
    resetOrderReceiptPricing
  };
}
