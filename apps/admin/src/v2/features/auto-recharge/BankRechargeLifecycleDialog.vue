<template>
  <V2ConfirmDialog
    :model-value="Boolean(target)"
    :title="title"
    message=""
    :confirm-text="title"
    :confirm-loading="saving"
    :confirm-disabled="
      query.phase.value !== 'ready' ||
      !form.reason.trim() ||
      (target?.entity === 'order' && !form.confirmed)
    "
    :danger="target?.action !== 'restore'"
    @update:model-value="!$event && emit('close')"
    @confirm="save"
  >
    <V2AsyncRegion
      skeleton="form"
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      loading-title="正在核对关联记录"
      @retry="query.refresh"
    >
      <template v-if="query.data.value">
        <p>{{ query.data.value.label }}</p>
        <p v-if="target?.entity === 'account'">
          只处理未关联账号，资料与原编号保留；恢复后保持停用，需另行启用。
        </p>
        <p v-else>
          只处理没有真实付款、收款或账务的手工误录单。作废保留全部记录，恢复仅回到待补全。
        </p>
        <p
          v-if="
            form.expectedUpdatedAt && form.expectedUpdatedAt !== query.data.value.expectedUpdatedAt
          "
          class="bank-recharge-error"
          role="alert"
        >
          资料版本已变化，保留原输入；请点击“重新预览并核对”后再次确认。
        </p>
        <el-form
          :model="form"
          label-position="left"
          label-width="88px"
          require-asterisk-position="right"
          @submit.prevent="save"
        >
          <el-form-item label="操作原因" required
            ><el-input v-model="form.reason" type="textarea" maxlength="500" :disabled="saving"
          /></el-form-item>
          <el-form-item v-if="target?.entity === 'order'" label="事实核对" required>
            <el-checkbox v-model="form.confirmed" :disabled="saving"
              >已确认误录，未发生真实付款或收款</el-checkbox
            >
          </el-form-item>
        </el-form>
        <AppButton variant="ghost" :disabled="saving" @click="repreview">重新预览并核对</AppButton>
      </template>
    </V2AsyncRegion>
    <p v-if="error" class="bank-recharge-error" role="alert">{{ error }}</p>
  </V2ConfirmDialog>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery, createV2QueryKey } from '@/v2/composables/useV2Query';
import { getApiErrorMessage } from '@/api/client';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  bankRechargeApi,
  type BankLifecycleEntity,
  type BankLifecycleAction
} from './bank-recharge-api';
const props = defineProps<{
  target: { entity: BankLifecycleEntity; id: string; action: BankLifecycleAction } | null;
}>();
const emit = defineEmits<{ close: []; completed: [] }>();
const saving = ref(false),
  error = ref('');
const draft = useV2FormDraft('bank-recharge/lifecycle', () => ({
  reason: '',
  confirmed: false,
  operationId: '',
  expectedUpdatedAt: '',
  previewFingerprint: ''
}));
const form = draft.form;
const title = computed(() =>
  props.target?.action === 'restore'
    ? '恢复记录'
    : props.target?.action === 'cancel'
      ? '作废误录单'
      : '移入回收站'
);
const query = useV2ModuleQuery({
  moduleKey: 'bank-recharge-orders',
  scope: 'auto-recharge',
  enabled: () => Boolean(props.target),
  key: () => createV2QueryKey({ lifecycle: props.target }),
  query: ({ signal }) =>
    bankRechargeApi.lifecyclePreview(props.target!.entity, props.target!.id, props.target!.action, {
      signal
    })
});
watch(
  () => props.target,
  (target) => {
    error.value = '';
    if (target) {
      draft.open(`${target.entity}:${target.id}:${target.action}`, {
        operationId: crypto.randomUUID()
      });
      void query.refresh();
    }
  },
  { immediate: true }
);
watch(
  () => query.data.value,
  (preview) => {
    const target = props.target;
    if (
      !preview ||
      !target ||
      preview.id !== target.id ||
      preview.action !== target.action ||
      preview.entity !== target.entity
    )
      return;
    if (!form.expectedUpdatedAt) {
      form.expectedUpdatedAt = preview.expectedUpdatedAt;
      form.previewFingerprint = preview.previewFingerprint;
    }
  }
);
function repreview() {
  form.expectedUpdatedAt = '';
  form.previewFingerprint = '';
  form.operationId = crypto.randomUUID();
  form.confirmed = false;
  void query.refresh();
}
async function save() {
  const target = props.target;
  if (!target || saving.value || query.phase.value !== 'ready') return;
  const submitted = { ...form };
  const finish = draft.beginSave();
  saving.value = true;
  error.value = '';
  try {
    await bankRechargeApi.lifecycle(target.entity, target.id, target.action, {
      reason: submitted.reason,
      operationId: submitted.operationId,
      expectedUpdatedAt: submitted.expectedUpdatedAt,
      previewFingerprint: submitted.previewFingerprint,
      ...(target.entity === 'order' ? { confirmNoPaymentOrReceipt: submitted.confirmed } : {})
    });
    finish();
    if (props.target?.id === target.id && props.target?.action === target.action) emit('close');
    emit('completed');
    ElMessage.success('操作已完成');
  } catch (cause) {
    error.value = getApiErrorMessage(cause);
  } finally {
    saving.value = false;
  }
}
</script>
