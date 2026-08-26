<template>
  <V2ConfirmDialog
    :model-value="modelValue"
    :title="order ? `退款订单 ${order.orderNo}` : '退款订单'"
    message=""
    width="min(620px, calc(100vw - 32px))"
    confirm-text="确认退款"
    danger
    :confirm-loading="saving"
    :confirm-disabled-reason="submitDisabledReason"
    :dirty="formDirty"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <V2DetailSummary
      v-if="order"
      heading-id="order-refund-summary"
      eyebrow="退款对象"
      :title="order.orderNo"
      :description="`${order.customer.name} · ${order.service.name}`"
      :metrics="[
        { label: '订单实收', value: order.receivedAmount },
        { label: '额外退款成本（人民币）', value: order.refundCostAmount ?? '0' }
      ]"
    />
    <el-alert
      type="warning"
      :title="
        order?.accountDisposition === 'sold'
          ? '系统将全额退回本单原实收，并自动把本单售出的 ID 恢复为可用'
          : '系统将按本单原实收金额执行全额退款'
      "
      :closable="false"
      show-icon
    />
    <el-alert
      v-if="order?.upgradeBalanceReturn?.status === 'active'"
      type="info"
      :title="`该订单已登记升级退币 ${order.upgradeBalanceReturn.returnedBalanceAmount} ${order.upgradeBalanceReturn.currencyCode}；整单退款只会继续处理尚未退回的 ${order.remainingRefundableBalanceAmount} ${order.upgradeBalanceReturn.currencyCode}。`"
      :closable="false"
      show-icon
    />

    <el-form
      ref="formRef"
      class="v2-order-refund-form v2-horizontal-form"
      :model="form"
      :rules="rules"
      label-position="left"
      label-width="112px"
      require-asterisk-position="right"
      status-icon
      scroll-to-error
      :scroll-into-view-options="{ behavior: 'smooth', block: 'center' }"
    >
      <V2PanelSection heading-id="order-refund-evidence" title="退款凭证" step="01">
        <el-form-item prop="refundCostAmount">
          <template #label>
            <span class="v2-order-refund-label">
              额外退款成本（人民币）
              <el-tooltip placement="top" :show-after="200" max-width="360px">
                <template #content>
                  此处金额统一按人民币计算。订单本金由系统按原实收金额自动全额退回。此处仅填写退款过程中额外实际支付的费用，
                  例如支付通道手续费、平台罚款或额外补偿。不要填写退给客户的订单本金，也不要填写余额成本、
                  平台手续费或 ID 成本；这些由系统自动计算。没有额外费用时填写 0。
                </template>
                <el-icon class="v2-order-refund-help" aria-label="额外退款成本说明">
                  <QuestionFilled />
                </el-icon>
              </el-tooltip>
            </span>
          </template>
          <el-input
            v-model="form.refundCostAmount"
            inputmode="decimal"
            maxlength="19"
            placeholder="没有额外费用时填写 0"
          >
            <template #append>CNY</template>
          </el-input>
        </el-form-item>

        <el-form-item label="退款原因" prop="reason">
          <el-input
            v-model="form.reason"
            type="textarea"
            :rows="3"
            maxlength="500"
            show-word-limit
            placeholder="填写可核对的退款原因"
          />
        </el-form-item>
      </V2PanelSection>

      <V2PanelSection heading-id="order-refund-impact" title="资产与归属影响" step="02">
        <el-form-item label="ID 余额处理" prop="balanceRefundMode">
          <el-radio-group
            v-model="form.balanceRefundMode"
            class="v2-order-refund-modes"
            aria-label="ID 余额退款方式"
          >
            <el-radio-button value="none">余额不退回</el-radio-button>
            <el-radio-button value="full">尚未退回余额全部退回</el-radio-button>
            <el-radio-button value="custom">自定义退款到 ID 余额</el-radio-button>
          </el-radio-group>
          <p class="v2-order-refund-hint">
            请选择实际退回 ID
            的余额。全部退回只处理尚未被升级退币恢复的部分；自定义退回会按剩余流水单位成本同比例恢复人民币成本。
          </p>
        </el-form-item>

        <el-form-item
          v-if="form.balanceRefundMode === 'custom'"
          label="退回 ID 余额"
          prop="customRefundBalanceAmount"
        >
          <el-input
            v-model="form.customRefundBalanceAmount"
            inputmode="decimal"
            maxlength="19"
            :placeholder="`最多可退回 ${order?.remainingRefundableBalanceAmount ?? '0'}`"
          >
            <template #append>{{ order?.balanceCurrencyCode || '原币' }}</template>
          </el-input>
          <p class="v2-order-refund-hint">
            本单原消费余额为 {{ order?.balanceAmount ?? '0' }}，当前尚未退回
            {{ order?.remainingRefundableBalanceAmount ?? '0' }}
            {{ order?.balanceCurrencyCode || '原币' }}。自定义金额必须大于 0
            且不能超过尚未退回金额。
          </p>
        </el-form-item>

        <el-form-item v-if="order?.accountDisposition === 'sold'" label="ID 销售处理">
          <div class="v2-order-refund-impact">
            自动解除本单 ID 销售归属，冲回本单已结转的 ID
            成本并恢复为可用；其他业务记录不影响本次整单退款。
          </div>
        </el-form-item>
      </V2PanelSection>
    </el-form>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import { QuestionFilled } from '@element-plus/icons-vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2DetailSummary from '@/v2/components/V2DetailSummary.vue';
import V2PanelSection from '@/v2/components/V2PanelSection.vue';
import { useV2FormSnapshot } from '@/v2/composables/useV2FormSnapshot';
import { V2_DECIMAL_PLACES, addDecimalStrings, isV2UnsignedDecimal } from '@/v2/utils/decimal';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { RefundV2OrderInput, V2Order } from '../contracts';

const props = defineProps<{
  modelValue: boolean;
  order: V2Order | null;
  saving: boolean;
}>();

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [payload: Omit<RefundV2OrderInput, 'idempotencyKey'>];
}>();

const formRef = ref<FormInstance>();
const form = reactive({
  refundCostAmount: '0',
  reason: '',
  balanceRefundMode: 'none' as 'none' | 'full' | 'custom',
  customRefundBalanceAmount: ''
});
const { dirty: formDirty, capture: captureFormSnapshot } = useV2FormSnapshot(
  () => props.modelValue,
  () => form
);

const submitDisabledReason = computed(() => (props.order ? '' : '未选择退款订单'));

const rules: FormRules = {
  refundCostAmount: [
    {
      required: true,
      validator: (_rule, value, callback) =>
        callback(
          isNonNegativeDecimal(value)
            ? undefined
            : new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数的非负金额`)
        ),
      trigger: 'blur'
    }
  ],
  customRefundBalanceAmount: [
    {
      validator: (_rule, value, callback) => {
        if (form.balanceRefundMode !== 'custom') return callback();
        if (!isV2UnsignedDecimal(value, { allowZero: false })) {
          return callback(new Error(`请输入最多 ${V2_DECIMAL_PLACES} 位小数且大于 0 的余额`));
        }
        const maximum = props.order?.remainingRefundableBalanceAmount ?? '0';
        const difference = addDecimalStrings(String(value).trim(), `-${maximum}`);
        callback(
          difference.startsWith('-') || difference === '0'
            ? undefined
            : new Error(`退回 ID 余额不能超过本单尚未退回余额 ${maximum}`)
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
            : new Error('退款原因必须为 2 至 500 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};

watch(
  () => [props.modelValue, props.order?.id] as const,
  ([visible]) => {
    if (!visible) return;
    Object.assign(form, {
      refundCostAmount: props.order?.refundCostAmount ?? '0',
      reason: '',
      balanceRefundMode: 'none',
      customRefundBalanceAmount: ''
    });
    captureFormSnapshot();
  }
);

async function submit() {
  if (submitDisabledReason.value || !(await validateV2Form(formRef.value))) return;
  emit('submit', {
    refundCostAmount: form.refundCostAmount.trim(),
    reason: form.reason.trim(),
    balanceRefundMode: form.balanceRefundMode,
    ...(form.balanceRefundMode === 'custom'
      ? { customRefundBalanceAmount: form.customRefundBalanceAmount.trim() }
      : {})
  });
}

function isNonNegativeDecimal(value: unknown) {
  return isV2UnsignedDecimal(value);
}
</script>

<style scoped>
.v2-order-refund-form {
  display: grid;
  gap: 2px;
  margin-top: 18px;
}

.v2-order-refund-hint {
  width: 100%;
  margin: 8px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.65;
}

.v2-order-refund-modes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.v2-order-refund-modes :deep(.el-radio-button__inner) {
  border: 1px solid var(--el-border-color);
  border-radius: 4px;
}

.v2-order-refund-modes :deep(.el-radio-button:first-child .el-radio-button__inner) {
  border-left: 1px solid var(--el-border-color);
}

.v2-order-refund-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.v2-order-refund-help {
  color: var(--v2-primary);
  cursor: help;
}

.v2-order-refund-impact {
  color: var(--v2-text-secondary);
  line-height: 1.65;
}
</style>
