<template>
  <section v-if="eligible" aria-label="人工核对充值结果">
    <p class="recharge-note">
      无法收到银行结果时，可由本人核对后结单。此操作不会再次付款，也不会取消官网订单。
    </p>
    <div class="recharge-actions">
      <AppButton :disabled="busy || saving" @click="open('success')">确认充值成功</AppButton>
      <AppButton v-if="canFail" :disabled="busy || saving" @click="open('failure')"
        >确认充值失败</AppButton
      >
    </div>
    <V2ConfirmDialog
      v-model="dialogOpen"
      :title="outcome === 'success' ? '人工确认充值成功' : '人工确认充值失败'"
      message="请核对原单、订阅和银行最终结果。"
      width="min(680px, 96vw)"
      :confirm-text="outcome === 'success' ? '确认成功并生成充值订单' : '确认失败并释放原单'"
      cancel-text="暂不处理"
      :confirm-loading="saving"
      :confirm-disabled-reason="disabledReason"
      :dirty="JSON.stringify(form) !== draft.original.value"
      retain-draft
      @confirm="save"
    >
      <dl class="recharge-summary">
        <dt>原任务编号</dt>
        <dd>{{ job.id }}</dd>
        <dt>官网原单</dt>
        <dd>{{ form.identifier }}</dd>
        <dt>目标套餐</dt>
        <dd>{{ planLabels[job.plan] }}</dd>
        <dt>记录版本时间</dt>
        <dd>{{ formatV2DateTime(form.expectedUpdatedAt) }}</dd>
        <template v-if="job.result.card_last4"
          ><dt>银行卡尾号</dt>
          <dd>{{ job.result.card_last4 }}</dd></template
        >
      </dl>
      <el-form
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        @submit.prevent="save"
      >
        <template v-if="outcome === 'success'">
          <el-form-item label="实际付款金额" required
            ><el-input
              v-model="form.amount"
              :disabled="saving"
              inputmode="decimal"
              placeholder="填写银行实际扣款金额"
          /></el-form-item>
          <el-form-item label="付款币种" required
            ><el-input
              v-model="form.currency"
              :disabled="saving"
              maxlength="3"
              placeholder="如 PHP"
          /></el-form-item>
          <el-form-item label="付款凭据编号" required
            ><el-input
              v-model="form.evidenceRef"
              :disabled="saving"
              maxlength="120"
              placeholder="银行交易引用编号，不填卡号或网址"
          /></el-form-item>
          <el-form-item label="实际开通时间" required
            ><el-input v-model="form.openedAt" :disabled="saving" type="datetime-local"
          /></el-form-item>
          <el-form-item label="实际到期时间" required
            ><el-input v-model="form.dueAt" :disabled="saving" type="datetime-local"
          /></el-form-item>
        </template>
        <el-form-item label="核对说明" required
          ><el-input
            v-model="form.reason"
            :disabled="saving"
            maxlength="120"
            placeholder="简短说明核对结果，不填登录或卡资料"
        /></el-form-item>
        <el-form-item label="银行结果" required>
          <el-checkbox v-model="bankConfirmed" :disabled="saving">{{
            outcome === 'success'
              ? '我已核实该原单实际付款成功，并填写真实扣款金额及币种。'
              : '我已核对银行流水，该原单没有扣款，也没有待入账交易。'
          }}</el-checkbox>
        </el-form-item>
        <el-form-item label="订阅结果" required>
          <el-checkbox v-model="subscriptionConfirmed" :disabled="saving">{{
            outcome === 'success'
              ? '我已核实该账号目标套餐开通成功，并填写真实订阅日期。'
              : '我已核实该账号没有因该原单开通目标套餐。'
          }}</el-checkbox>
        </el-form-item>
      </el-form>
      <p class="recharge-note">
        {{
          outcome === 'success'
            ? '生成关联充值订单并更新订阅，银行卡成功次数只结算一次。客户、手续费和财务资料未补齐时保持待补全，按充值订单现有流程确认入账。'
            : '结束该原单的内部防重并释放未决额度，不生成成功订单或入账；保留历史及付款次数。其他待核实原单继续保护。'
        }}
      </p>
      <p v-if="error" class="recharge-note" role="alert">{{ error }}</p>
    </V2ConfirmDialog>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { V2RechargeManualSettlementInput } from '@apple-business/shared';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { formatV2DateTime, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { rechargeApi } from './api';
import { planLabels } from './recharge-presentation';
import type { V2RechargeJob } from './contracts';
const props = defineProps<{ job: V2RechargeJob; busy: boolean }>();
const emit = defineEmits<{ completed: []; 'busy-change': [value: boolean] }>();
const outcome = ref<'success' | 'failure'>('success');
const saving = ref(false),
  dialogOpen = ref(false),
  error = ref('');
// Statements about this payment are deliberately not retained in the form draft.
const bankConfirmed = ref(false),
  subscriptionConfirmed = ref(false);
const draft = useV2FormDraft('auto-recharge/manual-settlement', () => ({
  operationId: '',
  expectedUpdatedAt: '',
  identifier: '',
  amount: '',
  currency: '',
  evidenceRef: '',
  openedAt: '',
  dueAt: '',
  reason: ''
}));
const form = draft.form;
const identifier = computed(() =>
  props.job.result.operation === 'subscription_upgrade'
    ? props.job.result.upgrade_identifier
    : props.job.result.checkout_identifier
);
const eligible = computed(() => {
  const j = props.job,
    r = j.result;
  return (
    j.action === 'bitbrowser' &&
    ['finished', 'unknown'].includes(j.state) &&
    j.availability?.execution !== 'active' &&
    r.mode !== 'open_browser' &&
    !r.recheck_only &&
    !r.resolution_only &&
    !r.operator_resolution &&
    !r.manual_settlement &&
    r.payment_attempted === true &&
    r.confirmation_requests_sent === 1 &&
    typeof identifier.value === 'string' &&
    /^(?:(?:cs|oaics)_[A-Za-z0-9_]{1,200}|upg_[a-f0-9]{32})$/.test(identifier.value) &&
    ['unknown', 'declined', 'paid_pending'].includes(j.availability?.payment ?? '')
  );
});
const canFail = computed(
  () =>
    !props.job.result.payment_evidence &&
    props.job.result.payment_status !== 'paid' &&
    props.job.result.status !== 'subscription_activated'
);
const binding = computed(() => `${props.job.id}:${props.job.updatedAt}:${identifier.value}`);
const openedBinding = ref('');
let disposed = false;
function clearStatements() {
  bankConfirmed.value = false;
  subscriptionConfirmed.value = false;
}
watch(
  dialogOpen,
  (visible) => {
    if (!visible) clearStatements();
  },
  { flush: 'sync' }
);
watch(
  binding,
  () => {
    if (dialogOpen.value && binding.value !== openedBinding.value) {
      dialogOpen.value = false;
      clearStatements();
    }
  },
  { flush: 'sync' }
);
watch(saving, (value) => emit('busy-change', value), { flush: 'sync' });
const disabledReason = computed(() => {
  if (
    !eligible.value ||
    binding.value !== openedBinding.value ||
    form.expectedUpdatedAt !== props.job.updatedAt
  )
    return '原任务已变化，请刷新后重新核对';
  if (props.busy) return '请等待当前操作完成';
  if (!bankConfirmed.value || !subscriptionConfirmed.value) return '请本人核对银行与订阅结果';
  if (!form.reason.trim()) return '请填写核对说明';
  if (
    outcome.value === 'success' &&
    (!form.amount || !form.currency || !form.evidenceRef.trim() || !form.openedAt || !form.dueAt)
  )
    return '请补全实际付款、凭据及订阅日期';
  return '';
});
function open(value: 'success' | 'failure') {
  if (!eligible.value || props.busy || saving.value || (value === 'failure' && !canFail.value))
    return;
  outcome.value = value;
  clearStatements();
  error.value = '';
  openedBinding.value = binding.value;
  draft.open(`${openedBinding.value}:${value}`, {
    operationId: crypto.randomUUID(),
    expectedUpdatedAt: props.job.updatedAt,
    identifier: String(identifier.value)
  });
  dialogOpen.value = true;
}
async function save() {
  if (!dialogOpen.value || saving.value || disabledReason.value) return;
  const sourceId = props.job.id,
    submittedBinding = openedBinding.value;
  const common = {
    operationId: form.operationId,
    expectedUpdatedAt: form.expectedUpdatedAt,
    identifier: form.identifier,
    confirmed: true as const,
    reason: form.reason.trim()
  };
  const finish = draft.beginSave();
  saving.value = true;
  error.value = '';
  try {
    const input: V2RechargeManualSettlementInput =
      outcome.value === 'success'
        ? {
            ...common,
            outcome: 'success',
            subscriptionConfirmed: true,
            amount: form.amount.trim(),
            currency: form.currency.trim().toUpperCase(),
            evidenceRef: form.evidenceRef.trim(),
            openedAt: v2DateTimeInputToIso(form.openedAt),
            dueAt: v2DateTimeInputToIso(form.dueAt)
          }
        : { ...common, outcome: 'failure', noDebitConfirmed: true, notActivatedConfirmed: true };
    const result = await rechargeApi.settleManually(sourceId, input);
    finish();
    if (disposed) return;
    if (binding.value === submittedBinding) dialogOpen.value = false;
    emit('completed');
    ElMessage.success(
      result.orderId
        ? '人工核实成功，已生成关联充值订单，请在充值订单补全财务资料'
        : '人工核实失败，原单已结束；历史记录保留'
    );
  } catch (cause) {
    if (!disposed && binding.value === submittedBinding) error.value = getApiErrorMessage(cause);
  } finally {
    if (!disposed) saving.value = false;
  }
}
onBeforeUnmount(() => {
  disposed = true;
  clearStatements();
  if (saving.value) emit('busy-change', false);
});
</script>

<style scoped src="./auto-recharge.css"></style>
