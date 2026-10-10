import { computed, nextTick, ref, watch } from 'vue';
import { V2_BANK_RECHARGE_PLANS } from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { primeV2Query, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  bankRechargeApi,
  type BankRechargeOrder,
  type BitOrderPricingSettings
} from './bank-recharge-api';
import { estimateBitOrder, bitOrderPricingFormDefaults } from './bit-order-pricing';
import type { emptyForm } from './bank-recharge-order-form';

function emptySettings(): BitOrderPricingSettings {
  return {
    receivedCurrencyCode: 'CNY',
    shoppingFeePercent: null,
    usdtFeePercent: null,
    planPrices: Object.fromEntries(V2_BANK_RECHARGE_PLANS.map((plan) => [plan, null])),
    updatedAt: null
  };
}
export function useBitOrderPricing() {
  const open = ref(false),
    saving = ref(false),
    error = ref(''),
    initialized = ref(false);
  const draft = useV2FormDraft('bit-orders-pricing-settings', emptySettings);
  const dirty = computed(() => JSON.stringify(draft.form) !== draft.original.value);
  const query = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'bit-orders-pricing-settings',
    query: ({ signal }) => bankRechargeApi.orderPricingSettings({ signal })
  });
  const ratesQuery = useV2ModuleQuery<
    Awaited<ReturnType<typeof bankRechargeApi.orderPricingRates>>
  >({
    moduleKey: 'bank-recharge-orders',
    scope: 'exchange-rates',
    key: 'bit-orders-pricing-rates',
    getRevalidateAt: (result) => {
      const expiries = result.items
        .map((rate) => (rate.expiresAt ? Date.parse(rate.expiresAt) : NaN))
        .filter((time) => time > Date.now());
      return expiries.length ? Math.min(...expiries) : null;
    },
    query: ({ signal }) => bankRechargeApi.orderPricingRates({ signal })
  });
  watch(
    query.data,
    (data) => {
      if (data && !saving.value && (!initialized.value || !dirty.value)) {
        if (initialized.value) draft.beginSave()();
        draft.open('settings', JSON.parse(JSON.stringify(data)), data.updatedAt ?? undefined);
        initialized.value = true;
      }
    },
    { immediate: true }
  );
  async function openSettings() {
    error.value = '';
    open.value = true;
    await nextTick();
    await query.refresh();
  }
  async function save() {
    if (saving.value || query.phase.value !== 'ready') return;
    saving.value = true;
    error.value = '';
    const input = JSON.parse(JSON.stringify(draft.form)) as BitOrderPricingSettings;
    const finish = draft.beginSave();
    const identityEpoch = sessionCoordinator.identityEpoch.value;
    try {
      const result = await bankRechargeApi.updateOrderPricingSettings(input);
      if (identityEpoch !== sessionCoordinator.identityEpoch.value) return;
      primeV2Query({ scope: 'auto-recharge', key: 'bit-orders-pricing-settings', data: result });
      if (finish()) {
        draft.open('settings', result, result.updatedAt ?? undefined);
        open.value = false;
      } else {
        draft.form.updatedAt = result.updatedAt;
        draft.original.value = JSON.stringify(result);
      }
      ElMessage.success('套餐收费和手续费比例已保存');
    } catch (reason) {
      if (identityEpoch === sessionCoordinator.identityEpoch.value)
        error.value = getApiErrorMessage(reason);
    } finally {
      saving.value = false;
    }
  }
  async function reloadSaved() {
    if (saving.value) return;
    saving.value = true;
    error.value = '';
    const finish = draft.beginSave();
    const identityEpoch = sessionCoordinator.identityEpoch.value;
    try {
      const result = await bankRechargeApi.orderPricingSettings();
      if (identityEpoch !== sessionCoordinator.identityEpoch.value) return;
      primeV2Query({ scope: 'auto-recharge', key: 'bit-orders-pricing-settings', data: result });
      if (finish()) draft.open('settings', result, result.updatedAt ?? undefined);
      else error.value = '加载期间有新输入，已保留；再次点击重新载入可恢复已保存设置';
    } catch (reason) {
      if (identityEpoch === sessionCoordinator.identityEpoch.value)
        error.value = getApiErrorMessage(reason);
    } finally {
      saving.value = false;
    }
  }
  const estimate = (row: BankRechargeOrder) =>
    estimateBitOrder(row, query.data.value, ratesQuery.data.value?.items ?? []);
  function applyDefaults(form: ReturnType<typeof emptyForm>, order: BankRechargeOrder) {
    const { patch, preview } = bitOrderPricingFormDefaults(
      order,
      form,
      query.data.value,
      ratesQuery.data.value?.items ?? []
    );
    Object.assign(form, patch);
    return preview.usdtFee === null || preview.shoppingFee === null
      ? '部分费用缺少设置或有效汇率，请核对；收款参考价也需确认实际到账'
      : '已按当前金额计算，请核对实际收款及费用付款账户后保存';
  }
  return {
    open,
    saving,
    error,
    draft,
    dirty,
    query,
    ratesQuery,
    openSettings,
    save,
    estimate,
    applyDefaults,
    reloadSaved
  };
}
