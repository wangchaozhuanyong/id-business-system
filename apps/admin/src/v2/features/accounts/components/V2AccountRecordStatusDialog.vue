<template>
  <el-dialog
    v-model="page.recordStatusDialogVisible"
    :title="dialogTitle"
    width="min(500px, 92vw)"
    destroy-on-close
    :close-on-click-modal="!page.recordStatusSubmitting"
    :close-on-press-escape="!page.recordStatusSubmitting"
    :show-close="!page.recordStatusSubmitting"
  >
    <div v-if="page.recordStatusDialogMode === 'view'" class="v2-account-status-detail">
      <div>
        <span>ID 账号</span>
        <strong>{{ page.recordStatusTarget?.appleIdMasked }}</strong>
      </div>
      <div>
        <span>停用原因</span>
        <strong>{{ page.recordStatusTarget?.disabledReason || '历史记录未填写原因' }}</strong>
      </div>
      <div>
        <span>停用时间</span>
        <strong>{{ disabledAtText }}</strong>
      </div>
    </div>

    <el-form
      v-else
      ref="formRef"
      class="v2-horizontal-form"
      :model="formModel"
      :rules="rules"
      label-position="left"
      label-width="92px"
      require-asterisk-position="right"
      status-icon
    >
      <el-form-item label="ID 账号">
        <span>{{ page.recordStatusTarget?.appleIdMasked }}</span>
      </el-form-item>
      <el-form-item
        :label="page.targetRecordStatus === 'disabled' ? '停用原因' : '启用原因'"
        prop="reason"
      >
        <el-input
          v-model="page.recordStatusReason"
          type="textarea"
          :rows="4"
          maxlength="200"
          show-word-limit
          :placeholder="
            page.targetRecordStatus === 'disabled'
              ? '说明为什么暂停使用该 ID'
              : '说明本次恢复启用的核对结果'
          "
        />
      </el-form-item>
    </el-form>

    <template #footer>
      <AppButton variant="ghost" :disabled="page.recordStatusSubmitting" @click="closeDialog">
        {{ page.recordStatusDialogMode === 'view' ? '关闭' : '取消' }}
      </AppButton>
      <AppButton
        v-if="page.recordStatusDialogMode === 'change'"
        :variant="page.targetRecordStatus === 'disabled' ? 'danger' : 'primary'"
        :loading="page.recordStatusSubmitting"
        @click="confirmChange"
      >
        {{ page.targetRecordStatus === 'disabled' ? '确认停用' : '确认启用' }}
      </AppButton>
    </template>
  </el-dialog>
</template>

<script setup lang="ts">
import { computed, ref, type UnwrapNestedRefs } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { validateV2Form } from '@/v2/utils/formValidation';
import type { useAccountsPage } from '../useAccountsPage';

type AccountsPage = UnwrapNestedRefs<ReturnType<typeof useAccountsPage>>;

const props = defineProps<{ page: AccountsPage }>();
const formRef = ref<FormInstance>();
const formModel = computed(() => ({ reason: props.page.recordStatusReason }));
const rules: FormRules = {
  reason: [
    {
      required: true,
      validator: (_rule, value, callback) => {
        const length = String(value ?? '').trim().length;
        callback(
          length >= 2 && length <= 200 ? undefined : new Error('原因必须为 2 至 200 个字符')
        );
      },
      trigger: 'blur'
    }
  ]
};

const dialogTitle = computed(() => {
  if (props.page.recordStatusDialogMode === 'view') return '停用资料';
  return props.page.targetRecordStatus === 'disabled' ? '停用 ID' : '恢复启用 ID';
});

const disabledAtText = computed(() => {
  const value = props.page.recordStatusTarget?.disabledAt;
  return value
    ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(
        new Date(value)
      )
    : '—';
});

function closeDialog() {
  if (!props.page.recordStatusSubmitting) props.page.recordStatusDialogVisible = false;
}

async function confirmChange() {
  if (!(await validateV2Form(formRef.value))) return;
  await props.page.confirmRecordStatusChange();
}
</script>

<style scoped>
.v2-account-status-detail {
  display: grid;
  gap: 10px;
}

.v2-account-status-detail > div {
  display: grid;
  grid-template-columns: 92px minmax(0, 1fr);
  gap: 12px;
  padding: 10px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-account-status-detail span {
  color: var(--v2-text-soft);
}

.v2-account-status-detail strong {
  overflow-wrap: anywhere;
  color: var(--v2-text);
  font-weight: 500;
}
</style>
