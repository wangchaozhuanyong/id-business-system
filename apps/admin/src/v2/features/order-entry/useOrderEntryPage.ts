import { computed, nextTick, onDeactivated, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { V2_DECIMAL_PLACES } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import { calculateOneMonthInclusiveDueAt } from '@/v2/utils/subscriptionPeriod';
import { idBusinessV2OrdersApi } from './api';
import {
  applyLatestOrderEntryFxRate,
  createConsumptionIdempotencyKey,
  createInitialOrderEntryForm,
  customerLabel,
  formatOrderEntryDecimal
} from './order-entry-form';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateProfitRate,
  calculateSuggestedOriginalAmount,
  calculateSuggestedReceivedAmount,
  calculateTotalCostAmount,
  isPositiveOrderAmount,
  validateTargetProfitRate
} from './order-pricing';
import {
  calculateReceivedAmountPreview,
  createOrderReceiptRules,
  resetReceiptCurrencyEvidence
} from './order-receipt';
import { useOrderCandidateSelection } from './useOrderCandidateSelection';
import type {
  ConsumeV2OrderResult,
  CreateV2OrderResult,
  V2OrderEntryCustomer,
  V2OrderEntryOptions
} from './contracts';

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
  const recommendationApplied = ref(false);
  const previousManualPrice = ref('');
  const appliedSuggestedCny = ref('');
  const entryOptions = ref<V2OrderEntryOptions>({
    customers: [],
    countries: [],
    settlementPlatforms: [],
    latestFxRates: []
  });
  const form = reactive(createInitialOrderEntryForm());
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
  const submitDisabledReason = computed(() => {
    if (hasPendingConsumption.value) return '已有订单等待完成余额扣减，请先重试扣减';
    if (missingOptionsConfiguration.value) return '请先配置可用的国家与业务资料';
    if (missingCustomersConfiguration.value) return '请先新增可用客户';
    return '';
  });
  const receivedAmountPreview = computed(() => calculateReceivedAmountPreview(form));
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
  const accountPurchaseCostPreview = computed(() => selectedCandidate.value?.purchaseCost ?? '0');
  const appliedAccountCostPreview = computed(() =>
    form.accountDisposition === 'sold' ? accountPurchaseCostPreview.value : '0'
  );
  const estimatedBalanceCostPreview = computed(
    () => selectedCandidate.value?.estimatedBalanceCostAmount ?? '0'
  );
  const totalCostPreview = computed(
    () =>
      calculateTotalCostAmount(
        platformFeePreview.value,
        appliedAccountCostPreview.value,
        estimatedBalanceCostPreview.value
      ) ?? '0'
  );
  const estimatedProfitPreview = computed(() => {
    return (
      calculateEstimatedProfitAmount(
        form.receivedAmount,
        platformFeePreview.value,
        appliedAccountCostPreview.value,
        estimatedBalanceCostPreview.value
      ) ?? '0'
    );
  });
  const estimatedProfitRatePreview = computed(() =>
    calculateProfitRate(estimatedProfitPreview.value, form.receivedAmount)
  );
  const suggestedReceived = computed(() => {
    if (!form.targetProfitRate.trim()) {
      return {
        amount: null,
        platformFee: null,
        estimatedProfit: null,
        estimatedProfitRate: null,
        error: ''
      };
    }
    const platform = selectedSettlementPlatform.value;
    if (
      form.receivedCurrency !== 'CNY' &&
      !form.receivedFxRateToCny &&
      !form.automaticFxRateToCny
    ) {
      return {
        amount: null,
        platformFee: null,
        estimatedProfit: null,
        estimatedProfitRate: null,
        error: '缺少可用汇率，无法把人民币推荐价换算为原币'
      };
    }
    return calculateSuggestedReceivedAmount({
      targetProfitRate: form.targetProfitRate,
      appliedAccountCostAmount: appliedAccountCostPreview.value,
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
    ...createOrderReceiptRules(form),
    settlementPlatformOptionId: [{ required: true, message: '请选择结算平台', trigger: 'change' }],
    targetProfitRate: [
      {
        validator: (_rule, value, callback) => {
          const normalized = String(value ?? '').trim();
          if (!normalized) {
            callback();
            return;
          }
          const error = validateTargetProfitRate(
            normalized,
            selectedSettlementPlatform.value?.percentageFee ?? '0'
          );
          callback(error ? new Error(error) : undefined);
        },
        trigger: 'blur'
      }
    ],
    balanceAmount: [
      {
        required: true,
        validator: (_rule, value, callback) => {
          callback(
            isPositiveOrderAmount(value)
              ? undefined
              : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的正数`)
          );
        },
        trigger: 'blur'
      }
    ],
    openedAt: [{ required: true, message: '请选择开通时间', trigger: 'change' }],
    dueAt: [
      {
        required: true,
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
    receivedAmountPreview,
    (amount) => {
      form.receivedAmount = amount;
    },
    { immediate: true }
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
      syncAutomaticFxRate();
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

  function handleReceivedCurrencyChange() {
    resetReceiptCurrencyEvidence(form);
    syncAutomaticFxRate();
  }

  function syncAutomaticFxRate() {
    applyLatestOrderEntryFxRate(form, entryOptions.value.latestFxRates);
  }

  function applySuggestedReceivedAmount() {
    if (!suggestedReceived.value.amount) return;
    if (!recommendationApplied.value) {
      previousManualPrice.value = form.receivedOriginalAmount;
    }
    const originalAmount = calculateSuggestedOriginalAmount(
      suggestedReceived.value.amount,
      form.receivedCurrency,
      form.receivedFxRateToCny || form.automaticFxRateToCny
    );
    if (!originalAmount) {
      ElMessage.warning('自动汇率尚未锁定，无法把人民币建议金额换算为原币');
      return;
    }
    form.receivedOriginalAmount = originalAmount;
    recommendationApplied.value = true;
    appliedSuggestedCny.value = suggestedReceived.value.amount;
    void nextTick(() => formRef.value?.clearValidate('receivedOriginalAmount'));
  }

  function undoSuggestedReceivedAmount() {
    if (!recommendationApplied.value) return;
    form.receivedOriginalAmount = previousManualPrice.value;
    recommendationApplied.value = false;
    appliedSuggestedCny.value = '';
    void nextTick(() => formRef.value?.clearValidate('receivedOriginalAmount'));
  }

  function handleManualPriceInput() {
    if (!recommendationApplied.value) return;
    recommendationApplied.value = false;
    appliedSuggestedCny.value = '';
  }

  async function submitOrder() {
    if (submitDisabledReason.value || !(await validateV2Form(formRef.value))) return;
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
        settlementPlatformOptionId: form.settlementPlatformOptionId,
        platformOrderNo: form.platformOrderNo.trim() || null,
        websiteAccount: form.websiteAccount.trim() || null,
        receivedAmount: form.receivedAmount.trim() || undefined,
        receivedOriginalAmount: form.receivedOriginalAmount.trim(),
        receivedCurrency: form.receivedCurrency,
        receivedFxRateToCny: form.receivedFxRateToCny.trim() || undefined,
        receivedFxSnapshotId:
          !form.receivedFxRateToCny && form.receivedFxSnapshotId
            ? form.receivedFxSnapshotId
            : undefined,
        receivedManualRateReason: form.receivedManualRateReason.trim() || undefined,
        accountDisposition: form.accountDisposition,
        balanceAmount: form.balanceAmount.trim(),
        openedAt: form.openedAt.toISOString(),
        dueAt: form.dueAt.toISOString(),
        lockScope: form.accountDisposition === 'sold' ? 'global' : 'by_service',
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
    Object.assign(form, createInitialOrderEntryForm());
    recommendationApplied.value = false;
    previousManualPrice.value = '';
    appliedSuggestedCny.value = '';
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

  function handleCustomerCreated(customer: V2OrderEntryCustomer) {
    entryOptions.value = {
      ...entryOptions.value,
      customers: [
        customer,
        ...entryOptions.value.customers.filter((item) => item.id !== customer.id)
      ]
    };
    form.customerId = customer.id;
    void nextTick(() => formRef.value?.clearValidate('customerId'));
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
    submitDisabledReason,
    hasPendingConsumption,
    platformFeePreview,
    receivedAmountPreview,
    accountPurchaseCostPreview,
    appliedAccountCostPreview,
    estimatedBalanceCostPreview,
    totalCostPreview,
    estimatedProfitPreview,
    estimatedProfitRatePreview,
    suggestedReceived,
    recommendationApplied,
    appliedSuggestedCny,
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
    handleReceivedCurrencyChange,
    handleIdSelectionModeChange,
    searchManualCandidates,
    loadCandidates,
    applySuggestedReceivedAmount,
    undoSuggestedReceivedAmount,
    handleManualPriceInput,
    submitOrder,
    retryConsumption,
    resetForm,
    handleCustomerCreated,
    customerLabel,
    formatDecimal: formatOrderEntryDecimal
  };
}
