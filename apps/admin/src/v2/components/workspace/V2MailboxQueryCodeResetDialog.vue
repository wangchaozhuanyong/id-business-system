<template>
  <V2ConfirmDialog
    append-to-body
    :model-value="modelValue"
    title="重置查询码"
    message="选择新查询码的有效期"
    width="min(520px, 94vw)"
    :confirm-loading="busy"
    :confirm-visible="!result"
    :confirm-disabled-reason="target ? '' : '请先选择邮箱'"
    confirm-text="确认重置"
    :cancel-text="result ? '完成' : '取消'"
    @update:model-value="$emit('update:modelValue', $event)"
    @confirm="submit"
  >
    <el-form
      v-if="target"
      class="v2-horizontal-form mailbox-query-code-reset-form"
      label-position="left"
      label-width="112px"
      require-asterisk-position="right"
      :disabled="busy"
      @submit.prevent="submit"
    >
      <el-form-item label="邮箱"
        ><span>{{ target.email }}</span></el-form-item
      >
      <el-form-item label="当前到期时间">
        <span>{{ target.expiresAt ? formatV2DateTime(target.expiresAt) : '长期有效' }}</span>
      </el-form-item>
      <template v-if="!result">
        <el-form-item label="新码有效期" required>
          <el-select v-model="draft.form.validityDays" aria-label="新码有效期">
            <el-option
              v-for="option in options"
              :key="option.days"
              :label="option.label"
              :value="option.days"
            />
          </el-select>
        </el-form-item>
        <el-form-item label="预计到期时间">
          <span>{{ preview ? formatV2DateTime(preview) : '长期有效' }}</span>
        </el-form-item>
        <p role="note">从重置成功时重新计时。旧查询码将立即失效，请将新码重新交付买家。</p>
      </template>
      <template v-else>
        <p role="status">查询码已重置，旧码已失效。</p>
        <el-form-item label="新查询码"
          ><code>{{ result.queryCode }}</code></el-form-item
        >
        <el-form-item label="新到期时间">
          <span>{{ result.expiresAt ? formatV2DateTime(result.expiresAt) : '长期有效' }}</span>
        </el-form-item>
        <AppButton variant="soft" @click="copyResult">复制查询码</AppButton>
      </template>
      <p v-if="error" role="alert">{{ error }}</p>
    </el-form>
  </V2ConfirmDialog>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2ConfirmDialog from '@/v2/components/V2ConfirmDialog.vue';
import { useV2FormDraft } from '@/v2/composables/useV2SessionDraft';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import {
  mailboxQueryCodeValidityOptions,
  previewMailboxQueryCodeExpiry,
  type MailboxQueryCodeResetTarget,
  type MailboxQueryCodeResetResult
} from './mailboxQueryCodeValidity';

const props = defineProps<{
  modelValue: boolean;
  target: MailboxQueryCodeResetTarget | null;
  busy: boolean;
  error: string;
  result: MailboxQueryCodeResetResult | null;
}>();
const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  submit: [validityDays: number, completeDraft: () => boolean];
}>();
const draft = useV2FormDraft('mailbox-query-code-reset', () => ({ validityDays: 30 }));
const issuedAt = ref(0);
const preview = computed(() =>
  previewMailboxQueryCodeExpiry(issuedAt.value, draft.form.validityDays)
);
const options = computed(() => {
  const current = props.target?.validityDays;
  return current !== undefined &&
    !mailboxQueryCodeValidityOptions.some((option) => option.days === current)
    ? [
        ...mailboxQueryCodeValidityOptions,
        { days: current, label: current ? `当前周期（${current}天）` : '当前周期（长期有效）' }
      ]
    : mailboxQueryCodeValidityOptions;
});
watch(
  () => [props.modelValue, props.target?.key] as const,
  () => {
    if (!props.modelValue || !props.target) return;
    issuedAt.value = getV2BusinessNowMs() ?? Date.now();
    draft.open(props.target.key, { validityDays: props.target.validityDays });
  },
  { immediate: true }
);
function submit() {
  if (props.busy || props.result || !props.target) return;
  emit('submit', draft.form.validityDays, draft.beginSave());
}
async function copyResult() {
  if (!props.result) return;
  try {
    await navigator.clipboard.writeText(props.result.queryCode);
    ElMessage.success('查询码已复制');
  } catch {
    ElMessage.error('无法自动复制，请手动选择查询码复制');
  }
}
</script>

<style scoped>
.mailbox-query-code-reset-form :deep(.el-form-item__content) {
  min-width: 0;
  overflow-wrap: anywhere;
}
.mailbox-query-code-reset-form code {
  user-select: all;
}
</style>
