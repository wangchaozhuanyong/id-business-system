import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import {
  divideDecimalStrings,
  multiplyDecimalStrings,
  roundDecimalString
} from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { validateV2Form } from '@/v2/utils/formValidation';
import {
  bankRechargeApi,
  type BankRechargeOrder,
  type BankRechargeOrderStatus
} from './bank-recharge-api';

export function useBankRechargeOrdersPage() {
  const financeCurrencies = ['CNY', 'MYR', 'USD', 'USDT'];
  const page = ref(1);
  const pageSize = ref(20);
  const keywordInput = ref('');
  const statusInput = ref('');
  const keyword = ref('');
  const status = ref('');
  const drawerOpen = ref(false);
  const quickCustomerOpen = ref(false);
  const cardOpen = ref(false);
  const currencyOpen = ref(false);
  const refundOpen = ref(false);
  const creating = ref(false);
  const selected = ref<BankRechargeOrder | null>(null);
  const refund = reactive({ reason: '', refundReference: '' });
  const cardForm = reactive({
    label: '',
    last4: '',
    currencyCode: 'PHP'
  });
  const currencyForm = reactive({ code: '', name: '', minorUnits: 2 });
  const saving = ref(false);
  const working = ref(false);
  const saveError = ref('');
  const formRef = ref<FormInstance>();
  const form = reactive(emptyForm());
  const original = ref('');
  const dirty = computed(() => JSON.stringify(form) !== original.value);
  const readonly = computed(() =>
    Boolean(
      selected.value && ['completed', 'refunded', 'cancelled'].includes(selected.value.status)
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
        status: status.value
      }),
    keepPreviousData: true,
    query: ({ signal }) =>
      bankRechargeApi.listOrders(
        {
          page: page.value,
          pageSize: pageSize.value,
          keyword: keyword.value,
          status: status.value
        },
        { signal }
      )
  });
  watch([page, pageSize, keyword, status], () => {
    void ordersQuery.ensureFresh();
  });
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
      (item) =>
        item.active &&
        item.currencyCode === (selected.value?.chargeCurrencyCode ?? form.chargeCurrencyCode)
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
  const feePreview = computed(() => {
    try {
      const fee = divideDecimalStrings(
        multiplyDecimalStrings(
          selected.value?.chargeAmount ?? form.chargeAmount,
          form.customerFeeRate
        ),
        '100'
      );
      const precision =
        activeCurrencies.value.find(
          (item) => item.code === (selected.value?.chargeCurrencyCode ?? form.chargeCurrencyCode)
        )?.minorUnits ?? 2;
      return roundDecimalString(fee, precision);
    } catch {
      return '—';
    }
  });

  function emptyForm() {
    return {
      plan: 'plus',
      chargeCurrencyCode: 'PHP',
      chargeAmount: '',
      manualEvidenceRef: '',
      accountId: '',
      customerId: '',
      cardId: '',
      customerFeeRate: '0',
      feeOverride: false,
      customerFeeAmount: '',
      bankFeeAmount: '0',
      bankFeeCurrencyCode: 'PHP',
      receivedAmount: '',
      receivedCurrencyCode: 'CNY',
      chargeFxRateToCny: '',
      bankFeeFxRateToCny: '',
      receivedFxRateToCny: '',
      fundingFinanceAccountId: '',
      receivedFinanceAccountId: '',
      openedAt: '',
      dueAt: '',
      remark: ''
    };
  }
  function statusLabel(value: BankRechargeOrderStatus) {
    return {
      pending_details: '待补全',
      pending_finance: '待入账',
      pending_receipt: '待收款',
      completed: '已完成',
      refunded: '已退款',
      cancelled: '已取消'
    }[value];
  }
  function planLabel(value: string) {
    return (
      ({ plus: 'Plus', 'pro-5x': 'Pro 5×', 'pro-20x': 'Pro 20×' } as Record<string, string>)[
        value
      ] ?? value
    );
  }
  function usageLabel(row: BankRechargeOrder) {
    if (row.activeSubscription?.status !== 'active') {
      return row.accountId ? '非当前使用' : '待关联账号';
    }
    return row.dueAt && Date.parse(row.dueAt) <= Date.now() ? '已到期' : '使用中';
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
  function changePage(value: number) {
    page.value = value;
  }
  function changePageSize(value: number) {
    pageSize.value = value;
    page.value = 1;
  }
  function openCreate() {
    creating.value = true;
    selected.value = null;
    saveError.value = '';
    Object.assign(form, emptyForm());
    original.value = JSON.stringify(form);
    customers.value = [...(optionsQuery.data.value?.customers ?? [])];
    drawerOpen.value = true;
  }
  function openEdit(row: BankRechargeOrder) {
    creating.value = false;
    selected.value = row;
    saveError.value = '';
    Object.assign(form, {
      plan: row.plan,
      chargeCurrencyCode: row.chargeCurrencyCode,
      chargeAmount: row.chargeAmount,
      manualEvidenceRef: row.manualEvidenceRef ?? '',
      accountId: row.accountId ?? '',
      customerId: row.customerId ?? '',
      cardId: row.cardId ?? '',
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
    });
    original.value = JSON.stringify(form);
    customers.value = [...(optionsQuery.data.value?.customers ?? [])];
    if (row.customer && !customers.value.some((item) => item.id === row.customer!.id))
      customers.value.unshift(row.customer);
    drawerOpen.value = true;
  }
  function customerCreated(customer: { id: string; name: string }) {
    customers.value = [customer, ...customers.value.filter((item) => item.id !== customer.id)];
    form.customerId = customer.id;
  }
  async function save() {
    if (readonly.value) return;
    if (creating.value && !(await validateV2Form(formRef.value))) return;
    saving.value = true;
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
        drawerOpen.value = false;
        await ordersQuery.refresh();
        openEdit(created);
        ElMessage.success('银充订单已建立，请继续补全手续费、收款和到期时间');
      } else if (selected.value) {
        await bankRechargeApi.updateOrder(selected.value.id, {
          expectedUpdatedAt: selected.value.updatedAt,
          accountId: form.accountId || null,
          customerId: form.customerId || null,
          cardId: form.cardId || null,
          customerFeeRate: form.customerFeeRate,
          customerFeeAmount: form.feeOverride ? form.customerFeeAmount : null,
          bankFeeAmount: form.bankFeeAmount || null,
          bankFeeCurrencyCode: form.bankFeeCurrencyCode || null,
          receivedAmount: form.receivedAmount || null,
          receivedCurrencyCode: form.receivedCurrencyCode || null,
          chargeFxRateToCny: form.chargeFxRateToCny || null,
          bankFeeFxRateToCny: form.bankFeeFxRateToCny || null,
          receivedFxRateToCny: form.receivedFxRateToCny || null,
          fundingFinanceAccountId: form.fundingFinanceAccountId || null,
          receivedFinanceAccountId: form.receivedFinanceAccountId || null,
          openedAt: form.openedAt ? v2DateTimeInputToIso(form.openedAt) : null,
          dueAt: form.dueAt ? v2DateTimeInputToIso(form.dueAt) : null,
          remark: form.remark
        });
        drawerOpen.value = false;
        ElMessage.success('银充订单已保存');
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
    refund.reason = '';
    refund.refundReference = '';
    saveError.value = '';
    refundOpen.value = true;
  }
  async function confirmRefund() {
    if (!selected.value || !refund.reason.trim() || !refund.refundReference.trim()) {
      saveError.value = '请填写退款原因和真实退款凭据';
      return;
    }
    working.value = true;
    saveError.value = '';
    try {
      await bankRechargeApi.refundOrder(selected.value.id, {
        expectedUpdatedAt: selected.value.updatedAt,
        reason: refund.reason.trim(),
        refundReference: refund.refundReference.trim()
      });
      refundOpen.value = false;
      ElMessage.success('退款已登记，原财务日记已冲销');
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
    drawerOpen,
    quickCustomerOpen,
    cardOpen,
    currencyOpen,
    refundOpen,
    creating,
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
    customerCreated,
    save,
    complete,
    openRefund,
    confirmRefund,
    saveCurrency,
    saveCard
  };
}
