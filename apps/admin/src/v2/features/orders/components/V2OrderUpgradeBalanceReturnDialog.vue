<template>
  <V2ConfirmDialog
    :model-value="modelValue"
    :title="order ? `登记升级退币 ${order.orderNo}` : '登记升级退币'"
    message=""
    width="min(660px, calc(100vw - 32px))"
    confirm-text="确认登记"
    :confirm-loading="saving"
    :confirm-disabled-reason="submitDisabledReason"
    :dirty="formDirty"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <V2DetailSummary
      v-if="order"
      heading-id="order-upgrade-return-summary"
      eyebrow="原 Plus 订单"
      :title="order.orderNo"
      :description="`${order.customer.name} · ${order.service.name}`"
      :metrics="[
        { label: '订单实收（人民币）', value: order.receivedAmount },
        { label: '当前利润（人民币）', value: order.profitAmount ?? '—' }
      ]"
    />

    <el-alert
      type="info"
      title="这里只登记平台退回原 ID 钱包的余额，不会冲减客户付款，也不会把原订单改成退款。"
      :closable="false"
      show-icon
    />

    <el-form
      ref="formRef"
      class="v2-order-upgrade-return-form v2-horizontal-form"
      :model="form"
      :rules="rules"
      label-position="left"
      label-width="132px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <V2PanelSection heading-id="order-upgrade-return-evidence" title="退币凭证" step="01">
        <el-form-item label="退回 ID 余额" prop="returnedBalanceAmount">
          <el-input
            v-model="form.returnedBalanceAmount"
            inputmode="decimal"
            maxlength="19"
            :placeholder="`最多 ${order?.balanceAmount ?? '0'}`"
          >
            <template #append>{{ order?.balanceCurrencyCode || '原币' }}</template>
          </el-input>
          <p class="v2-order-upgrade-return-hint">
            币种取自原消费订单，不能手动切换。美国 ID 使用 USD，日本 ID 使用 JPY。
          </p>
        </el-form-item>

        <el-form-item label="登记原因" prop="reason">
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="例如：用户升级 Pro，Plus 剩余金额由平台退回原 ID"
          />
        </el-form-item>
      </V2PanelSection>

      <V2PanelSection heading-id="order-upgrade-return-impact" title="成本与利润预览" step="02">
        <el-alert
          v-if="previewLoading"
          type="info"
          title="正在按原消费成本核算影响"
          :closable="false"
          show-icon
        />
        <el-alert
          v-else-if="previewError"
          type="error"
          :title="previewError"
          :closable="false"
          show-icon
        />
        <dl v-else-if="preview" class="v2-order-upgrade-return-preview">
          <div>
            <dt>实际退回原币</dt>
            <dd>{{ preview.returnedBalanceAmount }} {{ preview.currencyCode }}</dd>
          </div>
          <div>
            <dt>恢复余额成本</dt>
            <dd>¥{{ preview.restoredBalanceCostAmount }}</dd>
          </div>
          <div>
            <dt>登记前利润</dt>
            <dd>¥{{ preview.originalProfitAmount }}</dd>
          </div>
          <div>
            <dt>登记后利润</dt>
            <dd class="is-positive">¥{{ preview.adjustedProfitAmount }}</dd>
          </div>
          <div>
            <dt>利润增加</dt>
            <dd class="is-positive">+¥{{ preview.profitIncreaseAmount }}</dd>
          </div>
          <div>
            <dt>客户实收</dt>
            <dd>保持不变</dd>
          </div>
        </dl>
        <p v-else class="v2-order-upgrade-return-empty">
          输入实际退回金额后，系统会按原消费流水的单位成本计算，不使用退款当天汇率。
        </p>
      </V2PanelSection>
    </el-form>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import { V2_DECIMAL_PLACES, addDecimalStrings, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import { idBusinessV2OrdersApi } from '../api';
import type {
  RecordV2OrderUpgradeBalanceReturnInput,
  V2Order,
  V2OrderUpgradeBalanceReturnPreview
} from '../contracts';

const props = defineProps<{
  modelValue: boolean;
  order: V2Order | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [payload: Omit<RecordV2OrderUpgradeBalanceReturnInput, 'idempotencyKey'>];
}>();

const formRef = ref<FormInstance>();
const form = reactive({
  returnedBalanceAmount: '',
  reason: ''
});
const preview = ref<V2OrderUpgradeBalanceReturnPreview | null>(null);
const previewLoading = ref(false);
const previewError = ref('');
const previewedAmount = ref('');
let previewSequence = 0;
const { dirty: formDirty, capture: captureFormSnapshot } = useV2FormSnapshot(
  () => props.modelValue,
  () => form
);

const submitDisabledReason = computed(() => {
  if (!props.order) return '未选择订单';
  if (previewLoading.value) return '正在核算成本与利润';
  if (previewError.value) return '请先修正退回金额';
  if (!preview.value || previewedAmount.value !== form.returnedBalanceAmount.trim()) {
    return '请先等待成本与利润核算完成';
  }
  return '';
});

const rules: FormRules = {
  returnedBalanceAmount: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        if (!isV2UnsignedDecimal(value, { allowZero: false })) {
          return callback(new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数且大于 0 的余额`));
        }
        const maximum = props.order?.balanceAmount ?? '0';
        const difference = addDecimalStrings(String(value).trim(), `-${maximum}`);
        callback(
          difference.startsWith('-') || difference === '0'
            ? undefined
            : new Error(`退回 ID 余额不能超过本单原消费余额 ${maximum}`)
        );
      },
      trigger: 'blur'
    }
  ],
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const normalized = String(value ?? '').trim();
        callback(
          normalized.length >= 2 && normalized.length <= 500
            ? undefined
            : new Error('登记原因必须为 2 至 500 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};

watch(
  () => [props.modelValue, props.order?.id] as const,
  ([visible]) => {
    previewSequence += 1;
    preview.value = null;
    previewLoading.value = false;
    previewError.value = '';
    previewedAmount.value = '';
    if (!visible) return;
    Object.assign(form, { returnedBalanceAmount: '', reason: '' });
    captureFormSnapshot();
  }
);

watch(
  () => [props.modelValue, props.order?.id, form.returnedBalanceAmount] as const,
  ([visible, orderId, amount], _previous, onCleanup) => {
    preview.value = null;
    previewError.value = '';
    previewedAmount.value = '';
    if (!visible || !orderId || !isV2UnsignedDecimal(amount, { allowZero: false })) {
      previewLoading.value = false;
      return;
    }
    const maximum = props.order?.balanceAmount ?? '0';
    const difference = addDecimalStrings(String(amount).trim(), `-${maximum}`);
    if (!difference.startsWith('-') && difference !== '0') {
      previewLoading.value = false;
      return;
    }

    const sequence = ++previewSequence;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      previewLoading.value = true;
      try {
        const result = await idBusinessV2OrdersApi.previewUpgradeBalanceReturn(
          orderId,
          { returnedBalanceAmount: String(amount).trim() },
          { signal: controller.signal }
        );
        if (sequence !== previewSequence) return;
        preview.value = result;
        previewedAmount.value = String(amount).trim();
      } catch (error) {
        if (sequence !== previewSequence || controller.signal.aborted) return;
        previewError.value = getApiErrorMessage(error);
      } finally {
        if (sequence === previewSequence) previewLoading.value = false;
      }
    }, 350);
    onCleanup(() => {
      window.clearTimeout(timer);
      controller.abort();
    });
  }
);

async function submit() {
  if (submitDisabledReason.value || !(await validateV2Form(formRef.value))) return;
  emit('submit', {
    returnedBalanceAmount: form.returnedBalanceAmount.trim(),
    reason: form.reason.trim()
  });
}
</script>

<style scoped>
.v2-order-upgrade-return-form {
  display: grid;
  gap: 2px;
  margin-top: 18px;
}

.v2-order-upgrade-return-hint,
.v2-order-upgrade-return-empty {
  width: 100%;
  margin: 8px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.65;
}

.v2-order-upgrade-return-preview {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
}

.v2-order-upgrade-return-preview > div {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: baseline;
  padding: 10px 12px;
  border: 1px solid var(--v2-border);
  border-radius: 6px;
  background: var(--v2-surface-soft);
}

.v2-order-upgrade-return-preview dt {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-order-upgrade-return-preview dd {
  margin: 0;
  color: var(--v2-text-primary);
  font-variant-numeric: tabular-nums;
  font-weight: 700;
}

.v2-order-upgrade-return-preview .is-positive {
  color: var(--el-color-success);
}

@media (max-width: 560px) {
  .v2-order-upgrade-return-preview {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
