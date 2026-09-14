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
        <div class="v2-mail-query-panel__code-field">
          <el-input
            v-model="form.queryCode"
            type="text"
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
          <AppButton size="small" variant="soft" @click="pasteQueryCode">从剪贴板粘贴</AppButton>
        </div>
      </el-form-item>
      <el-form-item v-if="!isVendureVirtual" label="返回封数" prop="limit" required>
        <el-input-number
          v-model="form.limit"
          :min="1"
          :max="V2_MAIL_VIEWER_LIMITS.messages"
          :step="1"
          controls-position="right"
        />
      </el-form-item>
      <div v-else class="v2-mail-query-panel__buyer-limit" role="note">
        <strong>买家专属查询</strong>
        <span>为保护虚拟邮箱隐私，固定显示该邮箱最近 5 封邮件。</span>
      </div>
    </el-form>

    <p class="v2-mail-query-panel__privacy" role="note">
      邮件内容仅在本次查询时实时读取，不写入服务器数据库或浏览器持久缓存。
    </p>

    <div class="v2-mail-query-panel__actions">
      <AppButton variant="ghost" @click="clearAll">清空</AppButton>
      <AppButton variant="primary" :loading="loading" @click="queryMail">
        <el-icon><Search /></el-icon>
        查询邮件
      </AppButton>
    </div>

    <div v-if="errorMessage" class="v2-mail-query-panel__error" role="alert">
      <span>{{ errorMessage }}</span>
      <AppButton size="small" variant="soft" @click="retryQuery">重试</AppButton>
    </div>

    <div v-if="result" class="v2-mail-query-panel__refresh-actions">
      <span>结果刷新</span>
      <el-switch v-model="autoRefresh" active-text="每 10 秒自动刷新" />
      <small v-if="autoRefresh">{{ countdown }} 秒后刷新</small>
      <AppButton size="small" variant="soft" :loading="refreshing" @click="refreshMail">
        立即刷新
      </AppButton>
    </div>

    <V2MailMessageList v-if="result" :result="result" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, reactive, ref, watch } from 'vue';
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
import { classifyMailQueryCode, parseMailQueryCode, resolveMailViewerLimit } from './mail-viewer';
import { ElMessage } from '@/v2/services/elementPlusMessage';

const formRef = ref<FormInstance>();
const form = reactive<V2MailViewerQueryInput>({ queryCode: '', limit: 5 });
const result = ref<V2MailViewerQueryResult>();
const errorMessage = ref('');
const loading = ref(false);
const refreshing = ref(false);
const autoRefresh = ref(false);
const countdown = ref(10);
const queryKind = computed(() => classifyMailQueryCode(form.queryCode));
const isVendureVirtual = computed(() => queryKind.value === 'vendure-virtual');
const rules: FormRules<V2MailViewerQueryInput> = {
  queryCode: [
    {
      required: true,
      message: '请输入邮件查询码',
      trigger: 'blur'
    },
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
      required: true,
      message: '请输入返回封数',
      trigger: 'change'
    },
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
let refreshTimer: ReturnType<typeof setInterval> | undefined;

watch(
  () => [form.queryCode, form.limit],
  () => {
    if (!result.value && !errorMessage.value && !activeRequest) return;
    abortActiveRequest();
    autoRefresh.value = false;
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

  await executeQuery(false);
}

async function executeQuery(preserveResult: boolean) {
  const parsed = parseMailQueryCode(form.queryCode);
  abortActiveRequest();
  const controller = new AbortController();
  activeRequest = controller;
  loading.value = !preserveResult;
  refreshing.value = preserveResult;
  errorMessage.value = '';
  if (!preserveResult) result.value = undefined;

  try {
    const response = await idBusinessV2PublicMailboxApi.query(
      { queryCode: parsed.queryCode, limit: resolveMailViewerLimit(parsed.queryCode, form.limit) },
      { signal: controller.signal }
    );
    if (activeRequest !== controller) return;
    result.value = response;
    countdown.value = 10;
  } catch (error) {
    if (activeRequest !== controller || isRequestCanceled(error)) return;
    errorMessage.value = getApiErrorMessage(error);
  } finally {
    if (activeRequest === controller) {
      activeRequest = undefined;
      loading.value = false;
      refreshing.value = false;
    }
  }
}

async function refreshMail() {
  if (!result.value || activeRequest) return;
  await executeQuery(true);
}

function retryQuery() {
  return result.value ? refreshMail() : queryMail();
}

async function pasteQueryCode() {
  try {
    const text = await navigator.clipboard.readText();
    form.queryCode = text.trim();
    await formRef.value?.validateField('queryCode');
    ElMessage.success('查询码已粘贴');
  } catch {
    ElMessage.warning('无法读取剪贴板，请手动粘贴查询码');
  }
}

function abortActiveRequest() {
  activeRequest?.abort();
  activeRequest = undefined;
  loading.value = false;
  refreshing.value = false;
}

async function clearAll() {
  abortActiveRequest();
  form.queryCode = '';
  form.limit = 5;
  result.value = undefined;
  errorMessage.value = '';
  autoRefresh.value = false;
  await nextTick();
  formRef.value?.clearValidate();
}

watch(autoRefresh, (enabled) => {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = undefined;
  countdown.value = 10;
  if (!enabled) return;
  refreshTimer = setInterval(() => {
    if (!result.value || activeRequest) return;
    countdown.value -= 1;
    if (countdown.value > 0) return;
    countdown.value = 10;
    void refreshMail();
  }, 1_000);
});

onBeforeUnmount(() => {
  abortActiveRequest();
  if (refreshTimer) clearInterval(refreshTimer);
});

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

.v2-mail-query-panel__code-field {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}

.v2-mail-query-panel__buyer-limit {
  display: grid;
  gap: 2px;
  margin-left: 104px;
  padding: 10px 12px;
  border: 1px solid var(--v2-border-soft);
  border-radius: 7px;
  background: var(--v2-surface-muted);
}

.v2-mail-query-panel__buyer-limit strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-mail-query-panel__buyer-limit span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mail-query-panel__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-mail-query-panel__privacy {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-mail-query-panel__refresh-actions {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  color: var(--v2-text-soft);
  font-size: 12px;
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

@media (max-width: 560px) {
  .v2-mail-query-panel__code-field {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-mail-query-panel__code-field :deep(.app-button) {
    justify-self: start;
  }

  .v2-mail-query-panel__buyer-limit {
    margin-left: 0;
  }

  .v2-mail-query-panel__refresh-actions {
    flex-wrap: wrap;
    justify-content: flex-start;
  }
}
</style>
