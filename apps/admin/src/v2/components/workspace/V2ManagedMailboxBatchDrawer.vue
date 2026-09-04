<template>
  <el-drawer
    class="v2-mailbox-batch-drawer"
    :model-value="modelValue"
    title="批量导入邮箱池"
    size="min(560px, 100vw)"
    append-to-body
    destroy-on-close
    :before-close="handleBeforeClose"
    @close="$emit('update:modelValue', false)"
    @closed="clearAll"
  >
    <template #header="{ titleId, titleClass }">
      <div class="v2-mailbox-batch-drawer__heading">
        <span :id="titleId" :class="titleClass">批量导入邮箱池</span>
        <FeatureHelp
          title="批量导入说明"
          :text="batchHelp"
          :links="appPasswordHelpLinks"
          placement="bottom"
          :width="380"
        />
      </div>
    </template>
    <div class="v2-mailbox-batch-drawer__body">
      <el-form
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        class="v2-horizontal-form"
        @submit.prevent="submit"
      >
        <el-form-item label="邮箱类型" required>
          <el-radio-group v-model="provider" :disabled="submitting">
            <el-radio-button value="gmail">谷歌邮箱</el-radio-button>
            <el-radio-button value="icloud">苹果邮箱</el-radio-button>
            <el-radio-button value="microsoft">微软邮箱</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="邮箱数据" required>
          <el-input
            v-model="batchText"
            type="textarea"
            :rows="12"
            :maxlength="V2_MAIL_VIEWER_LIMITS.batchLength"
            show-word-limit
            resize="vertical"
            autocomplete="off"
            :spellcheck="false"
            :disabled="submitting"
            :placeholder="batchPlaceholder"
          />
        </el-form-item>
      </el-form>

      <div v-if="result" class="v2-mailbox-batch-drawer__result" aria-live="polite">
        <strong>成功 {{ result.succeeded }} 个，失败 {{ result.failed }} 个</strong>
        <ul v-if="failedItems.length">
          <li v-for="item in failedItems" :key="`${item.index}-${item.email}`">
            <span>第 {{ item.index + 1 }} 行 · {{ item.email }}</span>
            <small>{{ item.message }}</small>
          </li>
        </ul>
      </div>

      <footer>
        <span>
          {{
            provider === 'microsoft' && activeMicrosoftIndex > 0
              ? `正在授权第 ${activeMicrosoftIndex} / ${parsedRows.length} 个`
              : `已识别 ${parsedRows.length} 行`
          }}
        </span>
        <div>
          <AppButton variant="ghost" @click="requestClose">取消</AppButton>
          <AppButton variant="primary" :loading="submitting" @click="submit">
            {{ provider === 'microsoft' ? '逐个授权并导入' : '导入邮箱池' }}
          </AppButton>
        </div>
      </footer>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, onBeforeUnmount, ref } from 'vue';
import type {
  CreateV2ManagedMailboxBatchResult,
  V2MailProvider,
  V2ManagedMailboxBatchResultItem,
  V2MicrosoftMailboxAuthorizationStatus
} from '@apple-business/shared';
import { V2_MAIL_VIEWER_LIMITS } from '@apple-business/shared';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import {
  resolveManagedMailboxAppPasswordGuide,
  resolveManagedMailboxAppPasswordGuideLinks
} from './managedMailboxAppPasswordGuide';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  imported: [];
  'update:modelValue': [value: boolean];
}>();

const provider = ref<V2MailProvider>('gmail');
const batchText = ref('');
const submitting = ref(false);
const activeMicrosoftIndex = ref(0);
const result = ref<CreateV2ManagedMailboxBatchResult | null>(null);
let microsoftAuthorizationGeneration = 0;
let microsoftAuthorizationPopup: Window | null = null;
const parsedRows = computed(() =>
  batchText.value
    .split(/\r?\n/)
    .map((source, index) => ({ index, source: source.trim() }))
    .filter((row) => row.source)
);
const failedItems = computed<V2ManagedMailboxBatchResultItem[]>(
  () => result.value?.items.filter((item) => item.status === 'failed') ?? []
);
const formatHelp = computed(() =>
  provider.value === 'microsoft'
    ? '格式：邮箱地址----备注（备注可省略）。系统会复用同一个 Microsoft 窗口逐个完成 OAuth2 授权，每次最多 20 个。'
    : '格式：邮箱地址----应用专用密码----备注（备注可省略），每次最多 20 个。'
);
const batchHelp = computed(() => {
  if (provider.value === 'microsoft') {
    return [formatHelp.value, '每个邮箱仍需管理员在 Microsoft 登录窗口选择对应账号并确认授权。'];
  }
  const guide = resolveManagedMailboxAppPasswordGuide(provider.value);
  return [formatHelp.value, guide?.help ?? ''];
});
const appPasswordHelpLinks = computed(() =>
  resolveManagedMailboxAppPasswordGuideLinks(provider.value)
);
const batchPlaceholder = computed(() =>
  provider.value === 'microsoft'
    ? 'seller01@outlook.com----客户 A\nseller02@hotmail.com----客户 B'
    : 'seller01@gmail.com----应用专用密码----客户 A\nseller02@gmail.com----应用专用密码----客户 B'
);

onBeforeUnmount(() => {
  microsoftAuthorizationGeneration += 1;
  microsoftAuthorizationPopup?.close();
});

async function submit() {
  if (!parsedRows.value.length) {
    ElMessage.warning('请粘贴需要导入的邮箱数据');
    return;
  }
  if (parsedRows.value.length > V2_MAIL_VIEWER_LIMITS.batchLines) {
    ElMessage.warning(`每次最多导入 ${V2_MAIL_VIEWER_LIMITS.batchLines} 个邮箱`);
    return;
  }

  if (provider.value === 'microsoft') {
    await submitMicrosoftMailboxes();
    return;
  }

  const items = [];
  for (const row of parsedRows.value) {
    const [email = '', appPassword = '', ...labelParts] = row.source.split('----');
    if (!email.trim() || !appPassword.trim()) {
      ElMessage.warning(`第 ${row.index + 1} 行格式不完整`);
      return;
    }
    items.push({
      email: email.trim(),
      provider: provider.value,
      appPassword: appPassword.trim(),
      label: labelParts.join('----').trim() || undefined
    });
  }

  submitting.value = true;
  try {
    result.value = await idBusinessV2WorkspaceApi.createManagedMailboxBatch({ items });
    const failedIndexes = new Set(
      result.value.items.filter((item) => item.status === 'failed').map((item) => item.index)
    );
    batchText.value = parsedRows.value
      .filter((row) => failedIndexes.has(row.index))
      .map((row) => row.source)
      .join('\n');
    emit('imported');
    if (result.value.failed) ElMessage.warning('部分邮箱导入失败，请根据结果修正后重试');
    else ElMessage.success('邮箱已批量导入');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    submitting.value = false;
  }
}

async function submitMicrosoftMailboxes() {
  const inputs = [];
  for (const row of parsedRows.value) {
    const [email = '', ...labelParts] = row.source.split('----');
    if (!email.trim()) {
      ElMessage.warning(`第 ${row.index + 1} 行缺少邮箱地址`);
      return;
    }
    inputs.push({
      email: email.trim(),
      index: row.index,
      label: labelParts.join('----').trim() || undefined,
      source: row.source
    });
  }

  const popup = window.open('about:blank', '_blank', 'popup,width=560,height=760');
  if (!popup) {
    ElMessage.error('浏览器阻止了授权窗口，请允许弹窗后重试');
    return;
  }
  popup.opener = null;
  microsoftAuthorizationPopup = popup;
  const generation = ++microsoftAuthorizationGeneration;
  const results: V2ManagedMailboxBatchResultItem[] = [];
  submitting.value = true;

  try {
    for (const [position, input] of inputs.entries()) {
      if (generation !== microsoftAuthorizationGeneration || popup.closed) break;
      activeMicrosoftIndex.value = position + 1;
      try {
        const authorization = await idBusinessV2WorkspaceApi.startMicrosoftMailboxAuthorization({
          email: input.email,
          label: input.label
        });
        popup.location.assign(authorization.authorizationUrl);
        const status = await pollMicrosoftAuthorization(
          authorization.authorizationId,
          Date.parse(authorization.expiresAt),
          generation,
          popup
        );
        if (!status || status.status !== 'succeeded') {
          results.push({
            email: input.email,
            index: input.index,
            message: status?.failureMessage || '未完成 Microsoft 授权',
            status: 'failed'
          });
        } else {
          results.push({ email: input.email, index: input.index, status: 'succeeded' });
        }
      } catch (error) {
        results.push({
          email: input.email,
          index: input.index,
          message: getApiErrorMessage(error),
          status: 'failed'
        });
      }
      result.value = summarizeResults(results, results.length);
    }

    const attemptedIndexes = new Set(results.map((item) => item.index));
    for (const input of inputs) {
      if (!attemptedIndexes.has(input.index)) {
        results.push({
          email: input.email,
          index: input.index,
          message: '授权流程已取消',
          status: 'failed'
        });
      }
    }
    result.value = summarizeResults(results, inputs.length);
    const failedIndexes = new Set(
      results.filter((item) => item.status === 'failed').map((item) => item.index)
    );
    batchText.value = inputs
      .filter((input) => failedIndexes.has(input.index))
      .map((input) => input.source)
      .join('\n');
    if (result.value.succeeded > 0) emit('imported');
    if (result.value.failed) ElMessage.warning('部分 Microsoft 邮箱未完成授权，请重试保留行');
    else ElMessage.success('Microsoft 邮箱已逐个授权并导入');
  } finally {
    submitting.value = false;
    activeMicrosoftIndex.value = 0;
    if (!popup.closed) popup.close();
    if (microsoftAuthorizationPopup === popup) microsoftAuthorizationPopup = null;
  }
}

async function pollMicrosoftAuthorization(
  authorizationId: string,
  expiresAt: number,
  generation: number,
  popup: Window
): Promise<V2MicrosoftMailboxAuthorizationStatus | null> {
  while (
    generation === microsoftAuthorizationGeneration &&
    !popup.closed &&
    Date.now() < expiresAt + 2_000
  ) {
    const status =
      await idBusinessV2WorkspaceApi.getMicrosoftMailboxAuthorizationStatus(authorizationId);
    if (status.status !== 'pending') return status;
    await new Promise((resolve) => window.setTimeout(resolve, 1_200));
  }
  return null;
}

function summarizeResults(items: V2ManagedMailboxBatchResultItem[], total: number) {
  const succeeded = items.filter((item) => item.status === 'succeeded').length;
  return {
    failed: total - succeeded,
    items: [...items],
    succeeded,
    total
  } satisfies CreateV2ManagedMailboxBatchResult;
}

async function handleBeforeClose(done: () => void) {
  if (!batchText.value.trim() && !submitting.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm(
      submitting.value
        ? '关闭后会终止当前 Microsoft 批量授权，并清空尚未导入的数据。'
        : '关闭后会清空尚未导入的邮箱数据。',
      '清空并关闭',
      {
        confirmButtonText: submitting.value ? '终止并关闭' : '清空并关闭',
        cancelButtonText: '继续录入',
        type: 'warning'
      }
    );
    microsoftAuthorizationGeneration += 1;
    microsoftAuthorizationPopup?.close();
    done();
  } catch {
    // 用户选择继续录入。
  }
}

function requestClose() {
  void handleBeforeClose(() => emit('update:modelValue', false));
}

function clearAll() {
  provider.value = 'gmail';
  batchText.value = '';
  result.value = null;
  activeMicrosoftIndex.value = 0;
  microsoftAuthorizationGeneration += 1;
  microsoftAuthorizationPopup?.close();
  microsoftAuthorizationPopup = null;
}
</script>

<style>
.v2-mailbox-batch-drawer .el-drawer__body {
  padding: 0;
}

.v2-mailbox-batch-drawer__body {
  display: grid;
  gap: 16px;
  padding: 18px;
}

.v2-mailbox-batch-drawer__heading {
  display: inline-flex;
  min-width: 0;
  align-items: center;
  gap: 2px;
}

.v2-mailbox-batch-drawer__result {
  display: grid;
  gap: 3px;
  padding: 12px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
}

.v2-mailbox-batch-drawer__result strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-mailbox-batch-drawer__result span,
.v2-mailbox-batch-drawer__result small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-mailbox-batch-drawer__result ul {
  display: grid;
  gap: 8px;
  margin: 7px 0 0;
  padding: 0;
  list-style: none;
}

.v2-mailbox-batch-drawer__result li {
  display: grid;
}

.v2-mailbox-batch-drawer__body > footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mailbox-batch-drawer__body > footer > div {
  display: flex;
  gap: 8px;
}

@media (max-width: 560px) {
  .v2-mailbox-batch-drawer__body > footer {
    align-items: stretch;
    flex-direction: column;
  }

  .v2-mailbox-batch-drawer__body > footer > div {
    justify-content: flex-end;
  }
}
</style>
