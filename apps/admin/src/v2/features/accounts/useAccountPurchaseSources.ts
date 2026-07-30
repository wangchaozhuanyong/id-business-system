import { computed, ref, type Ref } from 'vue';
import { getApiErrorMessage } from '@/api/client';
import { V2_DECIMAL_PLACES } from '@/v2/utils/decimal';
import { idBusinessV2AccountsApi } from './api';
import {
  calculateBalanceCost,
  isNonNegativeDecimal,
  isNonNegativeExchangeRate,
  type AccountFormState
} from './account-form';
import type { V2Account, V2AccountPurchaseSources } from './contracts';

export function useAccountPurchaseSources(
  form: AccountFormState,
  editingItem: Ref<V2Account | null>
) {
  const purchaseSources = ref<V2AccountPurchaseSources>({
    financeAccounts: [],
    supplierWallets: []
  });
  const purchaseSourcesLoading = ref(false);
  const purchaseSourcesError = ref('');
  const purchaseSourceOptions = computed(() => [
    ...purchaseSources.value.financeAccounts
      .filter((account) => account.currency === form.purchaseCurrency)
      .map((account) => ({
        value: `account:${account.id}`,
        label: `${account.name} · ${account.currency} · 余额 ${account.currentBalance}`
      })),
    ...purchaseSources.value.supplierWallets
      .filter((wallet) => wallet.currency === form.purchaseCurrency)
      .map((wallet) => ({
        value: `wallet:${wallet.id}`,
        label: `${wallet.supplierName}预存 · ${wallet.currency} · 余额 ${wallet.currentBalance}`
      }))
  ]);
  const purchaseCostPreview = computed(() => {
    const rate = form.purchaseCurrency === 'CNY' ? '1' : form.purchaseFxRateToCny;
    return calculateBalanceCost(form.purchaseOriginalAmount, rate) ?? '';
  });
  const purchaseEvidenceError = computed(() => {
    if (editingItem.value) return '';
    if (!isNonNegativeDecimal(form.purchaseOriginalAmount)) {
      return `请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负原币金额`;
    }
    if (!form.purchaseSourceId) return '请选择实际付款账户或供应商预存钱包';
    if (form.purchaseFxRateToCny && !isNonNegativeExchangeRate(form.purchaseFxRateToCny)) {
      return `请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负汇率`;
    }
    if (
      form.purchaseCurrency !== 'CNY' &&
      form.purchaseFxRateToCny &&
      !form.purchaseManualRateReason.trim()
    ) {
      return '手工填写汇率时必须说明原因';
    }
    return '';
  });

  async function loadPurchaseSources() {
    purchaseSourcesLoading.value = true;
    purchaseSourcesError.value = '';
    try {
      purchaseSources.value = await idBusinessV2AccountsApi.purchaseSources();
    } catch (error) {
      purchaseSourcesError.value = getApiErrorMessage(error);
    } finally {
      purchaseSourcesLoading.value = false;
    }
  }

  function handlePurchaseCurrencyChange() {
    form.purchaseSourceId = '';
    if (form.purchaseCurrency === 'CNY') {
      form.purchaseFxRateToCny = '';
      form.purchaseManualRateReason = '';
    }
  }

  return {
    purchaseSources,
    purchaseSourcesLoading,
    purchaseSourcesError,
    purchaseSourceOptions,
    purchaseCostPreview,
    purchaseEvidenceError,
    loadPurchaseSources,
    handlePurchaseCurrencyChange
  };
}
