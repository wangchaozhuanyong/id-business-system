import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { FormInstance } from 'element-plus';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { hasUserPermission } from '@/utils/permissions';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { validateV2Form } from '@/v2/utils/formValidation';
import { calculateOneMonthInclusiveDueAt } from '@/v2/utils/subscriptionPeriod';
import { idBusinessV2OrdersApi } from './api';
import {
  createConsumptionIdempotencyKey,
  createInitialOrderEntryForm,
  formatOrderEntryDecimal
} from './order-entry-form';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateProfitRate,
  calculateSuggestedReceivedAmount,
  calculateTotalCostAmount,
  isNonNegativeOrderAmount,
  isPositiveOrderAmount
} from './order-pricing';
import { createOrderEntryRules } from './order-entry-rules';
import { calculateReceivedAmountPreview } from './order-receipt';
import { useOrderCandidateSelection } from './useOrderCandidateSelection';
import {
  getVisibleOrderEntryCustomers,
  preserveSelectedOrderEntryCustomer,
  useOrderEntryOptionsQuery
} from './useOrderEntryOptionsQuery';
import { useOrderReceiptPricing } from './useOrderReceiptPricing';
import { useOrderPricingInputMode } from './useOrderPricingInputMode';
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
  const submitting = ref(false);
  const consuming = ref(false);
  const createdResult = ref<CreateV2OrderResult | null>(null);
  const consumptionResult = ref<ConsumeV2OrderResult | null>(null);
  const consumptionError = ref('');
  const consumptionIdempotencyKey = ref('');
  const entryOptions = ref<V2OrderEntryOptions>({
    customers: [],
    countries: [],
    settlementPlatforms: [],
    latestFxRates: []
  });
  const hasConfiguredCustomers = ref(false);
  const form = reactive(createInitialOrderEntryForm());
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
  const missingCustomersConfiguration = computed(() => !hasConfiguredCustomers.value);
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
  const profitRatePreviewUnavailableReason = computed(() => {
    if (!form.receivedOriginalAmount.trim()) {
      return '填写原币实收后，将按当前成本自动反算';
    }
    if (!isPositiveOrderAmount(form.receivedAmount)) {
      if (
        form.receivedCurrency !== 'CNY' &&
        !form.receivedFxRateToCny &&
        !form.automaticFxRateToCny
      ) {
        return `等待有效的 ${form.receivedCurrency}/CNY 汇率后自动反算`;
      }
      return '原币实收必须大于 0 才能反算利润率';
    }
    if (!selectedSettlementPlatform.value) {
      return '请选择结算平台后自动反算';
    }
    if (
      !selectedCandidate.value ||
      !isNonNegativeOrderAmount(selectedCandidate.value.estimatedBalanceCostAmount)
    ) {
      return '请选择可用 ID 并确认成本后自动反算';
    }
    if (
      form.accountDisposition === 'sold' &&
      !isNonNegativeOrderAmount(selectedCandidate.value.purchaseCost)
    ) {
      return '当前 ID 购买成本无效，暂时不能反算利润率';
    }
    return '';
  });
  const estimatedProfitRatePreview = computed(() =>
    profitRatePreviewUnavailableReason.value
      ? null
      : calculateProfitRate(estimatedProfitPreview.value, form.receivedAmount)
  );
  const {
    pricingInputMode,
    profitRateInputValue,
    profitRateInputHint,
    useReceiptDrivenProfitRate,
    resetPricingInputMode
  } = useOrderPricingInputMode({
    getTargetProfitRate: () => form.targetProfitRate,
    setTargetProfitRate: (value) => {
      form.targetProfitRate = value;
    },
    getReversedProfitRate: () => estimatedProfitRatePreview.value,
    getReversedProfitRateUnavailableReason: () => profitRatePreviewUnavailableReason.value
  });
  const suggestedReceived = computed(() => {
    if (!form.targetProfitRate.trim()) {
      return {
        amount: null,
        exactAmount: null,
        platformFee: null,
        estimatedProfit: null,
        estimatedProfitRate: null,
        error: ''
      };
    }
    const platform = selectedSettlementPlatform.value;
    return calculateSuggestedReceivedAmount({
      targetProfitRate: form.targetProfitRate,
      appliedAccountCostAmount: appliedAccountCostPreview.value,
      estimatedBalanceCostAmount: selectedCandidate.value?.estimatedBalanceCostAmount ?? null,
      fixedFee: platform?.fixedFee ?? '0',
      percentageFee: platform?.percentageFee ?? '0'
    });
  });
  const {
    suggestedReceipt,
    recommendationApplied,
    appliedSuggestedOriginal,
    receiptFxQuote,
    receiptFxLoading,
    receiptFxError,
    handleReceivedCurrencyChange: resetReceiptPricingForCurrencyChange,
    handleManualFxRateInput,
    loadReceiptFxQuote,
    ensureReceiptFxReadyForSubmit,
    applySuggestedReceivedAmount,
    undoSuggestedReceivedAmount,
    handleManualPriceInput: resetRecommendedPriceOnManualInput,
    resetOrderReceiptPricing
  } = useOrderReceiptPricing({
    form,
    formRef,
    getSuggestedReceived: () => suggestedReceived.value,
    getSettlementPlatform: () => selectedSettlementPlatform.value,
    getAppliedAccountCost: () => appliedAccountCostPreview.value,
    getEstimatedBalanceCost: () => estimatedBalanceCostPreview.value
  });
  const emptyConfigurationMessage = computed(() => {
    const missing: string[] = [];
    if (missingOptionsConfiguration.value) missing.push('国家与业务');
    if (missingCustomersConfiguration.value) missing.push('客户');
    return `暂无可用${missing.join('、')}资料`;
  });

  const rules = createOrderEntryRules(
    form,
    () => selectedSettlementPlatform.value?.percentageFee ?? '0'
  );

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

  const {
    data: entryOptionsData,
    loading: optionsLoading,
    error: optionsError,
    resolved: optionsResolved,
    customerOptionsPending,
    customerKeyword,
    searchCustomers,
    retryOptions: retryEntryOptions
  } = useOrderEntryOptionsQuery({
    mode: 'module',
    moduleKey: 'order-entry'
  });
  watch(
    entryOptionsData,
    (result) => {
      if (!result) return;
      if (!customerKeyword.value) {
        hasConfiguredCustomers.value = result.customers.length > 0;
      }
      const selectedCustomer = entryOptions.value.customers.find(
        (customer) => customer.id === form.customerId
      );
      entryOptions.value = preserveSelectedOrderEntryCustomer(result, selectedCustomer);
    },
    { immediate: true }
  );
  const customerOptions = computed(() => {
    return getVisibleOrderEntryCustomers(
      entryOptions.value.customers,
      form.customerId,
      customerOptionsPending.value
    );
  });
  const customerSearching = computed(() => customerOptionsPending.value && optionsLoading.value);

  function handleOpenedAtChange(openedAt: Date | null) {
    if (openedAt) {
      form.dueAt = calculateOneMonthInclusiveDueAt(openedAt);
    }
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
    resetPricingInputMode();
    resetReceiptPricingForCurrencyChange();
    void nextTick(() => formRef.value?.clearValidate('targetProfitRate'));
  }

  function handleManualPriceInput() {
    useReceiptDrivenProfitRate();
    void nextTick(() => formRef.value?.clearValidate('targetProfitRate'));
    resetRecommendedPriceOnManualInput();
  }

  async function submitOrder() {
    if (
      submitDisabledReason.value ||
      !(await ensureReceiptFxReadyForSubmit()) ||
      !(await validateV2Form(formRef.value))
    ) {
      return;
    }
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
        const message = getApiErrorMessage(error);
        if (
          !form.receivedFxRateToCny &&
          (message.includes('汇率快照已过期') || message.includes('汇率快照不存在'))
        ) {
          await loadReceiptFxQuote();
          ElMessage.warning('自动汇率已更新，请核对原币实收和预计利润后重新提交');
        } else {
          ElMessage.error(message);
        }
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
    resetPricingInputMode();
    resetOrderReceiptPricing();
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
    hasConfiguredCustomers.value = true;
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

  return {
    router,
    formRef,
    optionsLoading,
    optionsError,
    optionsResolved,
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
    customerOptions,
    customerKeyword,
    customerSearching,
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
    pricingInputMode,
    profitRateInputValue,
    profitRateInputHint,
    suggestedReceipt,
    recommendationApplied,
    appliedSuggestedOriginal,
    receiptFxQuote,
    receiptFxLoading,
    receiptFxError,
    matchingEmptyMessage,
    emptyConfigurationMessage,
    rules,
    handleOpenedAtChange,
    retryEntryOptions,
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
    handleManualFxRateInput,
    loadReceiptFxQuote,
    submitOrder,
    retryConsumption,
    resetForm,
    handleCustomerCreated,
    formatDecimal: formatOrderEntryDecimal
  };
}
