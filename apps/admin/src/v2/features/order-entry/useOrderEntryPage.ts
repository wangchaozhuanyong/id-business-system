import { computed, nextTick, onDeactivated, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { calculateOneMonthInclusiveDueAt } from '@/v2/utils/subscriptionPeriod';
import { idBusinessV2OrdersApi } from './api';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateSuggestedReceivedAmount,
  isNonNegativeOrderAmount,
  isPositiveOrderAmount
} from './order-pricing';
import { useOrderCandidateSelection } from './useOrderCandidateSelection';
import type {
  ConsumeV2OrderResult,
  CreateV2OrderResult,
  V2OrderEntryCustomer,
  V2OrderEntryOptions
} from './contracts';

function createIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `order-${crypto.randomUUID()}`;
  }
  return `order-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function createConsumptionIdempotencyKey() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `consume-${crypto.randomUUID()}`;
  }
  return `consume-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function createInitialForm() {
  const now = new Date();
  now.setSeconds(0, 0);
  return {
    countryId: '',
    categoryId: '',
    serviceOptionId: '',
    customerId: '',
    accountId: '',
    settlementPlatformOptionId: '',
    platformOrderNo: '',
    websiteAccount: '',
    receivedAmount: '',
    targetProfit: '',
    balanceAmount: '',
    openedAt: now,
    dueAt: calculateOneMonthInclusiveDueAt(now),
    remark: '',
    idempotencyKey: createIdempotencyKey()
  };
}

export function useOrderEntryPage() {
  const router = useRouter();
  const authStore = useAuthStore();
  const formRef = ref<FormInstance>();
  const customerSearchKeyword = ref('');
  const customerSearching = ref(false);
  const submitting = ref(false);
  const consuming = ref(false);
  const createdResult = ref<CreateV2OrderResult | null>(null);
  const consumptionResult = ref<ConsumeV2OrderResult | null>(null);
  const consumptionError = ref('');
  const consumptionIdempotencyKey = ref('');
  const entryOptions = ref<V2OrderEntryOptions>({
    customers: [],
    countries: [],
    settlementPlatforms: []
  });
  const form = reactive(createInitialForm());
  let customerSearchTimer: ReturnType<typeof setTimeout> | undefined;
  const {
    idSelectionMode,
    matchingLoading,
    matchingError,
    matchingResult,
    candidateItems,
    selectedCandidate,
    canMatch,
    matchingEmptyMessage,
    handleIdSelectionModeChange,
    searchManualCandidates,
    scheduleCandidateMatch,
    loadCandidates,
    clearCandidates,
    resetCandidateSelection
  } = useOrderCandidateSelection(form);

  const selectedCountry = computed(
    () => entryOptions.value.countries.find((country) => country.id === form.countryId) ?? null
  );
  const availableCategories = computed(() => selectedCountry.value?.children ?? []);
  const selectedCategory = computed(
    () => availableCategories.value.find((category) => category.id === form.categoryId) ?? null
  );
  const availableServices = computed(() => selectedCategory.value?.children ?? []);
  const selectedService = computed(
    () => availableServices.value.find((service) => service.id === form.serviceOptionId) ?? null
  );
  const selectedSettlementPlatform = computed(
    () =>
      entryOptions.value.settlementPlatforms.find(
        (platform) => platform.id === form.settlementPlatformOptionId
      ) ?? null
  );
  const missingOptionsConfiguration = computed(() => !entryOptions.value.countries.length);
  const missingCustomersConfiguration = computed(() => !entryOptions.value.customers.length);
  const canManageOptions = computed(() =>
    hasUserPermission(authStore.user, 'data.dictionary.manage')
  );
  const canViewCustomers = computed(() => hasUserPermission(authStore.user, 'customer.view'));
  const canCreateCustomer = computed(() => hasUserPermission(authStore.user, 'customer.create'));
  const hasPendingConsumption = computed(() =>
    Boolean(createdResult.value && !consumptionResult.value)
  );
  const canSubmit = computed(
    () =>
      Boolean(
        form.countryId &&
        form.categoryId &&
        form.serviceOptionId &&
        form.customerId &&
        form.accountId &&
        form.openedAt &&
        form.dueAt
      ) &&
      isNonNegativeOrderAmount(form.receivedAmount) &&
      isPositiveOrderAmount(form.balanceAmount) &&
      !submitting.value &&
      !consuming.value &&
      !hasPendingConsumption.value
  );
  const platformFeePreview = computed(() => {
    const platform = selectedSettlementPlatform.value;
    return (
      calculatePlatformFeeAmount(
        form.receivedAmount,
        platform?.fixedFee ?? '0',
        platform?.percentageFee ?? '0'
      ) ?? '0'
    );
  });
  const estimatedProfitPreview = computed(() => {
    return (
      calculateEstimatedProfitAmount(
        form.receivedAmount,
        platformFeePreview.value,
        selectedCandidate.value?.estimatedBalanceCostAmount ?? '0'
      ) ?? '0'
    );
  });
  const suggestedReceived = computed(() => {
    if (!form.targetProfit.trim()) {
      return {
        amount: null,
        platformFee: null,
        estimatedProfit: null,
        error: ''
      };
    }
    const platform = selectedSettlementPlatform.value;
    return calculateSuggestedReceivedAmount({
      targetProfit: form.targetProfit,
      estimatedBalanceCostAmount: selectedCandidate.value?.estimatedBalanceCostAmount ?? null,
      fixedFee: platform?.fixedFee ?? '0',
      percentageFee: platform?.percentageFee ?? '0'
    });
  });
  const emptyConfigurationMessage = computed(() => {
    const missing: string[] = [];
    if (missingOptionsConfiguration.value) missing.push('国家与业务');
    if (missingCustomersConfiguration.value) missing.push('客户');
    return `暂无可用${missing.join('、')}资料`;
  });

  const rules: FormRules = {
    countryId: [{ required: true, message: '请选择国家', trigger: 'change' }],
    categoryId: [{ required: true, message: '请选择业务分类', trigger: 'change' }],
    serviceOptionId: [{ required: true, message: '请选择业务', trigger: 'change' }],
    customerId: [{ required: true, message: '请选择客户', trigger: 'change' }],
    accountId: [{ required: true, message: '请选择可用 ID', trigger: 'change' }],
    receivedAmount: [
      {
        validator: (_rule, value, callback) => {
          callback(
            isNonNegativeOrderAmount(value) ? undefined : new Error('请输入最多 4 位小数的非负金额')
          );
        },
        trigger: 'blur'
      }
    ],
    targetProfit: [
      {
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          callback(
            !normalized || isNonNegativeOrderAmount(normalized)
              ? undefined
              : new Error('请输入最多 4 位小数的非负金额')
          );
        },
        trigger: 'blur'
      }
    ],
    balanceAmount: [
      {
        validator: (_rule, value, callback) => {
          callback(
            isPositiveOrderAmount(value) ? undefined : new Error('请输入最多 4 位小数的正数')
          );
        },
        trigger: 'blur'
      }
    ],
    openedAt: [{ required: true, message: '请选择开通时间', trigger: 'change' }],
    dueAt: [
      {
        validator: (_rule, value, callback) => {
          if (!(value instanceof Date)) {
            callback(new Error('请选择到期时间'));
            return;
          }
          if (!(form.openedAt instanceof Date) || value.getTime() <= form.openedAt.getTime()) {
            callback(new Error('到期时间必须晚于开通时间'));
            return;
          }
          if (value.getTime() <= Date.now()) {
            callback(new Error('到期时间必须晚于当前时间'));
            return;
          }
          callback();
        },
        trigger: 'change'
      }
    ],
    platformOrderNo: [
      {
        validator: (_rule, value, callback) => {
          callback(
            value && !form.settlementPlatformOptionId
              ? new Error('填写平台订单号时必须选择结算平台')
              : undefined
          );
        },
        trigger: 'blur'
      }
    ]
  };

  watch(
    () => form.serviceOptionId,
    () => {
      const amount = selectedService.value?.businessAmount ?? '';
      form.balanceAmount = isPositiveOrderAmount(amount) ? amount : '';
    }
  );

  watch(
    () => [form.serviceOptionId, form.balanceAmount],
    () => scheduleCandidateMatch()
  );

  const optionsQuery = useV2ModuleQuery<V2OrderEntryOptions>({
    moduleKey: 'order-entry',
    scope: 'order-entry-options',
    key: () => createV2QueryKey({ customerKeyword: customerSearchKeyword.value.trim() }),
    keepPreviousData: true,
    query: ({ signal }) =>
      idBusinessV2OrdersApi.getEntryOptions(customerSearchKeyword.value.trim() || undefined, {
        signal
      })
  });
  watch(
    optionsQuery.data,
    (result) => {
      if (!result) return;
      const selectedCustomer = entryOptions.value.customers.find(
        (customer) => customer.id === form.customerId
      );
      entryOptions.value = {
        ...result,
        customers:
          selectedCustomer &&
          !result.customers.some((customer) => customer.id === selectedCustomer.id)
            ? [selectedCustomer, ...result.customers]
            : result.customers
      };
    },
    { immediate: true }
  );
  const optionsLoading = computed(() => optionsQuery.isInitialLoading.value);
  const optionsError = computed(() =>
    optionsQuery.error.value ? getApiErrorMessage(optionsQuery.error.value) : ''
  );
  const optionsResolved = optionsQuery.hasData;
  const { isInitialLoading } = optionsQuery;

  function handleOpenedAtChange(openedAt: Date | null) {
    if (openedAt) {
      form.dueAt = calculateOneMonthInclusiveDueAt(openedAt);
    }
  }

  async function loadEntryOptions(customerKeyword = '') {
    const normalizedKeyword = customerKeyword.trim();
    const changed = normalizedKeyword !== customerSearchKeyword.value;
    customerSearchKeyword.value = normalizedKeyword;
    try {
      await (changed ? optionsQuery.ensureFresh() : optionsQuery.refresh());
    } finally {
      if (customerSearchKeyword.value === normalizedKeyword) {
        customerSearching.value = false;
      }
    }
  }

  function searchCustomers(keyword: string) {
    if (customerSearchTimer) clearTimeout(customerSearchTimer);
    customerSearching.value = true;
    customerSearchTimer = setTimeout(() => void loadEntryOptions(keyword.trim()), 300);
  }

  function handleCountryChange() {
    form.categoryId = '';
    form.serviceOptionId = '';
    clearCandidates();
  }

  function handleCategoryChange() {
    form.serviceOptionId = '';
    clearCandidates();
  }

  function handleSettlementPlatformChange() {
    if (!form.settlementPlatformOptionId) {
      form.platformOrderNo = '';
    }
  }

  function applySuggestedReceivedAmount() {
    if (!suggestedReceived.value.amount) return;
    form.receivedAmount = suggestedReceived.value.amount;
    void nextTick(() => formRef.value?.clearValidate('receivedAmount'));
  }

  async function submitOrder() {
    if (!formRef.value || !(await formRef.value.validate().catch(() => false))) return;
    if (!form.openedAt || !form.dueAt) return;
    submitting.value = true;
    createdResult.value = null;
    consumptionError.value = '';
    consumptionResult.value = null;
    consumptionIdempotencyKey.value = '';
    try {
      const result = await idBusinessV2OrdersApi.create({
        customerId: form.customerId,
        serviceOptionId: form.serviceOptionId,
        accountId: form.accountId,
        settlementPlatformOptionId: form.settlementPlatformOptionId || null,
        platformOrderNo: form.platformOrderNo.trim() || null,
        websiteAccount: form.websiteAccount.trim() || null,
        receivedAmount: form.receivedAmount.trim(),
        balanceAmount: form.balanceAmount.trim(),
        openedAt: form.openedAt.toISOString(),
        dueAt: form.dueAt.toISOString(),
        lockScope: 'by_service',
        idempotencyKey: form.idempotencyKey,
        remark: form.remark.trim() || null
      });
      createdResult.value = result;
      consumptionIdempotencyKey.value = createConsumptionIdempotencyKey();
      await consumeCreatedOrder();
    } catch (error) {
      if (!createdResult.value) {
        ElMessage.error(getApiErrorMessage(error));
      }
    } finally {
      submitting.value = false;
      if (consumptionResult.value) {
        await nextTick();
        formRef.value?.clearValidate();
      }
    }
  }

  async function consumeCreatedOrder() {
    const createResult = createdResult.value;
    const order = createResult?.order;
    if (!createResult || !order || !consumptionIdempotencyKey.value) return;
    consuming.value = true;
    consumptionError.value = '';
    try {
      const result = await idBusinessV2OrdersApi.consumeBalance(order.id, {
        idempotencyKey: consumptionIdempotencyKey.value
      });
      consumptionResult.value = result;
      createdResult.value = {
        ...createResult,
        order: result.order
      };
      ElMessage.success(
        result.idempotentReplay
          ? '余额扣减请求已处理，已恢复原流水结果'
          : '余额已真实扣减，成本和利润已写入'
      );
      resetForm({ preserveResult: true });
    } catch (error) {
      consumptionError.value = getApiErrorMessage(error);
      ElMessage.error(`订单已创建，但余额扣减失败：${consumptionError.value}`);
    } finally {
      consuming.value = false;
    }
  }

  function retryConsumption() {
    void consumeCreatedOrder();
  }

  function resetForm(options: { preserveResult?: boolean } = {}) {
    Object.assign(form, createInitialForm());
    resetCandidateSelection();
    formRef.value?.clearValidate();
    if (!options.preserveResult) {
      createdResult.value = null;
      consumptionResult.value = null;
      consumptionError.value = '';
      consumptionIdempotencyKey.value = '';
    }
    void nextTick(() => formRef.value?.clearValidate());
  }

  function customerLabel(customer: V2OrderEntryCustomer) {
    const detail = customer.wechat || customer.maskedPhone;
    return detail ? `${customer.name} / ${detail}` : customer.name;
  }

  function formatDecimal(value: string) {
    const normalized = String(value).trim();
    const match = normalized.match(/^(-?)(\d+)(?:\.(\d+))?$/);
    if (!match) return value;
    const [, sign, integer, fractional = ''] = match;
    const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${sign}${grouped}${fractional ? `.${fractional.slice(0, 4)}` : ''}`;
  }

  function stopDeferredTasks() {
    if (customerSearchTimer) {
      clearTimeout(customerSearchTimer);
      customerSearchTimer = undefined;
    }
    customerSearching.value = false;
  }

  onDeactivated(stopDeferredTasks);

  return {
    router,
    formRef,
    optionsLoading,
    optionsError,
    optionsResolved,
    customerSearching,
    idSelectionMode,
    matchingLoading,
    matchingError,
    matchingResult,
    submitting,
    consuming,
    createdResult,
    consumptionResult,
    consumptionError,
    entryOptions,
    form,
    selectedCountry,
    availableCategories,
    availableServices,
    selectedService,
    selectedSettlementPlatform,
    candidateItems,
    selectedCandidate,
    missingOptionsConfiguration,
    missingCustomersConfiguration,
    canManageOptions,
    canViewCustomers,
    canCreateCustomer,
    canMatch,
    canSubmit,
    hasPendingConsumption,
    platformFeePreview,
    estimatedProfitPreview,
    suggestedReceived,
    matchingEmptyMessage,
    emptyConfigurationMessage,
    rules,
    isInitialLoading,
    handleOpenedAtChange,
    loadEntryOptions,
    searchCustomers,
    handleCountryChange,
    handleCategoryChange,
    handleSettlementPlatformChange,
    handleIdSelectionModeChange,
    searchManualCandidates,
    loadCandidates,
    applySuggestedReceivedAmount,
    submitOrder,
    retryConsumption,
    resetForm,
    customerLabel,
    formatDecimal
  };
}
