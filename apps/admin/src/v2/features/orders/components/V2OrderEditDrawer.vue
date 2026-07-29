<template>
  <V2FormDrawer
    :model-value="modelValue"
    :title="order ? `修改订单 ${order.orderNo}` : '修改订单'"
    confirm-text="保存修改"
    :confirm-loading="saving"
    :confirm-disabled="submitDisabled"
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
      @retry="loadOptions()"
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
        autocomplete="off"
      >
        <el-alert
          v-if="order && !order.operations.canEditCore"
          type="info"
          title="订单已有扣款或开通证据，客户、业务、使用 ID、ID 处理方式和消耗余额已锁定"
          :closable="false"
          show-icon
        />

        <div class="v2-order-edit-grid">
          <el-form-item label="客户" prop="customerId">
            <el-select
              v-model="form.customerId"
              filterable
              remote
              reserve-keyword
              :remote-method="searchCustomers"
              :loading="customerSearching"
              :disabled="!order?.operations.canEditCore"
              placeholder="搜索客户"
            >
              <el-option
                v-for="customer in customerChoices"
                :key="customer.id"
                :label="customerLabel(customer)"
                :value="customer.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="业务" prop="serviceOptionId">
            <el-select
              v-model="form.serviceOptionId"
              filterable
              :disabled="!order?.operations.canEditCore"
              placeholder="选择业务"
            >
              <el-option
                v-for="service in serviceChoices"
                :key="service.id"
                :label="service.label"
                :value="service.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="消耗余额" prop="balanceAmount">
            <el-input
              v-model="form.balanceAmount"
              inputmode="decimal"
              maxlength="19"
              :disabled="!order?.operations.canEditCore"
            />
          </el-form-item>

          <el-form-item label="使用 ID" prop="accountId">
            <el-select
              v-model="form.accountId"
              filterable
              :loading="matchingLoading"
              :disabled="!order?.operations.canEditCore"
              placeholder="选择匹配 ID"
            >
              <el-option
                v-for="candidate in accountChoices"
                :key="candidate.id"
                :label="candidate.label"
                :value="candidate.id"
              />
            </el-select>
            <span v-if="matchingError" class="v2-order-edit-error">{{ matchingError }}</span>
          </el-form-item>

          <el-form-item label="ID 处理方式">
            <div class="v2-order-edit-disposition">
              <el-radio-group
                v-model="form.accountDisposition"
                :disabled="!order?.operations.canEditCore"
              >
                <el-radio value="retained">保留 ID</el-radio>
                <el-radio value="sold">卖出 ID</el-radio>
              </el-radio-group>
              <small v-if="form.accountDisposition === 'sold'">
                将计入当前 ID 购买成本，并锁定该 ID 停止匹配、加卡和续费。
              </small>
              <small v-else>不计 ID 购买成本，ID 仍可继续使用。</small>
            </div>
          </el-form-item>

          <el-form-item label="结算平台">
            <el-select
              v-model="form.settlementPlatformOptionId"
              clearable
              filterable
              placeholder="不使用结算平台"
              @change="handleSettlementChange"
            >
              <el-option
                v-for="platform in settlementChoices"
                :key="platform.id"
                :label="platform.name"
                :value="platform.id"
              />
            </el-select>
          </el-form-item>

          <el-form-item label="平台订单号" prop="platformOrderNo">
            <el-input
              v-model="form.platformOrderNo"
              maxlength="160"
              :disabled="!form.settlementPlatformOptionId"
              placeholder="选填"
            />
          </el-form-item>

          <el-form-item label="实收金额" prop="receivedAmount">
            <el-input v-model="form.receivedAmount" inputmode="decimal" maxlength="19" />
          </el-form-item>

          <el-form-item label="预计平台手续费">
            <div class="v2-order-edit-readonly">
              <strong>¥{{ platformFeePreview }}</strong>
              <el-tag type="info" effect="plain">服务端复核</el-tag>
            </div>
          </el-form-item>

          <el-form-item label="开通时间" prop="openedAt">
            <el-date-picker
              v-model="form.openedAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              placeholder="选择开通时间"
            />
          </el-form-item>

          <el-form-item label="到期时间" prop="dueAt">
            <el-date-picker
              v-model="form.dueAt"
              type="datetime"
              format="YYYY-MM-DD HH:mm"
              placeholder="选择到期时间"
            />
          </el-form-item>

          <el-form-item v-if="order?.operations.canEditCore" label="ID 锁范围">
            <el-radio-group v-model="form.lockScope" aria-label="ID 锁范围">
              <el-radio-button
                v-for="option in lockScopeOptions"
                :key="option.value"
                :value="option.value"
                :disabled="form.accountDisposition === 'sold' && option.value !== 'global'"
              >
                {{ option.label }}
              </el-radio-button>
            </el-radio-group>
          </el-form-item>
        </div>

        <el-form-item label="客户网站账号">
          <el-input
            v-model="form.websiteAccount"
            maxlength="255"
            autocomplete="off"
            :disabled="form.clearWebsiteAccount"
            :placeholder="
              order?.hasWebsiteAccount ? `留空保持 ${order.maskedWebsiteAccount}` : '选填'
            "
          />
          <el-checkbox
            v-if="order?.hasWebsiteAccount"
            v-model="form.clearWebsiteAccount"
            class="v2-order-edit-clear"
          >
            清空已保存的网站账号
          </el-checkbox>
        </el-form-item>

        <el-form-item label="备注">
          <el-input
            v-model="form.remark"
            type="textarea"
            :rows="3"
            maxlength="2000"
            show-word-limit
          />
        </el-form-item>
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
import { calculatePlatformFeeAmount } from '@/v2/features/order-entry/order-pricing';
import type {
  UpdateV2OrderInput,
  V2Order,
  V2OrderCandidate,
  V2OrderEntryCustomer,
  V2OrderEntryOptions
} from '../contracts';
import {
  createEmptyOrderEditForm,
  createOrderEditRules,
  customerLabel,
  formatDecimal,
  isNonNegativeDecimal,
  isPositiveDecimal
} from './order-edit-form';
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
const optionsLoading = ref(false);
const optionsResolved = ref(false);
const optionsError = ref('');
const customerSearching = ref(false);
const matchingLoading = ref(false);
const matchingError = ref('');
const candidates = ref<V2OrderCandidate[]>([]);
const options = ref<V2OrderEntryOptions>({
  customers: [],
  countries: [],
  settlementPlatforms: []
});
const form = reactive(createEmptyOrderEditForm());
let customerTimer: ReturnType<typeof setTimeout> | undefined;
let matchingTimer: ReturnType<typeof setTimeout> | undefined;
let matchingSequence = 0;
let initializing = false;

const lockScopeOptions = [
  { label: '当前业务', value: 'by_service' },
  { label: '整个 ID', value: 'global' }
];

const customerChoices = computed<V2OrderEntryCustomer[]>(() => {
  const current = props.order
    ? {
        id: props.order.customer.id,
        name: props.order.customer.name,
        wechat: null,
        maskedPhone: null
      }
    : null;
  return current && !options.value.customers.some((item) => item.id === current.id)
    ? [current, ...options.value.customers]
    : options.value.customers;
});

const serviceChoices = computed(() => {
  const items = options.value.countries.flatMap((country) =>
    country.children.flatMap((category) =>
      category.children.map((service) => ({
        id: service.id,
        label: `${country.name} / ${category.name} / ${service.name}`
      }))
    )
  );
  const current = props.order;
  if (current && !items.some((item) => item.id === current.service.id)) {
    items.unshift({
      id: current.service.id,
      label: `${current.service.parent?.name || '原分类'} / ${current.service.name}`
    });
  }
  return items;
});

const settlementChoices = computed(() => {
  const items = [...options.value.settlementPlatforms];
  const current = props.order?.settlementPlatform;
  if (current && !items.some((item) => item.id === current.id)) {
    items.unshift({
      ...current,
      fixedFee: props.order?.platformFeeAmount ?? '0',
      percentageFee: '0'
    });
  }
  return items;
});

const accountChoices = computed(() => {
  const items = candidates.value.map((candidate) => ({
    id: candidate.id,
    label: `${candidate.appleIdMasked} / 余额 ${formatDecimal(candidate.currentBalance)}`
  }));
  const current = props.order?.account;
  if (current && !items.some((item) => item.id === current.id)) {
    items.unshift({
      id: current.id,
      label: `${current.appleIdMasked} / 当前使用`
    });
  }
  return items;
});

const selectedPlatform = computed(
  () => settlementChoices.value.find((item) => item.id === form.settlementPlatformOptionId) ?? null
);

const platformFeePreview = computed(() => {
  const platform = selectedPlatform.value;
  if (!platform) return '0';
  return (
    calculatePlatformFeeAmount(form.receivedAmount, platform.fixedFee, platform.percentageFee) ??
    '0'
  );
});

const submitDisabled = computed(
  () =>
    props.saving ||
    optionsLoading.value ||
    Boolean(optionsError.value) ||
    !form.customerId ||
    !form.serviceOptionId ||
    !form.accountId ||
    !isNonNegativeDecimal(form.receivedAmount) ||
    !isPositiveDecimal(form.balanceAmount) ||
    !(form.openedAt instanceof Date) ||
    !(form.dueAt instanceof Date)
);

const rules = createOrderEditRules(form, () => Boolean(props.order?.operations.canEditCore));

watch(
  () => [props.modelValue, props.order?.id] as const,
  ([visible]) => {
    if (visible && props.order) {
      initialize(props.order);
    }
  }
);

watch(
  () => [form.serviceOptionId, form.balanceAmount],
  () => {
    if (!initializing && props.order?.operations.canEditCore) {
      scheduleCandidates();
    }
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
  optionsResolved.value = false;
  Object.assign(form, {
    customerId: order.customer.id,
    serviceOptionId: order.service.id,
    accountId: order.account?.id ?? '',
    accountDisposition: order.accountDisposition === 'sold' ? 'sold' : 'retained',
    settlementPlatformOptionId: order.settlementPlatform?.id ?? '',
    platformOrderNo: order.platformOrderNo ?? '',
    websiteAccount: '',
    clearWebsiteAccount: false,
    receivedAmount: order.receivedAmount,
    balanceAmount: order.balanceAmount,
    openedAt: order.openedAt ? new Date(order.openedAt) : null,
    dueAt: order.dueAt ? new Date(order.dueAt) : null,
    lockScope: order.activeLock?.lockScope ?? 'by_service',
    remark: order.remark ?? ''
  });
  candidates.value = [];
  matchingError.value = '';
  await loadOptions();
  initializing = false;
}

async function loadOptions(customerKeyword = '') {
  optionsLoading.value = true;
  optionsError.value = '';
  try {
    const result = await idBusinessV2OrdersApi.getEntryOptions(customerKeyword || undefined);
    const selected = customerChoices.value.find((item) => item.id === form.customerId);
    options.value = {
      ...result,
      customers:
        selected && !result.customers.some((item) => item.id === selected.id)
          ? [selected, ...result.customers]
          : result.customers
    };
    optionsResolved.value = true;
  } catch (error) {
    optionsError.value = getApiErrorMessage(error);
  } finally {
    optionsLoading.value = false;
    customerSearching.value = false;
  }
}

function searchCustomers(keyword: string) {
  if (customerTimer) clearTimeout(customerTimer);
  customerSearching.value = true;
  customerTimer = setTimeout(() => void loadOptions(keyword.trim()), 300);
}

function scheduleCandidates() {
  if (matchingTimer) clearTimeout(matchingTimer);
  if (!form.serviceOptionId || !isPositiveDecimal(form.balanceAmount)) {
    candidates.value = [];
    return;
  }
  matchingTimer = setTimeout(() => void loadCandidates(), 350);
}

async function loadCandidates() {
  const sequence = ++matchingSequence;
  matchingLoading.value = true;
  matchingError.value = '';
  try {
    const result = await idBusinessV2OrdersApi.findMatchingCandidates({
      serviceOptionId: form.serviceOptionId,
      balanceAmount: form.balanceAmount.trim(),
      limit: 50
    });
    if (sequence !== matchingSequence) return;
    candidates.value = result.items;
    const coreChanged =
      form.serviceOptionId !== props.order?.service.id ||
      form.balanceAmount !== props.order?.balanceAmount;
    if (coreChanged) {
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

function handleSettlementChange() {
  if (!form.settlementPlatformOptionId) {
    form.platformOrderNo = '';
  }
}

async function submit() {
  const order = props.order;
  if (
    !order ||
    !formRef.value ||
    !(await formRef.value.validate().catch(() => false)) ||
    !form.openedAt ||
    !form.dueAt
  ) {
    return;
  }

  const payload: UpdateV2OrderInput = {
    settlementPlatformOptionId: form.settlementPlatformOptionId || null,
    platformOrderNo: form.platformOrderNo.trim() || null,
    receivedAmount: form.receivedAmount.trim(),
    openedAt: form.openedAt.toISOString(),
    dueAt: form.dueAt.toISOString(),
    remark: form.remark.trim() || null,
    expectedUpdatedAt: order.updatedAt
  };
  if (order.operations.canEditCore) {
    Object.assign(payload, {
      customerId: form.customerId,
      serviceOptionId: form.serviceOptionId,
      accountId: form.accountId,
      accountDisposition: form.accountDisposition,
      balanceAmount: form.balanceAmount.trim(),
      lockScope: form.accountDisposition === 'sold' ? 'global' : form.lockScope
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
  if (customerTimer) clearTimeout(customerTimer);
  if (matchingTimer) clearTimeout(matchingTimer);
});
</script>
