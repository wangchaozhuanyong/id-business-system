<template>
  <V2FormDrawer
    :model-value="modelValue"
    :title="order ? `修改订单 ${order.orderNo}` : '修改订单'"
    eyebrow="订单维护"
    description="按业务对象、价格结算和履约时间分区核对修改"
    confirm-text="保存修改"
    :dirty="formDirty"
    :confirm-loading="saving"
    :confirm-disabled-reason="submitDisabledReason"
    size="min(720px, 96vw)"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <V2AsyncRegion
      variant="section"
      skeleton="form"
      :loading="optionsLoading"
      :resolved="optionsResolved"
      :error="optionsError"
      loading-title="正在加载订单选项"
      refreshing-title="正在更新订单选项"
      error-title="订单选项加载失败"
      @retry="retryOptions"
    >
      <el-form
        ref="formRef"
        class="v2-horizontal-form"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="96px"
        require-asterisk-position="right"
        status-icon
        scroll-to-error
        :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
        autocomplete="off"
      >
        <el-alert
          v-if="order && !order.operations.canEditCore"
          type="info"
          title="订单已有扣款或开通证据，客户、业务、使用 ID、ID 处理方式和消耗余额已锁定"
          :closable="false"
          show-icon
        />
        <el-alert
          v-if="order && !order.operations.canEditPricing"
          type="warning"
          title="订单已完成，实收价格和结算平台已锁定；如需修正请先冲销或退款后重新建单"
          :closable="false"
          show-icon
        />

        <V2PanelSection heading-id="order-edit-core" title="业务对象" step="01">
          <div class="v2-order-edit-grid">
            <V2OrderEditCoreFields
              :form="form"
              :order="order"
              :customers="visibleCustomerChoices"
              :customer-keyword="customerKeyword"
              :customer-searching="customerOptionsPending && optionsLoading"
              :services="serviceChoices"
              :accounts="accountChoices"
              :matching-loading="matchingLoading"
              :matching-error="matchingError"
              @search-customers="searchCustomers"
              @search-candidates="searchCandidates"
            />
          </div>
        </V2PanelSection>

        <V2PanelSection heading-id="order-edit-pricing" title="价格与结算" step="02">
          <div class="v2-order-edit-grid">
            <V2OrderEditPricingFields
              v-if="order"
              v-model:profit-rate-input-value="profitRatePricing.profitRateInputValue"
              :form="form"
              :order="order"
              :settlement-choices="settlementChoices"
              :received-amount-preview="receivedAmountPreview"
              :platform-fee-preview="platformFeePreview"
              :suggested-received="suggestedReceived"
              :suggested-original-amount="suggestedOriginalAmount"
              :recommendation-applied="recommendationApplied"
              :applied-suggested-cny="appliedSuggestedCny"
              :estimated-profit-preview="estimatedProfitPreview"
              :estimated-profit-rate-preview="profitRatePricing.estimatedProfitRatePreview"
              :pricing-input-mode="profitRatePricing.pricingInputMode"
              :profit-rate-input-hint="profitRatePricing.profitRateInputHint"
              @settlement-change="handleSettlementChange"
              @manual-price-input="handleManualPriceInput"
              @apply-suggested="applySuggestedReceivedAmount"
              @undo-suggested="undoSuggestedReceivedAmount"
            />
          </div>
        </V2PanelSection>

        <V2OrderEditSupplementFields :form="form" :order="order" />
      </el-form>
    </V2AsyncRegion>
  </V2FormDrawer>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { FormInstance } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2OrdersApi } from '../api';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import V2OrderEditCoreFields from './V2OrderEditCoreFields.vue';
import V2OrderEditPricingFields from './V2OrderEditPricingFields.vue';
import V2OrderEditSupplementFields from './V2OrderEditSupplementFields.vue';
import {
  calculateEstimatedProfitAmount,
  calculatePlatformFeeAmount,
  calculateSuggestedOriginalAmount,
  calculateSuggestedReceivedAmount
} from '@/v2/features/order-entry/order-pricing';
import {
  getVisibleOrderEntryCustomers,
  preserveSelectedOrderEntryCustomer,
  useOrderEntryOptionsQuery
} from '@/v2/features/order-entry/useOrderEntryOptionsQuery';
import { multiplyDecimalStrings } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import type {
  UpdateV2OrderInput,
  V2Order,
  V2OrderCandidate,
  V2OrderEntryOptions
} from '../contracts';
import {
  createEmptyOrderEditForm,
  createOrderEditRules,
  isNonNegativeDecimal,
  isPositiveDecimal
} from './order-edit-form';
import { useOrderEditChoices } from './useOrderEditChoices';
import { useOrderEditProfitRateInput } from './useOrderEditProfitRateInput';
import './order-edit-drawer.css';

const props = defineProps<{
  modelValue: boolean;
  order: V2Order | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [payload: UpdateV2OrderInput];
}>();

const formRef = ref<FormInstance>();
const matchingLoading = ref(false);
const matchingError = ref('');
const candidates = ref<V2OrderCandidate[]>([]);
const recommendationApplied = ref(false);
const previousManualPrice = ref('');
const appliedSuggestedCny = ref('');
const options = ref<V2OrderEntryOptions>({
  customers: [],
  countries: [],
  settlementPlatforms: [],
  latestFxRates: []
});
const form = reactive(createEmptyOrderEditForm());
const { dirty: formDirty, capture: captureFormSnapshot } = useV2FormSnapshot(
  () => props.modelValue,
  () => form
);
let matchingTimer: ReturnType<typeof setTimeout> | undefined;
let matchingSequence = 0;
let initializing = false;

const {
  data: optionsQueryData,
  loading: optionsLoading,
  error: optionsError,
  resolved: optionsResolved,
  customerOptionsPending,
  customerKeyword,
  loadOptions,
  searchCustomers,
  retryOptions,
  cancel: cancelOptionsQuery
} = useOrderEntryOptionsQuery({
  mode: 'manual',
  freshnessPolicy: 'event-driven'
});

const { customerChoices, serviceChoices, settlementChoices, accountChoices } = useOrderEditChoices(
  options,
  candidates,
  () => props.order
);
const visibleCustomerChoices = computed(() =>
  getVisibleOrderEntryCustomers(
    customerChoices.value,
    form.customerId,
    customerOptionsPending.value
  )
);
watch(
  optionsQueryData,
  (result) => {
    if (!result) return;
    const selectedCustomer = customerChoices.value.find(
      (customer) => customer.id === form.customerId
    );
    options.value = preserveSelectedOrderEntryCustomer(result, selectedCustomer);
  },
  { immediate: true }
);

const selectedPlatform = computed(
  () => settlementChoices.value.find((item) => item.id === form.settlementPlatformOptionId) ?? null
);
const selectedCandidate = computed(
  () => candidates.value.find((item) => item.id === form.accountId) ?? null
);
const receivedAmountPreview = computed(() => {
  if (!isNonNegativeDecimal(form.receivedOriginalAmount)) return '0';
  if (!props.order || props.order.receivedCurrency === 'CNY') {
    return form.receivedOriginalAmount;
  }
  return multiplyDecimalStrings(form.receivedOriginalAmount, props.order.receivedFxRateToCny);
});

const platformFeePreview = computed(() => {
  const platform = selectedPlatform.value;
  if (!platform) return '0';
  return (
    calculatePlatformFeeAmount(
      receivedAmountPreview.value,
      platform.fixedFee,
      platform.percentageFee
    ) ?? '0'
  );
});
const appliedAccountCostPreview = computed(() =>
  form.accountSource === 'inventory' && form.accountDisposition === 'sold'
    ? (selectedCandidate.value?.purchaseCost ?? props.order?.accountCostAmount ?? '0')
    : '0'
);
const estimatedBalanceCostPreview = computed(
  () => selectedCandidate.value?.estimatedBalanceCostAmount ?? props.order?.balanceCostAmount ?? '0'
);
const estimatedProfitPreview = computed(
  () =>
    calculateEstimatedProfitAmount(
      receivedAmountPreview.value,
      platformFeePreview.value,
      appliedAccountCostPreview.value,
      estimatedBalanceCostPreview.value
    ) ?? '0'
);
const profitRatePricing = reactive(
  useOrderEditProfitRateInput({
    form,
    getOrder: () => props.order,
    selectedPlatform,
    selectedCandidate,
    optionsLoading,
    matchingLoading,
    receivedAmountPreview,
    estimatedProfitPreview,
    estimatedBalanceCostPreview,
    appliedAccountCostPreview
  })
);
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
  return calculateSuggestedReceivedAmount({
    targetProfitRate: form.targetProfitRate,
    appliedAccountCostAmount: appliedAccountCostPreview.value,
    estimatedBalanceCostAmount: estimatedBalanceCostPreview.value,
    fixedFee: selectedPlatform.value?.fixedFee ?? '0',
    percentageFee: selectedPlatform.value?.percentageFee ?? '0'
  });
});
const suggestedOriginalAmount = computed(() => {
  if (!suggestedReceived.value.amount || !props.order) return null;
  return calculateSuggestedOriginalAmount(
    suggestedReceived.value.exactAmount ?? suggestedReceived.value.amount,
    props.order.receivedCurrency,
    props.order.receivedFxRateToCny
  );
});

const submitDisabledReason = computed(() => {
  if (!props.order) return '未选择可编辑订单';
  if (optionsLoading.value) return '正在加载订单选项';
  if (optionsError.value) return '订单选项加载失败，请先重试';
  return '';
});

const rules = createOrderEditRules(
  form,
  () => Boolean(props.order?.operations.canEditCore),
  () => Boolean(props.order?.operations.canEditPricing),
  () => selectedPlatform.value?.percentageFee ?? '0'
);

watch(
  () => [props.modelValue, props.order?.id] as const,
  ([visible]) => {
    if (visible && props.order) {
      initialize(props.order);
    } else if (!visible) {
      cancelOptionsQuery();
    }
  }
);

watch(
  () => [form.serviceOptionId, form.balanceAmount, form.accountSource, form.customerId],
  () => {
    if (!initializing && props.order?.operations.canEditCore) {
      scheduleCandidates();
    }
  }
);

watch(
  () => form.accountSource,
  () => {
    if (initializing) return;
    form.accountDisposition = 'retained';
    form.lockScope = 'by_service';
    form.accountId = '';
    candidates.value = [];
    scheduleCandidates();
  }
);

watch(
  () => form.customerId,
  () => {
    if (initializing || form.accountSource !== 'customer_owned') return;
    form.accountId = '';
    candidates.value = [];
  }
);

watch(
  () => form.accountDisposition,
  (disposition) => {
    if (disposition === 'sold') form.lockScope = 'global';
  }
);

async function initialize(order: V2Order) {
  initializing = true;
  Object.assign(form, {
    customerId: order.customer.id,
    serviceOptionId: order.service.id,
    accountId: order.account?.id ?? '',
    accountSource: order.accountSource,
    accountDisposition: order.accountDisposition === 'sold' ? 'sold' : 'retained',
    settlementPlatformOptionId: order.settlementPlatform?.id ?? '',
    platformOrderNo: order.platformOrderNo ?? '',
    websiteAccount: '',
    clearWebsiteAccount: false,
    receivedOriginalAmount: order.receivedOriginalAmount,
    targetProfitRate: '',
    balanceAmount: order.balanceAmount,
    openedAt: order.openedAt ? toV2DateTimeInput(order.openedAt) : null,
    dueAt: order.dueAt ? toV2DateTimeInput(order.dueAt) : null,
    lockScope: order.activeLock?.lockScope ?? 'by_service',
    remark: order.remark ?? ''
  });
  profitRatePricing.resetPricingInputMode();
  candidates.value = [];
  matchingError.value = '';
  recommendationApplied.value = false;
  previousManualPrice.value = '';
  appliedSuggestedCny.value = '';
  await loadOptions('');
  if (!props.modelValue || props.order?.id !== order.id) {
    initializing = false;
    return;
  }
  if (order.operations.canEditCore) await loadCandidates();
  captureFormSnapshot();
  initializing = false;
}

function scheduleCandidates() {
  if (matchingTimer) clearTimeout(matchingTimer);
  if (!form.serviceOptionId || !isPositiveDecimal(form.balanceAmount)) {
    candidates.value = [];
    return;
  }
  matchingTimer = setTimeout(() => void loadCandidates(), 350);
}

async function loadCandidates(keyword = '') {
  const sequence = ++matchingSequence;
  matchingLoading.value = true;
  matchingError.value = '';
  try {
    const result =
      form.accountSource === 'customer_owned'
        ? await idBusinessV2OrdersApi.searchManualCandidates({
            serviceOptionId: form.serviceOptionId,
            balanceAmount: form.balanceAmount.trim(),
            accountSource: form.accountSource,
            customerId: form.customerId,
            keyword: keyword.trim() || undefined,
            limit: 50
          })
        : await idBusinessV2OrdersApi.findMatchingCandidates({
            serviceOptionId: form.serviceOptionId,
            balanceAmount: form.balanceAmount.trim(),
            accountSource: form.accountSource,
            customerId: form.customerId || undefined,
            orderId: props.order?.id,
            limit: 50
          });
    if (sequence !== matchingSequence) return;
    candidates.value = result.items;
    const coreChanged =
      form.serviceOptionId !== props.order?.service.id ||
      form.balanceAmount !== props.order?.balanceAmount;
    const selectedAccountStillAvailable = result.items.some((item) => item.id === form.accountId);
    if (coreChanged || !selectedAccountStillAvailable) {
      form.accountId = result.selectedCandidateId ?? '';
    }
  } catch (error) {
    if (sequence !== matchingSequence) return;
    candidates.value = [];
    matchingError.value = getApiErrorMessage(error);
  } finally {
    if (sequence === matchingSequence) matchingLoading.value = false;
  }
}

function searchCandidates(keyword: string) {
  if (form.accountSource !== 'customer_owned') return;
  if (matchingTimer) clearTimeout(matchingTimer);
  matchingTimer = setTimeout(() => void loadCandidates(keyword), 300);
}

function handleSettlementChange() {
  if (!form.settlementPlatformOptionId) {
    form.platformOrderNo = '';
  }
}

function applySuggestedReceivedAmount() {
  if (!suggestedReceived.value.amount || !suggestedOriginalAmount.value) return;
  if (!recommendationApplied.value) previousManualPrice.value = form.receivedOriginalAmount;
  form.receivedOriginalAmount = suggestedOriginalAmount.value;
  recommendationApplied.value = true;
  appliedSuggestedCny.value = suggestedReceived.value.amount;
}

function undoSuggestedReceivedAmount() {
  if (!recommendationApplied.value) return;
  form.receivedOriginalAmount = previousManualPrice.value;
  recommendationApplied.value = false;
  appliedSuggestedCny.value = '';
}

function handleManualPriceInput() {
  profitRatePricing.useReceiptDrivenProfitRate();
  formRef.value?.clearValidate('targetProfitRate');
  recommendationApplied.value = false;
  appliedSuggestedCny.value = '';
}

async function submit() {
  const order = props.order;
  if (
    !order ||
    submitDisabledReason.value ||
    !(await validateV2Form(formRef.value)) ||
    !form.openedAt ||
    !form.dueAt
  ) {
    return;
  }

  const payload: UpdateV2OrderInput = {
    openedAt: v2DateTimeInputToIso(form.openedAt),
    dueAt: v2DateTimeInputToIso(form.dueAt),
    remark: form.remark.trim() || null,
    expectedUpdatedAt: order.updatedAt
  };
  if (order.operations.canEditPricing) {
    const platformOrderNo = form.platformOrderNo.trim() || null;
    if (form.settlementPlatformOptionId !== (order.settlementPlatform?.id ?? '')) {
      payload.settlementPlatformOptionId = form.settlementPlatformOptionId;
    }
    if (platformOrderNo !== order.platformOrderNo) {
      payload.platformOrderNo = platformOrderNo;
    }
    if (form.receivedOriginalAmount.trim() !== order.receivedOriginalAmount) {
      payload.receivedOriginalAmount = form.receivedOriginalAmount.trim();
    }
  }
  if (order.operations.canEditCore) {
    Object.assign(payload, {
      customerId: form.customerId,
      serviceOptionId: form.serviceOptionId,
      accountId: form.accountId,
      accountSource: form.accountSource,
      accountDisposition:
        form.accountSource === 'customer_owned' ? 'retained' : form.accountDisposition,
      balanceAmount: form.balanceAmount.trim(),
      lockScope:
        form.accountSource === 'inventory' && form.accountDisposition === 'sold'
          ? 'global'
          : 'by_service'
    });
  }
  if (form.clearWebsiteAccount) {
    payload.clearWebsiteAccount = true;
  } else if (form.websiteAccount.trim()) {
    payload.websiteAccount = form.websiteAccount.trim();
  }
  emit('submit', payload);
}

onBeforeUnmount(() => {
  cancelOptionsQuery();
  if (matchingTimer) clearTimeout(matchingTimer);
});
</script>
