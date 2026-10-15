import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import { V2_FINANCE_CURRENCIES } from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { useBankRechargeOrderTiming } from './useBankRechargeOrderTiming';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import {
  bankRechargeApi,
  type BankRechargeOrder,
  type RechargeOrderChannel
} from './bank-recharge-api';
import { emptyForm, emptyRefundForm, orderFormInitial } from './bank-recharge-order-form';
import { bankRechargePlanLabel as planLabel } from './recharge-plan-options';
import { bankRechargeOrderStatusLabel as statusLabel } from './recharge-presentation';
import { useBankRechargeOrderResources } from './useBankRechargeOrderResources';
import { useAuthStore } from '@/stores/auth';
import { canManageOnlineOrders } from '@/v2/features/online-recharge/public-api';
import { useBitOrderPricing } from './useBitOrderPricing';

export function useBankRechargeOrdersPage(channel: RechargeOrderChannel = 'bitbrowser') {
  const auth = useAuthStore();
  const canManage = computed(() => channel !== 'online' || canManageOnlineOrders(auth.user));
  const channelLabel = channel === 'online' ? '线上订单' : '比特订单';
  const draftKey = (key: string) => `recharge-orders:${channel}:${key}`;
  let active = true;
  onBeforeUnmount(() => {
    active = false;
  });
  const route = useRoute();
  const router = useRouter();
  const accountIdFilter = computed(() =>
    typeof route.query.accountId === 'string' ? route.query.accountId : ''
  );
  const linkedOrderNo = computed(() =>
    typeof route.query.orderNo === 'string' ? route.query.orderNo : ''
  );
  const financeCurrencies = V2_FINANCE_CURRENCIES;
  const pricing = useBitOrderPricing(channel);
  const executionSource = useV2SessionDraft(draftKey('bit-orders:execution-source'), () =>
    ref<'' | 'bitbrowser'>(channel === 'online' ? '' : 'bitbrowser')
  );
  const page = useV2SessionDraft(draftKey('auto-recharge/useBankRechargeOrdersPage:page'), () =>
    ref(1)
  );
  const pageSize = useV2SessionDraft(
    draftKey('auto-recharge/useBankRechargeOrdersPage:pageSize'),
    () => ref(20)
  );
  const keywordInput = useV2SessionDraft(
    draftKey('auto-recharge/useBankRechargeOrdersPage:keywordInput'),
    () => ref(linkedOrderNo.value)
  );
  const statusInput = useV2SessionDraft(
    draftKey('auto-recharge/useBankRechargeOrdersPage:statusInput'),
    () => ref('')
  );
  const keyword = useV2SessionDraft(
    draftKey('auto-recharge/useBankRechargeOrdersPage:keyword'),
    () => ref(linkedOrderNo.value)
  );
  const status = useV2SessionDraft(draftKey('auto-recharge/useBankRechargeOrdersPage:status'), () =>
    ref('')
  );
  if (linkedOrderNo.value) {
    keywordInput.value = linkedOrderNo.value;
    keyword.value = linkedOrderNo.value;
    page.value = 1;
  }
  const expiry = useV2SessionDraft(draftKey('bank-orders:expiry'), () =>
    ref<'all' | 'expired'>('all')
  );
  watch(expiry, () => (page.value = 1));
  watch(executionSource, () => (page.value = 1));
  const drawerOpen = ref(false);
  const quickCustomerOpen = ref(false);
  const cardOpen = ref(false);
  const currencyOpen = ref(false);
  const refundOpen = ref(false);
  const creating = ref(false);
  const correcting = ref(false);
  const correctionReason = ref('');
  const selected = ref<BankRechargeOrder | null>(null);
  const {
    form: refund,
    version: refundVersion,
    open: openRefundDraft,
    beginSave: beginRefundSave
  } = useV2FormDraft(draftKey('bank-orders-refund'), emptyRefundForm);
  const { cardForm, currencyForm } = useV2SessionDraft(
    draftKey('bank-order-related-create'),
    () => ({
      cardForm: reactive({ label: '', last4: '', currencyCode: 'PHP' }),
      currencyForm: reactive({ code: '', name: '', minorUnits: 2 })
    })
  );
  const saving = ref(false);
  const working = ref(false);
  const saveError = ref('');
  const formRef = ref<FormInstance>();
  const {
    form,
    original,
    version: formVersion,
    open: openFormDraft,
    beginSave: beginFormSave
  } = useV2FormDraft(draftKey('bank-orders-editor'), emptyForm);
  const { usageLabel, usageTagType, initializeDates } = useBankRechargeOrderTiming(
    form,
    () => selected.value?.source === 'automatic'
  );
  const correctionReasons = useV2SessionDraft(
    draftKey('bank-orders-correction-reasons'),
    () => new Map<string, string>()
  );
  watch(correctionReason, (reason) => {
    if (correcting.value && selected.value) correctionReasons.set(selected.value.id, reason);
  });
  const dirty = computed(
    () =>
      JSON.stringify(form) !== original.value ||
      (correcting.value && Boolean(correctionReason.value))
  );
  const readonly = computed(() =>
    Boolean(
      !canManage.value ||
      (!correcting.value &&
        selected.value &&
        ['completed', 'refunded', 'cancelled'].includes(selected.value.status))
    )
  );
  const rules: FormRules = {
    chargeAmount: [{ required: true, message: '请填写代付金额', trigger: 'blur' }],
    manualEvidenceRef: [{ required: true, message: '请填写付款凭据编号', trigger: 'blur' }]
  };

  const deletedFilter = useV2SessionDraft(draftKey('bank-recharge-orders:deleted'), () =>
    ref<'active' | 'deleted'>('active')
  );
  const listQuery = () => ({
    channel,
    page: page.value,
    pageSize: pageSize.value,
    keyword: keyword.value,
    status: status.value,
    expiry: expiry.value,
    deleted: deletedFilter.value,
    accountId: accountIdFilter.value,
    executionSource: channel === 'bitbrowser' ? executionSource.value || undefined : undefined
  });
  const ordersQuery = useV2ModuleQuery<Awaited<ReturnType<typeof bankRechargeApi.listOrders>>>({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: () => createV2QueryKey(listQuery()),
    keepPreviousData: true,
    getRevalidateAt: (result) =>
      Date.now() + Math.max(1000, Date.parse(result.revalidateAt) - Date.parse(result.evaluatedAt)),
    query: ({ signal }) => bankRechargeApi.listOrders(listQuery(), { signal })
  });
  watch(
    [page, pageSize, keyword, status, expiry, accountIdFilter, deletedFilter, executionSource],
    () => {
      void ordersQuery.ensureFresh();
    }
  );
  watch([accountIdFilter, linkedOrderNo], () => {
    keywordInput.value = linkedOrderNo.value;
    keyword.value = linkedOrderNo.value;
    page.value = 1;
    selected.value = null;
    drawerOpen.value = false;
  });
  watch(
    () => ordersQuery.data.value?.items,
    (items) => {
      if (!linkedOrderNo.value || !items) return;
      const order = items.find(
        (item) =>
          item.orderNo === linkedOrderNo.value &&
          (!accountIdFilter.value || item.accountId === accountIdFilter.value)
      );
      if (order && selected.value?.id !== order.id) openEdit(order);
    },
    { immediate: true }
  );
  const data = computed(() => ordersQuery.data.value);
  const {
    optionsQuery,
    accountsQuery,
    cardsQuery,
    currenciesQuery,
    customers,
    accounts,
    activeCurrencies,
    availableCards,
    fundingAccounts,
    receivedAccounts,
    feeAccounts
  } = useBankRechargeOrderResources(channel, form, () => selected.value?.onlineRechargeCardId);
  const newFeeMode = computed(
    () => selected.value?.accountingVersion === 'subscription_cost_v2' || form.confirmFeeConversion
  );
  function applyFilters() {
    keyword.value = keywordInput.value.trim();
    status.value = statusInput.value;
    page.value = 1;
  }
  function clearAccountFilter() {
    void router.replace({
      path: '/v2/auto-recharge/bank-orders',
      query: channel === 'online' ? { channel } : {}
    });
  }
  function changePage(value: number) {
    page.value = value;
  }
  function changePageSize(value: number) {
    pageSize.value = value;
    page.value = 1;
  }
  function changeChargeCurrency() {
    form.chargeFxRateToCny = '';
    if (channel === 'bitbrowser') form.cardId = '';
  }
  function openCreate() {
    correcting.value = false;
    correctionReason.value = '';
    creating.value = true;
    selected.value = null;
    saveError.value = '';
    openFormDraft('create');
    initializeDates();
    customers.value = [...(optionsQuery.data.value?.customers ?? [])];
    drawerOpen.value = true;
  }
  function openEdit(row: BankRechargeOrder) {
    correcting.value = false;
    correctionReason.value = correctionReasons.get(row.id) ?? '';
    creating.value = false;
    selected.value = row;
    saveError.value = '';
    openFormDraft(row.id, orderFormInitial(row, channel), row.updatedAt);
    customers.value = [...(optionsQuery.data.value?.customers ?? [])];
    if (row.customer && !customers.value.some((item) => item.id === row.customer!.id))
      customers.value.unshift(row.customer);
    drawerOpen.value = true;
  }
  function openCorrection(row: BankRechargeOrder) {
    openEdit(row);
    correcting.value = true;
    correctionReason.value = correctionReasons.get(row.id) ?? '';
  }
  function applyPricingDefaults() {
    if (!selected.value || readonly.value || !newFeeMode.value) return;
    try {
      ElMessage.info(pricing.applyDefaults(form, selected.value));
    } catch (error) {
      ElMessage.error(error instanceof Error ? error.message : '请核对金额与汇率');
    }
  }
  function customerCreated(customer: { id: string; name: string }) {
    customers.value = [customer, ...customers.value.filter((item) => item.id !== customer.id)];
    form.customerId = customer.id;
  }
  async function save() {
    if (!canManage.value) return;
    if (correcting.value && !correctionReason.value.trim()) {
      saveError.value = '请填写更正原因';
      return;
    }
    if (readonly.value) return;
    if (creating.value && !(await validateV2Form(formRef.value))) return;
    saving.value = true;
    const completeFormDraft = beginFormSave();
    saveError.value = '';
    try {
      if (creating.value) {
        const created = await bankRechargeApi.createManualOrder({
          channel,
          plan: form.plan,
          chargeCurrencyCode: form.chargeCurrencyCode,
          chargeAmount: form.chargeAmount,
          manualEvidenceRef: form.manualEvidenceRef,
          accountId: form.accountId || null,
          customerId: form.customerId || null,
          openedAt: form.openedAt ? v2DateTimeInputToIso(form.openedAt) : null,
          dueAt: form.dueAt ? v2DateTimeInputToIso(form.dueAt) : null
        });
        completeFormDraft();
        if (!active) return;
        if (selected.value) correctionReasons.delete(selected.value.id);
        drawerOpen.value = false;
        await ordersQuery.refresh();
        if (!active) return;
        openEdit(created);
        executionSource.value = '';
        ElMessage.success(`${channelLabel}已建立，请继续补全手续费、收款和到期时间`);
      } else if (selected.value) {
        const payload = {
          ...(selected.value.source === 'manual'
            ? {
                chargeAmount: form.chargeAmount,
                chargeCurrencyCode: form.chargeCurrencyCode,
                plan: form.plan
              }
            : {}),
          ...(channel === 'online' &&
          (selected.value.chargeAmount == null || !selected.value.chargeCurrencyCode)
            ? {
                chargeAmount: form.chargeAmount || null,
                chargeCurrencyCode: form.chargeCurrencyCode || null
              }
            : {}),
          ...(channel === 'online' &&
          selected.value.source === 'automatic' &&
          form.paymentEvidenceRef.trim()
            ? { paymentEvidenceRef: form.paymentEvidenceRef.trim() }
            : {}),
          expectedUpdatedAt: formVersion.value ?? selected.value.updatedAt,
          accountId: form.accountId || null,
          customerId: form.customerId || null,
          ...(channel === 'online'
            ? { onlineRechargeCardId: form.cardId || null }
            : { cardId: form.cardId || null }),
          ...(newFeeMode.value
            ? {
                confirmFeeConversion: form.confirmFeeConversion,
                usdtFeeAmount: form.usdtFeeAmount || null,
                usdtFeeCurrencyCode: form.usdtFeeCurrencyCode || null,
                usdtFeeFinanceAccountId: form.usdtFeeFinanceAccountId || null,
                usdtFeeFxRateToCny: form.usdtFeeFxRateToCny || null,
                usdtFeeManualRateReason: form.usdtFeeManualRateReason || null,
                shoppingFeeAmount: form.shoppingFeeAmount || null,
                shoppingFeeCurrencyCode: form.shoppingFeeCurrencyCode || null,
                shoppingFeeFinanceAccountId: form.shoppingFeeFinanceAccountId || null,
                shoppingFeeFxRateToCny: form.shoppingFeeFxRateToCny || null,
                shoppingFeeManualRateReason: form.shoppingFeeManualRateReason || null
              }
            : {
                customerFeeRate: form.customerFeeRate,
                customerFeeAmount: form.feeOverride ? form.customerFeeAmount : null,
                bankFeeAmount: form.bankFeeAmount || null,
                bankFeeCurrencyCode: form.bankFeeCurrencyCode || null,
                bankFeeFxRateToCny:
                  form.bankFeeCurrencyCode === 'CNY' ? '1' : form.bankFeeFxRateToCny || null
              }),
          receivedAmount: form.receivedAmount || null,
          receivedCurrencyCode: form.receivedCurrencyCode || null,
          chargeFxRateToCny:
            form.chargeCurrencyCode === 'CNY' ? '1' : form.chargeFxRateToCny || null,
          receivedFxRateToCny:
            form.receivedCurrencyCode === 'CNY' ? '1' : form.receivedFxRateToCny || null,
          fundingFinanceAccountId: form.fundingFinanceAccountId || null,
          receivedFinanceAccountId: form.receivedFinanceAccountId || null,
          openedAt:
            selected.value.source === 'automatic' && channel === 'bitbrowser'
              ? selected.value.openedAt
              : form.openedAt
                ? v2DateTimeInputToIso(form.openedAt)
                : null,
          dueAt:
            selected.value.source === 'automatic' && channel === 'bitbrowser'
              ? selected.value.dueAt
              : form.dueAt
                ? v2DateTimeInputToIso(form.dueAt)
                : null,
          remark: form.remark
        };
        if (correcting.value)
          await bankRechargeApi.correctOrder(selected.value.id, {
            ...payload,
            reason: correctionReason.value.trim()
          });
        else await bankRechargeApi.updateOrder(selected.value.id, payload);
        completeFormDraft();
        if (!active) return;
        if (selected.value) correctionReasons.delete(selected.value.id);
        drawerOpen.value = false;
        ElMessage.success(`${channelLabel}${correcting.value ? '已更正并重新入账' : '已保存'}`);
        await ordersQuery.refresh();
      }
    } catch (error) {
      saveError.value = getApiErrorMessage(error);
    } finally {
      saving.value = false;
    }
  }
  async function complete(row: BankRechargeOrder) {
    if (!canManage.value) return;
    working.value = true;
    try {
      await bankRechargeApi.completeOrder(row.id, row.updatedAt);
      ElMessage.success(`${channelLabel}已完成并入账`);
      await ordersQuery.refresh();
    } catch (error) {
      ElMessage.error(getApiErrorMessage(error));
    } finally {
      working.value = false;
    }
  }
  function openRefund(row: BankRechargeOrder) {
    selected.value = row;
    openRefundDraft(
      row.id,
      {
        reason: '',
        refundReference: '',
        customerRefundAmount: '',
        chargeRecoveryAmountCny: '0',
        bankFeeRecoveryAmountCny: '0',
        usdtFeeRecoveryAmount: '0',
        shoppingFeeRecoveryAmount: '0',
        upstreamRefundReference: ''
      },
      row.updatedAt
    );
    saveError.value = '';
    refundOpen.value = true;
  }
  async function confirmRefund() {
    if (!canManage.value) return;
    if (!selected.value || !refund.reason.trim() || !refund.refundReference.trim()) {
      saveError.value = '请填写退款原因和真实退款凭据';
      return;
    }
    working.value = true;
    const completeRefundDraft = beginRefundSave();
    saveError.value = '';
    try {
      await bankRechargeApi.refundOrder(selected.value.id, {
        expectedUpdatedAt: refundVersion.value ?? selected.value.updatedAt,
        reason: refund.reason.trim(),
        refundReference: refund.refundReference.trim(),
        customerRefundAmount: refund.customerRefundAmount.trim(),
        chargeRecoveryAmountCny: refund.chargeRecoveryAmountCny.trim() || '0',
        ...(selected.value.accountingVersion === 'subscription_cost_v2'
          ? {
              usdtFeeRecoveryAmount: refund.usdtFeeRecoveryAmount.trim() || '0',
              shoppingFeeRecoveryAmount: refund.shoppingFeeRecoveryAmount.trim() || '0'
            }
          : { bankFeeRecoveryAmountCny: refund.bankFeeRecoveryAmountCny.trim() || '0' }),
        upstreamRefundReference: refund.upstreamRefundReference.trim()
      });
      completeRefundDraft();
      refundOpen.value = false;
      ElMessage.success('已按实际退款与回款金额登记账务');
      await ordersQuery.refresh();
    } catch (error) {
      saveError.value = getApiErrorMessage(error);
    } finally {
      working.value = false;
    }
  }
  async function saveCurrency() {
    if (!/^[A-Za-z]{3}$/.test(currencyForm.code) || !currencyForm.name.trim()) {
      saveError.value = '请填写三位币种代码和名称';
      return;
    }
    working.value = true;
    saveError.value = '';
    try {
      await bankRechargeApi.createCurrency({
        code: currencyForm.code.toUpperCase(),
        name: currencyForm.name.trim(),
        minorUnits: currencyForm.minorUnits
      });
      currencyOpen.value = false;
      Object.assign(currencyForm, { code: '', name: '', minorUnits: 2 });
      await currenciesQuery.refresh();
      ElMessage.success('比特充值币种已新增');
    } catch (error) {
      saveError.value = getApiErrorMessage(error);
    } finally {
      working.value = false;
    }
  }
  async function saveCard() {
    if (!cardForm.label.trim() || !/^\d{4}$/.test(cardForm.last4)) {
      saveError.value = '请填写银行卡名称和卡尾四位';
      return;
    }
    working.value = true;
    saveError.value = '';
    try {
      const created = await bankRechargeApi.createCard({
        ...cardForm,
        label: cardForm.label.trim()
      });
      cardOpen.value = false;
      Object.assign(cardForm, {
        label: '',
        last4: '',
        currencyCode: 'PHP'
      });
      await cardsQuery.refresh();
      if (selected.value?.chargeCurrencyCode === created.currencyCode) form.cardId = created.id;
      ElMessage.success('银行卡标识已新增');
    } catch (error) {
      saveError.value = getApiErrorMessage(error);
    } finally {
      working.value = false;
    }
  }

  return {
    canManage,
    channel,
    channelLabel,
    pricing,
    executionSource,
    applyPricingDefaults,
    deletedFilter,
    expiry,
    financeCurrencies,
    page,
    pageSize,
    keywordInput,
    statusInput,
    keyword,
    status,
    accountIdFilter,
    clearAccountFilter,
    drawerOpen,
    quickCustomerOpen,
    cardOpen,
    currencyOpen,
    refundOpen,
    creating,
    correcting,
    correctionReason,
    selected,
    refund,
    cardForm,
    currencyForm,
    saving,
    working,
    saveError,
    formRef,
    form,
    original,
    dirty,
    readonly,
    rules,
    ordersQuery,
    optionsQuery,
    accountsQuery,
    cardsQuery,
    currenciesQuery,
    data,
    customers,
    accounts,
    activeCurrencies,
    availableCards,
    fundingAccounts,
    receivedAccounts,
    feeAccounts,
    newFeeMode,
    emptyForm,
    statusLabel,
    planLabel,
    usageLabel,
    usageTagType,
    applyFilters,
    changePage,
    changePageSize,
    changeChargeCurrency,
    openCreate,
    openEdit,
    openCorrection,
    customerCreated,
    save,
    complete,
    openRefund,
    confirmRefund,
    saveCurrency,
    saveCard
  };
}
