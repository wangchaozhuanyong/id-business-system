<template>
  <div class="v2-mail-query-panel">
    <el-form
      ref="formRef"
      :model="form"
      :rules="rules"
      label-position="left"
      label-width="104px"
      require-asterisk-position="right"
      class="v2-horizontal-form v2-mail-query-panel__form"
      @submit.prevent="queryMail"
    >
      <el-form-item label="邮件查询码" prop="queryCode" required>
        <el-input
          v-model="form.queryCode"
          type="password"
          show-password
          :maxlength="V2_MAIL_VIEWER_LIMITS.credential"
          name="workspace-mail-query-code"
          autocomplete="new-password"
          autocapitalize="off"
          autocorrect="off"
          data-1p-ignore="true"
          data-lpignore="true"
          :spellcheck="false"
          placeholder="请输入邮件查询码"
        />
      </el-form-item>
      <el-form-item label="返回封数" prop="limit" required>
        <el-input-number
          v-model="form.limit"
          :min="1"
          :max="V2_MAIL_VIEWER_LIMITS.messages"
          :step="1"
          controls-position="right"
        />
      </el-form-item>
    </el-form>

    <div class="v2-mail-query-panel__actions">
      <AppButton variant="ghost" @click="clearAll">清空</AppButton>
      <AppButton variant="primary" :loading="loading" @click="queryMail">
        <el-icon><Search /></el-icon>
        查询邮件
      </AppButton>
    </div>

    <div v-if="errorMessage" class="v2-mail-query-panel__error" role="alert">
      <span>{{ errorMessage }}</span>
      <AppButton size="small" variant="soft" @click="queryMail">重试</AppButton>
    </div>

    <V2MailMessageList v-if="result" :result="result" />
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import {
  V2_MAIL_VIEWER_LIMITS,
  type V2MailViewerQueryInput,
  type V2MailViewerQueryResult
} from '@apple-business/shared';
import { Search } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage, isRequestCanceled } from '@/api/client';
import { idBusinessV2PublicMailboxApi } from '@/v2/api/workspace';
import V2MailMessageList from './V2MailMessageList.vue';
import { parseMailQueryCode } from './mail-viewer';

const formRef = ref<FormInstance>();
const form = reactive<V2MailViewerQueryInput>({ queryCode: '', limit: 5 });
const result = ref<V2MailViewerQueryResult>();
const errorMessage = ref('');
const loading = ref(false);
const rules: FormRules<V2MailViewerQueryInput> = {
  queryCode: [
    {
      validator: (_rule, value, callback) => {
        try {
          parseMailQueryCode(String(value ?? ''));
          callback();
        } catch (error) {
          callback(error instanceof Error ? error : new Error('邮件查询码格式不正确'));
        }
      },
      trigger: 'blur'
    }
  ],
  limit: [
    {
      validator: (_rule, value, callback) => {
        if (Number.isInteger(value) && value >= 1 && value <= V2_MAIL_VIEWER_LIMITS.messages) {
          callback();
          return;
        }
        callback(new Error(`返回封数必须为 1 至 ${V2_MAIL_VIEWER_LIMITS.messages} 的整数`));
      },
      trigger: 'change'
    }
  ]
};
let activeRequest: AbortController | undefined;

watch(
  () => [form.queryCode, form.limit],
  () => {
    if (!result.value && !errorMessage.value && !activeRequest) return;
    abortActiveRequest();
    result.value = undefined;
    errorMessage.value = '';
  }
);

async function queryMail() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }

  const parsed = parseMailQueryCode(form.queryCode);
  abortActiveRequest();
  const controller = new AbortController();
  activeRequest = controller;
  loading.value = true;
  errorMessage.value = '';
  result.value = undefined;

  try {
    const response = await idBusinessV2PublicMailboxApi.query(
      { queryCode: parsed.queryCode, limit: form.limit },
      { signal: controller.signal }
    );
    if (activeRequest !== controller) return;
    result.value = response;
  } catch (error) {
    if (activeRequest !== controller || isRequestCanceled(error)) return;
    errorMessage.value = getApiErrorMessage(error);
  } finally {
    if (activeRequest === controller) {
      activeRequest = undefined;
      loading.value = false;
    }
  }
}

function abortActiveRequest() {
  activeRequest?.abort();
  activeRequest = undefined;
  loading.value = false;
}

function clearAll() {
  abortActiveRequest();
  form.queryCode = '';
  form.limit = 5;
  result.value = undefined;
  errorMessage.value = '';
  formRef.value?.clearValidate();
}

defineExpose({
  abortActiveRequest,
  clearAll,
  hasContent: () => Boolean(form.queryCode || result.value || loading.value)
});
</script>

<style scoped>
.v2-mail-query-panel {
  display: grid;
  min-width: 0;
  gap: 18px;
}

.v2-mail-query-panel__form {
  display: grid;
  gap: 16px;
}

.v2-mail-query-panel__form :deep(.el-form-item) {
  margin-bottom: 0;
}

.v2-mail-query-panel__form :deep(.el-input-number) {
  width: min(180px, 100%);
}

.v2-mail-query-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-mail-query-panel__error {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 6px;
  background: var(--v3-danger-soft);
  color: var(--v2-danger);
  font-size: 13px;
}
</style>
