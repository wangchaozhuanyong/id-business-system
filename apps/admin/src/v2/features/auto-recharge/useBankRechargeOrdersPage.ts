import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { useRoute, useRouter } from 'vue-router';
import {
  divideDecimalStrings,
  multiplyDecimalStrings,
  roundDecimalString
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { ensureV2BusinessNowMs, getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { validateV2Form } from '@/v2/utils/formValidation';
import { useV2FormDraft, useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { bankRechargeApi, type BankRechargeOrder } from './bank-recharge-api';
import { emptyForm, emptyRefundForm } from './bank-recharge-order-form';
import { bankRechargePlanLabel as planLabel } from './recharge-plan-options';
import { bankRechargeOrderStatusLabel as statusLabel } from './recharge-presentation';

export function useBankRechargeOrdersPage() {
  const route = useRoute();
  const router = useRouter();
  const accountIdFilter = computed(() =>
    typeof route.query.accountId === 'string' ? route.query.accountId : ''
  );
  const linkedOrderNo = computed(() =>
    typeof route.query.orderNo === 'string' && accountIdFilter.value ? route.query.orderNo : ''
  );
  const businessNow = ref<number | null>(getV2BusinessNowMs());
  let disposed = false;
  let clockTimer: ReturnType<typeof setInterval> | undefined;
  onMounted(async () => {
    businessNow.value = await ensureV2BusinessNowMs();
    if (disposed) return;
    clockTimer = setInterval(() => {
      businessNow.value = getV2BusinessNowMs();
    }, 1000);
  });
  onUnmounted(() => {
    disposed = true;
    if (clockTimer) clearInterval(clockTimer);
  });
  const financeCurrencies = ['CNY', 'MYR', 'USD', 'USDT'];
  const page = useV2SessionDraft('auto-recharge/useBankRechargeOrdersPage:page', () => ref(1));
  const pageSize = useV2SessionDraft('auto-recharge/useBankRechargeOrdersPage:pageSize', () =>
    ref(20)
  );
  const keywordInput = useV2SessionDraft(
    'auto-recharge/useBankRechargeOrdersPage:keywordInput',
    () => ref(linkedOrderNo.value)
  );
  const statusInput = useV2SessionDraft('auto-recharge/useBankRechargeOrdersPage:statusInput', () =>
    ref('')
  );
  const keyword = useV2SessionDraft('auto-recharge/useBankRechargeOrdersPage:keyword', () =>
    ref(linkedOrderNo.value)
  );
  const status = useV2SessionDraft('auto-recharge/useBankRechargeOrdersPage:status', () => ref(''));
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
  } = useV2FormDraft('bank-orders-refund', emptyRefundForm);
  const { cardForm, currencyForm } = useV2SessionDraft('bank-order-related-create', () => ({
    cardForm: reactive({ label: '', last4: '', currencyCode: 'PHP' }),
    currencyForm: reactive({ code: '', name: '', minorUnits: 2 })
  }));
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
  } = useV2FormDraft('bank-orders-editor', emptyForm);
  const correctionReasons = useV2SessionDraft(
    'bank-orders-correction-reasons',
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
      !correcting.value &&
      selected.value &&
      ['completed', 'refunded', 'cancelled'].includes(selected.value.status)
    )
  );
  const rules: FormRules = {
    chargeAmount: [{ required: true, message: '请填写代付金额', trigger: 'blur' }],
    manualEvidenceRef: [{ required: true, message: '请填写付款凭据编号', trigger: 'blur' }]
  };

  const ordersQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: () =>
      createV2QueryKey({
        page: page.value,
        pageSize: pageSize.value,
        keyword: keyword.value,
        status: status.value,
        accountId: accountIdFilter.value
      }),
    keepPreviousData: true,
    query: ({ signal }) =>
      bankRechargeApi.listOrders(
        {
          page: page.value,
          pageSize: pageSize.value,
          keyword: keyword.value,
          status: status.value,
          accountId: accountIdFilter.value
        },
        { signal }
      )
  });
  watch([page, pageSize, keyword, status, accountIdFilter], () => {
    void ordersQuery.ensureFresh();
  });
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
        (item) => item.orderNo === linkedOrderNo.value && item.accountId === accountIdFilter.value
      );
      if (order && selected.value?.id !== order.id) openEdit(order);
    },
    { immediate: true }
  );
  const optionsQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'bank-recharge-order-options',
    query: ({ signal }) => bankRechargeApi.orderOptions({ signal })
  });
  const accountsQuery = useV2ModuleQuery({
    moduleKey: 'chatgpt-accounts',
    scope: 'auto-recharge',
    key: 'bank-recharge-account-options',
    query: ({ signal }) => bankRechargeApi.listAccounts({ signal })
  });
  const cardsQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'bank-recharge-card-options',
    query: ({ signal }) => bankRechargeApi.listCards({ signal })
  });
  const currenciesQuery = useV2ModuleQuery({
    moduleKey: 'bank-recharge-orders',
    scope: 'auto-recharge',
    key: 'bank-recharge-currency-options',
    query: ({ signal }) => bankRechargeApi.listCurrencies({ signal })
  });
  const data = computed(() => ordersQuery.data.value);
  const customers = ref<Array<{ id: string; name: string }>>([]);
  watch(
    () => optionsQuery.data.value?.customers,
    (items) => {
      if (!items) return;
      const selectedCustomer = customers.value.find((item) => item.id === form.customerId);
      customers.value = [...items];
      if (selectedCustomer && !items.some((item) => item.id === selectedCustomer.id)) {
        customers.value.unshift(selectedCustomer);
      }
    }
  );
  const accounts = computed(() =>
    (accountsQuery.data.value?.items ?? []).filter((item) => item.status === 'active')
  );
  const activeCurrencies = computed(() =>
    (currenciesQuery.data.value?.items ?? []).filter((item) => item.active)
  );
  const availableCards = computed(() =>
    (cardsQuery.data.value?.items ?? []).filter(
      (item) => item.active && item.currencyCode === form.chargeCurrencyCode
    )
  );
  const fundingAccounts = computed(() =>
    (optionsQuery.data.value?.financeAccounts ?? []).filter((item) => item.currency === 'CNY')
  );
  const receivedAccounts = computed(() =>
    (optionsQuery.data.value?.financeAccounts ?? []).filter(
      (item) => item.currency === form.receivedCurrencyCode
    )
  );
  const feeAccounts = computed(() => optionsQuery.data.value?.financeAccounts ?? []);
  const newFeeMode = computed(
    () => selected.value?.accountingVersion === 'subscription_cost_v2' || form.confirmFeeConversion
  );
  const feePreview = computed(() => {
    try {
      const fee = divideDecimalStrings(
        multiplyDecimalStrings(form.chargeAmount, form.customerFeeRate),
        '100'
      );
      const precision =
        activeCurrencies.value.find((item) => item.code === form.chargeCurrencyCode)?.minorUnits ??
        2;
      return roundDecimalString(fee, precision);
    } catch {
      return '—';
    }
  });

  function usageLabel(row: BankRechargeOrder) {
    if (row.activeSubscription?.status !== 'active') {
      return row.accountId ? '非当前使用' : '待关联账号';
    }
    if (businessNow.value === null) return '时间同步中';
    return row.dueAt && Date.parse(row.dueAt) <= businessNow.value ? '已到期' : '使用中';
  }
  function usageTagType(row: BankRechargeOrder) {
    const label = usageLabel(row);
    return label === '使用中' ? 'success' : label === '已到期' ? 'warning' : 'info';
  }
  function applyFilters() {
    keyword.value = keywordInput.value.trim();
    status.value = statusInput.value;
    page.value = 1;
  }
  function clearAccountFilter() {
    void router.replace({ path: '/v2/auto-recharge/bank-orders' });
  }
  function changePage(value: number) {
    page.value = value;
  }
  function changePageSize(value: number) {
    pageSize.value = value;
    page.value = 1;
  }
  function openCreate() {
    correcting.value = false;
    correctionReason.value = '';
    creating.value = true;
    selected.value = null;
    saveError.value = '';
    openFormDraft('create');
    customers.value = [...(optionsQuery.data.value?.customers ?? [])];
    drawerOpen.value = true;
  }
  function openEdit(row: BankRechargeOrder) {
    correcting.value = false;
    correctionReason.value = correctionReasons.get(row.id) ?? '';
    creating.value = false;
    selected.value = row;
    saveError.value = '';
    openFormDraft(
      row.id,
      {
        plan: row.plan,
        chargeCurrencyCode: row.chargeCurrencyCode,
        chargeAmount: row.chargeAmount,
        manualEvidenceRef: row.manualEvidenceRef ?? '',
        accountId: row.accountId ?? '',
        customerId: row.customerId ?? '',
        cardId: row.cardId ?? '',
        confirmFeeConversion: false,
        usdtFeeAmount: row.usdtFeeAmount ?? '',
        usdtFeeCurrencyCode: row.usdtFeeCurrencyCode ?? 'USDT',
        usdtFeeFinanceAccountId: row.usdtFeeFinanceAccountId ?? '',
        usdtFeeFxRateToCny: row.usdtFeeFxRateToCny ?? '',
        usdtFeeManualRateReason: '',
        shoppingFeeAmount: row.shoppingFeeAmount ?? '',
        shoppingFeeCurrencyCode: row.shoppingFeeCurrencyCode ?? 'CNY',
        shoppingFeeFinanceAccountId: row.shoppingFeeFinanceAccountId ?? '',
        shoppingFeeFxRateToCny: row.shoppingFeeFxRateToCny ?? '',
        shoppingFeeManualRateReason: '',
        customerFeeRate: row.customerFeeRate,
        feeOverride: row.customerFeeOverridden,
        customerFeeAmount: row.customerFeeOverridden ? row.customerFeeAmount : '',
        bankFeeAmount: row.bankFeeAmount ?? '0',
        bankFeeCurrencyCode: row.bankFeeCurrencyCode ?? row.chargeCurrencyCode,
        receivedAmount: row.receivedAmount ?? '',
        receivedCurrencyCode: row.receivedCurrencyCode ?? 'CNY',
        chargeFxRateToCny: row.chargeFxRateToCny ?? '',
        bankFeeFxRateToCny: row.bankFeeFxRateToCny ?? '',
        receivedFxRateToCny: row.receivedFxRateToCny ?? '',
        fundingFinanceAccountId: row.fundingFinanceAccountId ?? '',
        receivedFinanceAccountId: row.receivedFinanceAccountId ?? '',
        openedAt: row.openedAt ? toV2DateTimeInput(row.openedAt) : '',
        dueAt: row.dueAt ? toV2DateTimeInput(row.dueAt) : '',
        remark: row.remark ?? ''
      },
      row.updatedAt
    );
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
  function customerCreated(customer: { id: string; name: string }) {
    customers.value = [customer, ...customers.value.filter((item) => item.id !== customer.id)];
    form.customerId = customer.id;
  }
  async function save() {
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
          plan: form.plan,
          chargeCurrencyCode: form.chargeCurrencyCode,
          chargeAmount: form.chargeAmount,
          manualEvidenceRef: form.manualEvidenceRef,
          accountId: form.accountId || null,
          customerId: form.customerId || null
        });
        completeFormDraft();
        if (selected.value) correctionReasons.delete(selected.value.id);
        drawerOpen.value = false;
        await ordersQuery.refresh();
        openEdit(created);
        ElMessage.success('银充订单已建立，请继续补全手续费、收款和到期时间');
      } else if (selected.value) {
        const payload = {
          ...(selected.value.source === 'manual'
            ? {
                chargeAmount: form.chargeAmount,
                chargeCurrencyCode: form.chargeCurrencyCode,
                plan: form.plan
              }
            : {}),
          expectedUpdatedAt: formVersion.value ?? selected.value.updatedAt,
          accountId: form.accountId || null,
          customerId: form.customerId || null,
          cardId: form.cardId || null,
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
                bankFeeFxRateToCny: form.bankFeeFxRateToCny || null
              }),
          receivedAmount: form.receivedAmount || null,
          receivedCurrencyCode: form.receivedCurrencyCode || null,
          chargeFxRateToCny: form.chargeFxRateToCny || null,
          receivedFxRateToCny: form.receivedFxRateToCny || null,
          fundingFinanceAccountId: form.fundingFinanceAccountId || null,
          receivedFinanceAccountId: form.receivedFinanceAccountId || null,
          openedAt: form.openedAt ? v2DateTimeInputToIso(form.openedAt) : null,
          dueAt: form.dueAt ? v2DateTimeInputToIso(form.dueAt) : null,
          remark: form.remark
        };
        if (correcting.value)
          await bankRechargeApi.correctOrder(selected.value.id, {
            ...payload,
            reason: correctionReason.value.trim()
          });
        else await bankRechargeApi.updateOrder(selected.value.id, payload);
        completeFormDraft();
        if (selected.value) correctionReasons.delete(selected.value.id);
        drawerOpen.value = false;
        ElMessage.success(correcting.value ? '银充订单已更正并重新入账' : '银充订单已保存');
        await ordersQuery.refresh();
      }
    } catch (error) {
      saveError.value = getApiErrorMessage(error);
    } finally {
      saving.value = false;
    }
  }
  async function complete(row: BankRechargeOrder) {
    working.value = true;
    try {
      await bankRechargeApi.completeOrder(row.id, row.updatedAt);
      ElMessage.success('银充订单已完成并入账');
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
      ElMessage.success('银充币种已新增');
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
    feePreview,
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
