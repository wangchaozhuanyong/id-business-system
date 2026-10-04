<template>
  <V2FormDrawer
    :model-value="Boolean(orderId)"
    title="核对订阅日期"
    description="核对官网付款或订阅凭据后填写生效日期。历史单不能覆盖较新活动订阅。"
    :confirm-loading="saving"
    :confirm-disabled="query.phase.value !== 'ready' || !form.confirmed"
    @update:model-value="!$event && emit('close')"
    @confirm="save"
  >
    <V2AsyncRegion
      skeleton="form"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在核对当前订阅"
      @retry="query.refresh"
    >
      <template v-if="query.data.value">
        <p>订单：{{ query.data.value.orderNo }}</p>
        <p>
          当前订阅：{{
            query.data.value.expectedCurrentOrderId
              ? '已有订阅，将再次核对版本与生效时间'
              : '尚未建立'
          }}
        </p>
        <el-form
          :model="form"
          label-position="left"
          label-width="112px"
          require-asterisk-position="right"
          @submit.prevent="save"
        >
          <el-form-item label="官网开通时间" required
            ><el-input v-model="form.openedAt" type="datetime-local" :disabled="saving"
          /></el-form-item>
          <el-form-item label="官网到期时间" required
            ><el-input v-model="form.dueAt" type="datetime-local" :disabled="saving"
          /></el-form-item>
          <el-form-item label="日期凭据编号" required
            ><el-input
              v-model="form.dateEvidenceRef"
              maxlength="220"
              :disabled="saving"
              placeholder="官网订单或订阅凭据引用"
          /></el-form-item>
          <el-form-item label="核对原因" required
            ><el-input v-model="form.reason" type="textarea" maxlength="500" :disabled="saving"
          /></el-form-item>
          <el-form-item label="当前订阅"
            ><el-checkbox v-model="form.makeCurrent" :disabled="saving"
              >将本单设为当前订阅（历史日期不可覆盖新单）</el-checkbox
            ></el-form-item
          >
          <el-form-item label="日期确认" required
            ><el-checkbox v-model="form.confirmed" :disabled="saving"
              >已核对官网凭据中的真实生效日期</el-checkbox
            ></el-form-item
          >
        </el-form>
        <AppButton variant="ghost" :disabled="saving" @click="repreview"
          >重新预览当前订阅</AppButton
        >
      </template>
    </V2AsyncRegion>
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2FormDrawer>
</template>
<script setup lang="ts">
import { ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2FormDrawer from '@/v2/components/V2FormDrawer.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery, createV2QueryKey } from '@/v2/composables/useV2Query';
import { toV2DateTimeInput, v2DateTimeInputToIso } from '@/v2/utils/dateTime';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { bankRechargeApi } from './bank-recharge-api';
const props = defineProps<{ orderId: string | null }>();
const emit = defineEmits<{ close: []; completed: [] }>();
const saving = ref(false),
  error = ref('');
const draft = useV2FormDraft('bank-recharge/subscription-review', () => ({
  openedAt: '',
  dueAt: '',
  dateEvidenceRef: '',
  reason: '',
  confirmed: false,
  makeCurrent: false,
  operationId: '',
  expectedUpdatedAt: '',
  expectedCurrentOrderId: null as string | null,
  expectedSubscriptionUpdatedAt: null as string | null
}));
const form = draft.form;
const query = useV2ModuleQuery({
  moduleKey: 'bank-recharge-orders',
  scope: 'auto-recharge',
  enabled: () => Boolean(props.orderId),
  key: () => createV2QueryKey({ subscriptionReview: props.orderId }),
  query: ({ signal }) => bankRechargeApi.subscriptionReview(props.orderId!, { signal })
});
watch(
  () => props.orderId,
  (id) => {
    error.value = '';
    if (id) {
      draft.open(id, { operationId: crypto.randomUUID() });
      void query.refresh();
    }
  },
  { immediate: true }
);
watch(
  () => query.data.value,
  (data) => {
    if (!data || data.orderId !== props.orderId || form.expectedUpdatedAt) return;
    form.expectedUpdatedAt = data.expectedUpdatedAt;
    form.expectedCurrentOrderId = data.expectedCurrentOrderId;
    form.expectedSubscriptionUpdatedAt = data.expectedSubscriptionUpdatedAt;
    if (!form.openedAt && data.openedAt) form.openedAt = toV2DateTimeInput(data.openedAt);
    if (!form.dueAt && data.dueAt) form.dueAt = toV2DateTimeInput(data.dueAt);
  }
);
function repreview() {
  form.expectedUpdatedAt = '';
  form.operationId = crypto.randomUUID();
  form.confirmed = false;
  void query.refresh();
}
async function save() {
  const id = props.orderId;
  if (!id || saving.value || query.phase.value !== 'ready' || !form.confirmed) return;
  if (!form.openedAt || !form.dueAt || !form.dateEvidenceRef.trim() || !form.reason.trim()) {
    error.value = '请填写完整日期、凭据编号和原因';
    return;
  }
  const submitted = { ...form };
  const finish = draft.beginSave();
  saving.value = true;
  error.value = '';
  try {
    await bankRechargeApi.verifySubscription(id, {
      ...submitted,
      confirmed: undefined,
      confirmedOfficialDates: submitted.confirmed,
      openedAt: v2DateTimeInputToIso(submitted.openedAt),
      dueAt: v2DateTimeInputToIso(submitted.dueAt)
    });
    finish();
    if (props.orderId === id) emit('close');
    emit('completed');
    ElMessage.success('订阅日期已核对');
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
