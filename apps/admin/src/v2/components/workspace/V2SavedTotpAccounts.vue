<template>
  <section class="v2-saved-totp" aria-labelledby="v2-saved-totp-title">
    <header class="v2-saved-totp__header">
      <div>
        <strong id="v2-saved-totp-title">
          已保存账号
          <span>{{ items.length }} / {{ V2_SAVED_TOTP_ACCOUNT_LIMITS.count }}</span>
        </strong>
        <span>密钥加密保存在服务器，同一账号换电脑仍可使用。</span>
      </div>
      <AppButton
        variant="primary"
        size="small"
        :disabled="!authStore.writesAllowed || accountLimitReached"
        @click="startCreate"
      >
        <el-icon><Plus /></el-icon>
        添加账号
      </AppButton>
    </header>

    <p v-if="!authStore.writesAllowed" class="v2-saved-totp__readonly" role="status">
      当前登录连接处于只读状态，恢复后才能修改已保存账号。
    </p>

    <el-input
      v-model="searchQuery"
      class="v2-saved-totp__search"
      clearable
      :prefix-icon="Search"
      placeholder="搜索账号名称或签发方"
      aria-label="搜索已保存的 2FA 账号"
    />

    <V2AsyncRegion
      :phase="accountsQuery.phase.value"
      :empty="items.length === 0"
      :error="listError"
      variant="section"
      skeleton="cards"
      loading-title="正在读取已保存账号"
      refreshing-title="正在更新动态验证码"
      empty-title="还没有已保存账号"
      empty-message="添加后无需重复粘贴密钥，可直接复制当前验证码。"
      error-title="已保存账号加载失败"
      @retry="accountsQuery.refresh"
    >
      <template #empty-action>
        <AppButton
          v-if="authStore.writesAllowed"
          variant="primary"
          size="small"
          @click="startCreate"
        >
          添加第一个账号
        </AppButton>
      </template>

      <div v-if="filteredItems.length === 0" class="v2-saved-totp__no-match" role="status">
        <strong>没有匹配的账号</strong>
        <span>请更换搜索关键词。</span>
      </div>

      <ul v-else class="v2-saved-totp__list" aria-label="已保存的 2FA 账号">
        <li v-for="item in paginatedItems" :key="item.id" class="v2-saved-totp-card">
          <div class="v2-saved-totp-card__heading">
            <div class="v2-saved-totp-card__identity">
              <strong>{{ item.name }}</strong>
              <span>{{ accountMeta(item) }}</span>
            </div>
            <span
              class="v2-saved-totp-card__countdown"
              :class="{ 'is-expiring': timingFor(item).remainingSeconds <= 5 }"
            >
              {{ timingFor(item).remainingSeconds }} 秒后刷新
            </span>
          </div>

          <div class="v2-saved-totp-card__details">
            <output class="v2-saved-totp-card__token" :aria-label="`${item.name}，当前验证码`">
              {{ formatToken(item.token) }}
            </output>
            <span class="v2-saved-totp-card__updated">
              更新于 {{ formatUpdatedAt(item.updatedAt) }}
            </span>
            <div class="v2-saved-totp-card__controls">
              <AppButton
                variant="success"
                size="small"
                class="v2-saved-totp-card__copy"
                :aria-label="`复制${item.name}的当前验证码`"
                @click="copyCode(item)"
              >
                <el-icon><CopyDocument /></el-icon>
                {{ copiedAccountId === item.id ? '已复制' : '复制' }}
              </AppButton>
              <AppButton
                variant="ghost"
                size="small"
                :disabled="!authStore.writesAllowed || Boolean(removingId)"
                @click="startEdit(item)"
              >
                <el-icon><EditPen /></el-icon>
                编辑
              </AppButton>
              <AppButton
                variant="ghost"
                size="small"
                :loading="removingId === item.id"
                :disabled="!authStore.writesAllowed || Boolean(removingId)"
                @click="removeAccount(item)"
              >
                <el-icon><Delete /></el-icon>
                删除
              </AppButton>
            </div>
          </div>

          <div
            class="v2-saved-totp-card__progress"
            :class="{ 'is-expiring': timingFor(item).remainingSeconds <= 5 }"
            role="progressbar"
            aria-label="验证码剩余有效时间"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-valuenow="Math.round(timingFor(item).progress)"
          >
            <span :style="{ width: `${timingFor(item).progress}%` }" />
          </div>
        </li>
      </ul>

      <el-pagination
        v-if="filteredItems.length > SAVED_TOTP_PAGE_SIZE"
        v-model:current-page="currentPage"
        class="v2-saved-totp__pagination"
        :page-size="SAVED_TOTP_PAGE_SIZE"
        :pager-count="5"
        :total="filteredItems.length"
        layout="prev, pager, next"
        size="small"
        background
        aria-label="已保存账号分页"
      />
    </V2AsyncRegion>

    <el-dialog
      v-model="editorVisible"
      class="v2-saved-totp-editor"
      :title="editorMode === 'create' ? '添加 2FA 账号' : '编辑 2FA 账号'"
      width="min(520px, calc(100vw - 32px))"
      append-to-body
      destroy-on-close
      :close-on-click-modal="!saving"
      :close-on-press-escape="!saving"
      :show-close="!saving"
      :before-close="handleEditorBeforeClose"
      @closed="resetEditor"
    >
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="92px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-saved-totp-editor__form"
        @submit.prevent="submitEditor"
      >
        <el-form-item label="账号名称" prop="name" required>
          <el-input
            v-model="form.name"
            :maxlength="V2_SAVED_TOTP_ACCOUNT_LIMITS.name"
            show-word-limit
            autocomplete="off"
            placeholder="例如：公司 GitHub"
          />
        </el-form-item>
        <el-form-item label="2FA 密钥" prop="secret" :required="editorMode === 'create'">
          <div class="v2-saved-totp-editor__secret">
            <el-input
              v-model="form.secret"
              type="password"
              show-password
              :maxlength="V2_SAVED_TOTP_ACCOUNT_LIMITS.secret"
              autocomplete="new-password"
              autocapitalize="off"
              autocorrect="off"
              data-1p-ignore="true"
              data-lpignore="true"
              :spellcheck="false"
              :placeholder="
                editorMode === 'create' ? '粘贴 Base32 密钥或 otpauth URI' : '留空表示不更换密钥'
              "
              @keydown.enter.prevent="submitEditor"
            />
            <p>
              {{
                editorMode === 'create'
                  ? '密钥会在服务端加密，保存后不能查看。'
                  : '如需换绑，粘贴新密钥；原密钥不会回显。'
              }}
            </p>
          </div>
        </el-form-item>
      </el-form>
      <p v-if="mutationError" class="v2-saved-totp-editor__error" role="alert">
        {{ mutationError }}
      </p>
      <template #footer>
        <AppButton variant="ghost" :disabled="saving" @click="requestCloseEditor">取消</AppButton>
        <AppButton variant="primary" :loading="saving" @click="submitEditor">
          {{ editorMode === 'create' ? '加密并保存' : '保存修改' }}
        </AppButton>
      </template>
    </el-dialog>
  </section>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules } from 'element-plus';
import type { V2SavedTotpAccount, V2SavedTotpAccountList } from '@apple-business/shared';
import { V2_SAVED_TOTP_ACCOUNT_LIMITS } from '@apple-business/shared';
import { CopyDocument, Delete, EditPen, Plus, Search } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { validateV2Form } from '@/v2/utils/formValidation';

interface SavedTotpForm {
  name: string;
  secret: string;
}

interface AccountTiming {
  progress: number;
  remainingSeconds: number;
}

const SAVED_TOTP_PAGE_SIZE = 8;

const props = defineProps<{ active: boolean }>();
const authStore = useAuthStore();
const formRef = ref<FormInstance>();
const searchQuery = ref('');
const currentPage = ref(1);
const copiedAccountId = ref('');
const editorVisible = ref(false);
const editorMode = ref<'create' | 'edit'>('create');
const editingId = ref('');
const editorSnapshot = ref('');
const saving = ref(false);
const removingId = ref('');
const mutationError = ref('');
const clockTick = ref(Date.now());
const form = reactive<SavedTotpForm>({ name: '', secret: '' });
const rules: FormRules<SavedTotpForm> = {
  name: [
    { required: true, message: '请输入账号名称', trigger: 'blur' },
    {
      max: V2_SAVED_TOTP_ACCOUNT_LIMITS.name,
      message: `账号名称最多 ${V2_SAVED_TOTP_ACCOUNT_LIMITS.name} 个字符`,
      trigger: 'blur'
    }
  ],
  secret: [
    {
      validator: (_rule, value: string, callback) => {
        if (editorMode.value === 'create' && !value.trim()) {
          callback(new Error('请输入 2FA 密钥'));
          return;
        }
        callback();
      },
      trigger: 'blur'
    }
  ]
};

const accountsQuery = useV2ModuleQuery<V2SavedTotpAccountList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'saved-totp-accounts',
  enabled: () => props.active,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.listTotpAccounts({ signal }),
  getRevalidateAt: (data) => {
    const deadlines = data.items
      .map((item) => Date.parse(item.expiresAt))
      .filter((value) => Number.isFinite(value));
    if (!deadlines.length) return null;
    const businessNow = getV2BusinessNowMs() ?? Date.now();
    return Date.now() + Math.max(0, Math.min(...deadlines) - businessNow) + 80;
  }
});
const items = computed(() => accountsQuery.data.value?.items ?? []);
const filteredItems = computed(() => {
  const query = searchQuery.value.trim().toLocaleLowerCase('zh-CN');
  if (!query) return items.value;
  return items.value.filter((item) =>
    [item.name, item.issuer ?? ''].some((value) => value.toLocaleLowerCase('zh-CN').includes(query))
  );
});
const paginatedItems = computed(() => {
  const start = (currentPage.value - 1) * SAVED_TOTP_PAGE_SIZE;
  return filteredItems.value.slice(start, start + SAVED_TOTP_PAGE_SIZE);
});
const listError = computed(() =>
  accountsQuery.error.value ? getApiErrorMessage(accountsQuery.error.value) : ''
);
const accountLimitReached = computed(
  () => items.value.length >= V2_SAVED_TOTP_ACCOUNT_LIMITS.count
);
const editorDirty = computed(
  () => editorVisible.value && JSON.stringify(form) !== editorSnapshot.value
);
let tickTimer: ReturnType<typeof setInterval> | undefined;
let copyFeedbackTimer: ReturnType<typeof setTimeout> | undefined;

watch(searchQuery, () => {
  currentPage.value = 1;
});

watch(
  () => filteredItems.value.length,
  (total) => {
    const lastPage = Math.max(1, Math.ceil(total / SAVED_TOTP_PAGE_SIZE));
    currentPage.value = Math.min(currentPage.value, lastPage);
  }
);

onMounted(() => {
  tickTimer = setInterval(() => {
    clockTick.value = getV2BusinessNowMs() ?? Date.now();
  }, 250);
});

onBeforeUnmount(() => {
  if (tickTimer) clearInterval(tickTimer);
  if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
  form.secret = '';
});

function startCreate() {
  if (!authStore.writesAllowed || accountLimitReached.value) return;
  editorMode.value = 'create';
  editingId.value = '';
  Object.assign(form, { name: '', secret: '' });
  editorSnapshot.value = JSON.stringify(form);
  mutationError.value = '';
  editorVisible.value = true;
}

function startEdit(item: V2SavedTotpAccount) {
  if (!authStore.writesAllowed) return;
  editorMode.value = 'edit';
  editingId.value = item.id;
  Object.assign(form, { name: item.name, secret: '' });
  editorSnapshot.value = JSON.stringify(form);
  mutationError.value = '';
  editorVisible.value = true;
}

function resetEditor() {
  editorVisible.value = false;
  editorMode.value = 'create';
  editingId.value = '';
  Object.assign(form, { name: '', secret: '' });
  editorSnapshot.value = '';
  mutationError.value = '';
  formRef.value?.clearValidate();
}

async function submitEditor() {
  if (!authStore.writesAllowed || saving.value || !(await validateV2Form(formRef.value))) return;
  saving.value = true;
  mutationError.value = '';
  try {
    if (editorMode.value === 'edit') {
      await idBusinessV2WorkspaceApi.updateTotpAccount(editingId.value, {
        name: form.name.trim(),
        ...(form.secret.trim() ? { secret: form.secret.trim() } : {})
      });
      ElMessage.success('2FA 账号已保存');
    } else {
      await idBusinessV2WorkspaceApi.createTotpAccount({
        name: form.name.trim(),
        secret: form.secret.trim()
      });
      ElMessage.success('2FA 账号已添加');
    }
    resetEditor();
    await accountsQuery.refresh();
  } catch (error) {
    mutationError.value = getApiErrorMessage(error);
  } finally {
    saving.value = false;
  }
}

async function removeAccount(item: V2SavedTotpAccount) {
  try {
    await ElMessageBox.confirm(
      `确认删除 2FA 账号“${item.name}”吗？删除后无法恢复。`,
      '删除 2FA 账号',
      {
        confirmButtonText: '确认删除',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );
  } catch {
    return;
  }

  removingId.value = item.id;
  try {
    await idBusinessV2WorkspaceApi.removeTotpAccount(item.id);
    ElMessage.success('2FA 账号已删除');
    if (editingId.value === item.id) resetEditor();
    await accountsQuery.refresh();
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    removingId.value = '';
  }
}

async function copyCode(item: V2SavedTotpAccount) {
  if (!/^\d{6,8}$/.test(item.token)) return;
  try {
    await navigator.clipboard.writeText(item.token);
    copiedAccountId.value = item.id;
    if (copyFeedbackTimer) clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      copiedAccountId.value = '';
    }, 1200);
    ElMessage.success('验证码已复制');
  } catch {
    ElMessage.error('无法复制验证码，请手动选择复制');
  }
}

function accountMeta(item: V2SavedTotpAccount) {
  const configuration = `${item.algorithm} · ${item.digits} 位 · ${item.period} 秒周期`;
  return item.issuer ? `${item.issuer} · ${configuration}` : configuration;
}

function timingFor(item: V2SavedTotpAccount): AccountTiming {
  const expiresAt = Date.parse(item.expiresAt);
  const remainingMs = Number.isFinite(expiresAt) ? Math.max(0, expiresAt - clockTick.value) : 0;
  const remainingSeconds = Math.min(item.period, Math.max(0, Math.ceil(remainingMs / 1000)));
  return {
    remainingSeconds,
    progress: item.period > 0 ? Math.min(100, (remainingSeconds / item.period) * 100) : 0
  };
}

function formatToken(token: string) {
  const splitAt = Math.ceil(token.length / 2);
  return `${token.slice(0, splitAt)} ${token.slice(splitAt)}`;
}

function formatUpdatedAt(value: string) {
  return formatV2DateTime(value, {}, '时间异常');
}

async function requestCloseEditor() {
  await handleEditorBeforeClose(() => {
    editorVisible.value = false;
  });
}

async function handleEditorBeforeClose(done: () => void) {
  if (saving.value) return;
  if (!editorDirty.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('当前内容尚未保存，确认放弃吗？', '放弃未保存内容', {
      confirmButtonText: '放弃',
      cancelButtonText: '继续填写',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续填写。
  }
}

function clearAll() {
  searchQuery.value = '';
  currentPage.value = 1;
  copiedAccountId.value = '';
  resetEditor();
}

defineExpose({
  clearAll,
  hasUnsavedChanges: () => editorDirty.value
});
</script>

<style scoped>
.v2-saved-totp {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding-top: 18px;
  border-top: 2px solid var(--v3-success-border-soft);
}

.v2-saved-totp__header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-saved-totp__header > div {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.v2-saved-totp__header strong {
  color: var(--v2-text);
  font-size: 15px;
  line-height: 22px;
}

.v2-saved-totp__header strong > span {
  margin-left: 6px;
  color: var(--v2-text-soft);
  font-size: 12px;
  font-weight: var(--v3-font-weight-regular);
}

.v2-saved-totp__header span,
.v2-saved-totp-card__heading span,
.v2-saved-totp__no-match span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-saved-totp__readonly {
  margin: 0;
  padding: 9px 11px;
  border: 1px solid var(--v3-warning-border-soft);
  border-radius: 7px;
  background: var(--v3-warning-soft);
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-saved-totp__search {
  width: 100%;
}

.v2-saved-totp__list {
  display: grid;
  gap: 6px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.v2-saved-totp-card {
  position: relative;
  display: grid;
  overflow: hidden;
  min-width: 0;
  gap: 5px;
  padding: 9px 11px 11px;
  border: 1px solid color-mix(in srgb, var(--v2-success) 34%, var(--v2-border));
  border-left: 3px solid var(--v2-success);
  border-radius: 8px;
  background: color-mix(in srgb, var(--v2-success) 5%, var(--v2-surface));
  box-shadow: var(--v3-shadow-sm);
}

.v2-saved-totp-card__heading {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 8px;
}

.v2-saved-totp-card__identity {
  display: flex;
  min-width: 0;
  align-items: baseline;
  gap: 7px;
}

.v2-saved-totp-card__identity strong {
  flex: 0 1 auto;
  overflow: hidden;
  color: var(--v2-text);
  font-size: 13px;
  line-height: 18px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-saved-totp-card__identity span {
  flex: 1 1 auto;
  overflow: hidden;
  font-size: 11px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-saved-totp-card__countdown {
  flex: 0 0 auto;
  font-size: 11px;
  line-height: 17px;
  font-family: var(--v3-font-mono);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.v2-saved-totp-card__countdown.is-expiring {
  color: var(--v3-warning);
  font-weight: var(--v3-font-weight-semibold);
}

.v2-saved-totp-card__details {
  display: grid;
  min-width: 0;
  grid-template-columns: max-content minmax(110px, 1fr) auto;
  align-items: center;
  gap: 10px;
}

.v2-saved-totp-card__token {
  min-width: 0;
  color: var(--v2-success);
  font-family: var(--v3-font-mono);
  font-size: 22px;
  font-weight: var(--v3-font-weight-bold);
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.04em;
  line-height: 28px;
  white-space: nowrap;
}

.v2-saved-totp-card__copy.app-button.el-button {
  min-width: 66px;
}

.v2-saved-totp-card__updated {
  overflow: hidden;
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 17px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-saved-totp-card__controls {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 2px;
}

.v2-saved-totp-card__progress {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  height: 3px;
  overflow: hidden;
  border-radius: 0;
  background: color-mix(in srgb, var(--v2-border) 75%, transparent);
}

.v2-saved-totp-card__progress > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--v2-success);
  transition: width 220ms linear;
}

.v2-saved-totp-card__progress.is-expiring > span {
  background: var(--v3-warning);
}

.v2-saved-totp__pagination {
  display: flex;
  justify-content: center;
  padding-top: 4px;
}

.v2-saved-totp__no-match {
  display: grid;
  min-height: 110px;
  place-content: center;
  gap: 3px;
  text-align: center;
}

.v2-saved-totp__no-match strong {
  color: var(--v2-text);
  font-size: 14px;
  line-height: 21px;
}

.v2-saved-totp-editor__form {
  display: grid;
  gap: 16px;
}

.v2-saved-totp-editor__form :deep(.el-form-item) {
  margin-bottom: 0;
}

.v2-saved-totp-editor__secret {
  display: grid;
  min-width: 0;
  width: 100%;
  gap: 5px;
}

.v2-saved-totp-editor__secret p,
.v2-saved-totp-editor__error {
  margin: 0;
  font-size: 12px;
  line-height: 18px;
}

.v2-saved-totp-editor__secret p {
  color: var(--v2-text-soft);
}

.v2-saved-totp-editor__error {
  margin-top: 12px;
  padding: 9px 11px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 7px;
  background: var(--v3-danger-soft);
  color: var(--v2-danger);
}

@media (max-width: 520px) {
  .v2-saved-totp__header {
    align-items: flex-start;
  }

  .v2-saved-totp-card {
    padding: 9px 10px 11px;
  }

  .v2-saved-totp-card__identity {
    display: grid;
    gap: 0;
  }

  .v2-saved-totp-card__details {
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 10px;
  }

  .v2-saved-totp-card__token {
    font-size: 21px;
    line-height: 27px;
  }

  .v2-saved-totp-card__controls {
    grid-column: 1 / -1;
  }

  .v2-saved-totp__pagination :deep(.el-pager li),
  .v2-saved-totp__pagination :deep(.btn-prev),
  .v2-saved-totp__pagination :deep(.btn-next) {
    margin: 0 2px;
  }
}
</style>
