import { computed, reactive, ref } from 'vue';
import {
  V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES,
  calculateV2PurchaseRate,
  divideDecimalStrings,
  type V2PurchaseRateRoundingMode
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { ensureV2BusinessNowInput } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { idBusinessV2ExchangeRatesApi } from './api';
import type { V2PurchaseQuote } from './contracts';

export function usePurchaseQuoteEditor(options: { refresh: () => Promise<unknown> }) {
  const purchaseDrawerVisible = ref(false);
  const purchaseSaving = ref(false);
  const purchaseForm = reactive({
    code: '',
    nameCn: '',
    displayName: '',
    purchaseRatioPercent: '',
    quoteUnit: '1',
    decimalPlaces: 4,
    roundingMode: 'ROUND_DOWN' as V2PurchaseRateRoundingMode,
    enabled: true,
    sortOrder: 0,
    overrideMarketRate: false,
    marketRateCnyPerUnit: '',
    marketRateCapturedAt: '',
    marketRateSourceReference: ''
  });

  const purchasePreview = computed(() => {
    const marketRate = parseRate(purchaseForm.marketRateCnyPerUnit);
    const percent = purchaseForm.purchaseRatioPercent.trim();
    if (
      !marketRate ||
      !isV2UnsignedDecimal(percent, {
        allowZero: false,
        decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
      }) ||
      Number(percent) > 100 ||
      !parseRate(purchaseForm.quoteUnit)
    ) {
      return null;
    }
    try {
      return calculateV2PurchaseRate({
        marketRateCnyPerUnit: marketRate,
        purchaseRatio: divideDecimalStrings(percent, '100', V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES),
        quoteUnit: purchaseForm.quoteUnit.trim(),
        decimalPlaces: purchaseForm.decimalPlaces,
        roundingMode: purchaseForm.roundingMode
      });
    } catch {
      return null;
    }
  });

  async function openPurchaseQuote(entry: V2PurchaseQuote) {
    const capturedAt = entry.latestSnapshot?.marketRateCapturedAt
      ? toV2DateTimeInput(entry.latestSnapshot.marketRateCapturedAt)
      : await ensureV2BusinessNowInput();
    if (!capturedAt) {
      ElMessage.error('无法读取服务器北京时间，请稍后重试');
      return;
    }
    Object.assign(purchaseForm, {
      code: entry.code,
      nameCn: entry.nameCn,
      displayName: entry.displayName || '',
      purchaseRatioPercent: entry.purchaseRatioPercent,
      quoteUnit: entry.quoteUnit,
      decimalPlaces: entry.decimalPlaces,
      roundingMode: entry.roundingMode,
      enabled: entry.enabled,
      sortOrder: entry.sortOrder,
      overrideMarketRate: false,
      marketRateCnyPerUnit: entry.latestSnapshot?.marketRateCnyPerUnit || '',
      marketRateCapturedAt: capturedAt,
      marketRateSourceReference: entry.latestSnapshot?.marketRateSourceReference || ''
    });
    purchaseDrawerVisible.value = true;
  }

  async function savePurchaseQuote() {
    purchaseSaving.value = true;
    try {
      await idBusinessV2ExchangeRatesApi.updatePurchaseQuote(purchaseForm.code, {
        nameCn: purchaseForm.nameCn.trim(),
        displayName: purchaseForm.displayName.trim() || null,
        purchaseRatioPercent: purchaseForm.purchaseRatioPercent.trim(),
        quoteUnit: purchaseForm.quoteUnit.trim(),
        decimalPlaces: purchaseForm.decimalPlaces,
        roundingMode: purchaseForm.roundingMode,
        enabled: purchaseForm.enabled,
        sortOrder: purchaseForm.sortOrder,
        marketRateCnyPerUnit: purchaseForm.overrideMarketRate
          ? purchaseForm.marketRateCnyPerUnit.trim() || null
          : null,
        marketRateCapturedAt:
          purchaseForm.overrideMarketRate && purchaseForm.marketRateCnyPerUnit.trim()
            ? v2DateTimeInputToIso(purchaseForm.marketRateCapturedAt)
            : null,
        marketRateSourceReference: purchaseForm.overrideMarketRate
          ? purchaseForm.marketRateSourceReference.trim() || null
          : null
      });
      purchaseDrawerVisible.value = false;
      ElMessage.success(
        purchaseForm.overrideMarketRate
          ? '手工市场汇率已保存并重新计算'
          : '收购报价设置已保存，并按最后有效汇率重新计算'
      );
      await options.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      purchaseSaving.value = false;
    }
  }

  function purchaseRoundingLabel(mode: V2PurchaseRateRoundingMode) {
    if (mode === 'ROUND_HALF_UP') return '四舍五入';
    if (mode === 'ROUND_UP') return '向上取整';
    return '向下截断';
  }

  return {
    purchaseDrawerVisible,
    purchaseSaving,
    purchaseForm,
    purchasePreview,
    openPurchaseQuote,
    savePurchaseQuote,
    purchaseRoundingLabel
  };
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
