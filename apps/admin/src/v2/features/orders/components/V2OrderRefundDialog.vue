<template>
  <el-dialog
    :model-value="modelValue"
    :title="order ? `退款订单 ${order.orderNo}` : '退款订单'"
    width="min(520px, 94vw)"
    destroy-on-close
    @close="$emit('update:modelValue', false)"
  >
    <el-alert
      type="warning"
      title="退款默认只记录真实退款成本，不会自动增加 Apple ID 余额"
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
      <el-form-item label="退款成本" prop="refundCostAmount">
        <el-input
          v-model="form.refundCostAmount"
          inputmode="decimal"
          maxlength="19"
          placeholder="实际承担的退款或补偿成本"
        />
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

      <el-form-item label="Apple 余额处理">
        <el-switch
          v-model="form.restoreBalance"
          active-text="恢复原消费余额"
          inactive-text="不恢复余额"
        />
        <p class="v2-order-refund-hint">
          只有确认业务未开通、原余额确实未被消费时才可开启。服务端会检查开通记录并写入反向流水，
          有开通证据时会拒绝恢复。
        </p>
      </el-form-item>

      <el-form-item v-if="order?.accountDisposition === 'sold'" label="ID 销售处理">
        <el-checkbox v-model="form.accountReturned">ID 已由客户退回并确认可再次使用</el-checkbox>
        <p class="v2-order-refund-hint">
          默认保持“已卖出”。勾选后会解除销售占用，并从本单利润中撤销已计入的 ID 成本。
        </p>
      </el-form-item>
    </el-form>

    <template #footer>
      <div class="v2-order-refund-footer">
        <span v-if="submitDisabledReason" class="v2-submit-disabled-reason" role="status">
          {{ submitDisabledReason }}
        </span>
        <AppButton variant="ghost" @click="$emit('update:modelValue', false)">取消</AppButton>
        <AppButton
          variant="danger"
          :loading="saving"
          :disabled="Boolean(submitDisabledReason)"
          :aria-label="submitDisabledReason ? `确认退款：${submitDisabledReason}` : '确认退款'"
          @click="submit"
        >
          确认退款
        </AppButton>
      </div>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { V2_DECIMAL_PLACES, isV2UnsignedDecimal } from '@/v2/utils/decimal';
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
  refundCostAmount: '',
  reason: '',
  restoreBalance: false,
  accountReturned: false
});

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
      refundCostAmount: props.order?.refundCostAmount ?? '',
      reason: '',
      restoreBalance: false,
      accountReturned: false
    });
  }
);

async function submit() {
  if (submitDisabledReason.value || !(await validateV2Form(formRef.value))) return;
  emit('submit', {
    refundCostAmount: form.refundCostAmount.trim(),
    reason: form.reason.trim(),
    restoreBalance: form.restoreBalance,
    accountReturned: form.accountReturned
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
  margin: 8px 0 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.65;
}

.v2-order-refund-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
