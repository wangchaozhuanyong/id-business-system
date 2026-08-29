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
    <div class="v2-mailbox-batch-drawer__body">
      <div class="v2-mailbox-batch-drawer__notice" role="note">
        <strong>每行录入一个邮箱</strong>
        <span>格式：邮箱地址----应用专用密码----备注（备注可省略），每次最多 20 个。</span>
      </div>

      <el-form
        label-position="left"
        label-width="88px"
        require-asterisk-position="right"
        class="v2-horizontal-form"
        @submit.prevent="submit"
      >
        <el-form-item label="邮箱类型" required>
          <el-radio-group v-model="provider">
            <el-radio-button value="gmail">谷歌邮箱</el-radio-button>
            <el-radio-button value="icloud">苹果邮箱</el-radio-button>
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
            placeholder="seller01@gmail.com----应用专用密码----客户 A&#10;seller02@gmail.com----应用专用密码----客户 B"
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
        <span>已识别 {{ parsedRows.length }} 行</span>
        <div>
          <AppButton variant="ghost" @click="$emit('update:modelValue', false)">取消</AppButton>
          <AppButton variant="primary" :loading="submitting" @click="submit">
            导入邮箱池
          </AppButton>
        </div>
      </footer>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, ref } from 'vue';
import type {
  CreateV2ManagedMailboxBatchResult,
  V2ManagedMailboxBatchResultItem,
  V2PasswordMailProvider
} from '@apple-business/shared';
import { V2_MAIL_VIEWER_LIMITS } from '@apple-business/shared';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import { ElMessage } from '@/v2/services/elementPlusMessage';

defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{
  imported: [];
  'update:modelValue': [value: boolean];
}>();

const provider = ref<V2PasswordMailProvider>('gmail');
const batchText = ref('');
const submitting = ref(false);
const result = ref<CreateV2ManagedMailboxBatchResult | null>(null);
const parsedRows = computed(() =>
  batchText.value
    .split(/\r?\n/)
    .map((source, index) => ({ index, source: source.trim() }))
    .filter((row) => row.source)
);
const failedItems = computed<V2ManagedMailboxBatchResultItem[]>(
  () => result.value?.items.filter((item) => item.status === 'failed') ?? []
);

async function submit() {
  if (!parsedRows.value.length) {
    ElMessage.warning('请粘贴需要导入的邮箱数据');
    return;
  }
  if (parsedRows.value.length > V2_MAIL_VIEWER_LIMITS.batchLines) {
    ElMessage.warning(`每次最多导入 ${V2_MAIL_VIEWER_LIMITS.batchLines} 个邮箱`);
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
      .filter((_, index) => failedIndexes.has(index))
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

async function handleBeforeClose(done: () => void) {
  if (!batchText.value.trim()) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('关闭后会清空尚未导入的邮箱数据。', '清空并关闭', {
      confirmButtonText: '清空并关闭',
      cancelButtonText: '继续录入',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续录入。
  }
}

function clearAll() {
  provider.value = 'gmail';
  batchText.value = '';
  result.value = null;
}
</script>

<style>
.v2-mailbox-batch-drawer .el-drawer__body {
  padding: 0;
}

.v2-mailbox-batch-drawer__body {
  display: grid;
  gap: 18px;
  padding: 18px;
}

.v2-mailbox-batch-drawer__notice,
.v2-mailbox-batch-drawer__result {
  display: grid;
  gap: 3px;
  padding: 12px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
}

.v2-mailbox-batch-drawer__notice strong,
.v2-mailbox-batch-drawer__result strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-mailbox-batch-drawer__notice span,
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
