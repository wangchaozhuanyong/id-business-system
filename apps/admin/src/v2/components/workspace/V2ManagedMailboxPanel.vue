<template>
  <div class="v2-managed-mailbox-panel">
    <section class="v2-managed-mailbox-panel__add" aria-labelledby="managed-mailbox-add-title">
      <header>
        <div>
          <strong id="managed-mailbox-add-title">添加邮箱</strong>
          <span>保存前会连接邮箱服务验证授权。</span>
        </div>
      </header>
      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-managed-mailbox-panel__form"
        @submit.prevent="createMailbox"
      >
        <el-form-item label="邮箱类型" prop="provider" required>
          <el-radio-group v-model="form.provider">
            <el-radio-button value="gmail">谷歌邮箱</el-radio-button>
            <el-radio-button value="icloud">苹果邮箱</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="邮箱地址" prop="email" required>
          <el-input
            v-model="form.email"
            :maxlength="V2_MAIL_VIEWER_LIMITS.email"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            placeholder="name@gmail.com"
          />
        </el-form-item>
        <el-form-item label="应用专用密码" prop="appPassword" required>
          <div class="v2-managed-mailbox-panel__password-field">
            <el-input
              v-model="form.appPassword"
              type="password"
              show-password
              :maxlength="V2_MAIL_VIEWER_LIMITS.providerCredential"
              autocomplete="new-password"
              data-1p-ignore="true"
              data-lpignore="true"
              :spellcheck="false"
              :placeholder="appPasswordPlaceholder"
            />
            <small>{{ appPasswordHelp }}</small>
          </div>
        </el-form-item>
        <el-form-item label="备注" prop="label">
          <el-input
            v-model="form.label"
            :maxlength="V2_MAIL_VIEWER_LIMITS.label"
            placeholder="例如：客户 A"
          />
        </el-form-item>
      </el-form>
      <div class="v2-managed-mailbox-panel__form-actions">
        <AppButton variant="primary" :loading="creating" @click="createMailbox">
          <el-icon><Plus /></el-icon>
          验证并添加
        </AppButton>
      </div>
    </section>

    <section v-if="issuedQueryCode" class="v2-managed-mailbox-panel__issued" aria-live="polite">
      <div>
        <strong>买家查询码已生成</strong>
        <span>此查询码只显示这一次，有效期 30 天，请立即交付并妥善保存。</span>
      </div>
      <code>{{ issuedQueryCode }}</code>
      <AppButton variant="soft" @click="copyText(issuedQueryCode, '查询码已复制')">
        <el-icon><CopyDocument /></el-icon>
        复制查询码
      </AppButton>
    </section>

    <section class="v2-managed-mailbox-panel__list" aria-labelledby="managed-mailbox-list-title">
      <header>
        <div>
          <strong id="managed-mailbox-list-title">邮箱池</strong>
          <span>应用专用密码不可查看；失效后只能重新填写。</span>
        </div>
        <AppButton variant="ghost" icon-only title="刷新邮箱列表" @click="mailboxesQuery.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </header>

      <div class="v2-managed-mailbox-panel__filters">
        <el-input
          v-model="filters.q"
          clearable
          placeholder="搜索邮箱或备注"
          :prefix-icon="Search"
          @change="applyFilters"
          @clear="applyFilters"
        />
        <el-select
          v-model="filters.provider"
          clearable
          placeholder="全部类型"
          @change="applyFilters"
        >
          <el-option label="谷歌邮箱" value="gmail" />
          <el-option label="苹果邮箱" value="icloud" />
        </el-select>
        <el-select v-model="filters.status" clearable placeholder="全部状态" @change="applyFilters">
          <el-option label="可查询" value="active" />
          <el-option label="已停用" value="disabled" />
          <el-option label="授权失效" value="auth_failed" />
        </el-select>
      </div>

      <V2AsyncRegion
        :phase="mailboxesQuery.phase.value"
        :empty="mailboxes.length === 0"
        :error="listError"
        variant="section"
        skeleton="cards"
        loading-title="正在读取邮箱池"
        refreshing-title="正在更新邮箱池"
        empty-title="暂无邮箱"
        empty-message="添加并验证邮箱后会显示在这里。"
        error-title="邮箱池加载失败"
        @retry="mailboxesQuery.refresh"
      >
        <ol class="v2-managed-mailbox-panel__items">
          <li v-for="item in mailboxes" :key="item.id">
            <div class="v2-managed-mailbox-panel__identity">
              <span :class="`is-${item.provider}`">{{ providerLabel(item.provider) }}</span>
              <div>
                <strong>{{ item.email }}</strong>
                <small>{{ item.label || '未填写备注' }}</small>
              </div>
            </div>
            <dl>
              <div>
                <dt>状态</dt>
                <dd>
                  <el-tag :type="statusMeta(item.status).type" effect="plain" size="small">
                    {{ statusMeta(item.status).label }}
                  </el-tag>
                </dd>
              </div>
              <div>
                <dt>查询码</dt>
                <dd>末四位 {{ item.queryCodeHint }}</dd>
              </div>
              <div>
                <dt>查询码有效期</dt>
                <dd>
                  <el-tag
                    :type="queryCodeExpiryMeta(item.queryCodeExpiresAt).type"
                    effect="plain"
                    size="small"
                  >
                    {{ queryCodeExpiryMeta(item.queryCodeExpiresAt).label }}
                  </el-tag>
                </dd>
              </div>
              <div>
                <dt>最近查询</dt>
                <dd>{{ formatDate(item.lastQueriedAt) }}</dd>
              </div>
            </dl>
            <div class="v2-managed-mailbox-panel__actions">
              <span>允许买家查询</span>
              <el-switch
                :model-value="item.status === 'active'"
                :disabled="updatingId === item.id || item.status === 'auth_failed'"
                :loading="updatingId === item.id"
                :aria-label="`${item.email} 允许买家查询`"
                @change="(value: string | number | boolean) => updateStatus(item, Boolean(value))"
              />
              <AppButton size="small" variant="ghost" @click="startCredentialUpdate(item)">
                更新授权
              </AppButton>
              <AppButton size="small" variant="ghost" @click="rotateQueryCode(item)">
                重置查询码
              </AppButton>
            </div>
            <form
              v-if="credentialMailboxId === item.id"
              class="v2-managed-mailbox-panel__credential-form"
              @submit.prevent="updateCredential(item)"
            >
              <el-input
                v-model="replacementPassword"
                type="password"
                show-password
                :maxlength="V2_MAIL_VIEWER_LIMITS.providerCredential"
                autocomplete="new-password"
                data-1p-ignore="true"
                placeholder="输入新的应用专用密码"
              />
              <AppButton
                size="small"
                variant="primary"
                :loading="updatingId === item.id"
                @click="updateCredential(item)"
              >
                验证并保存
              </AppButton>
              <AppButton size="small" variant="ghost" @click="cancelCredentialUpdate"
                >取消</AppButton
              >
            </form>
          </li>
        </ol>
        <el-pagination
          v-if="mailboxResult.total > mailboxResult.pageSize"
          background
          layout="prev, pager, next, total"
          :current-page="mailboxResult.page"
          :page-size="mailboxResult.pageSize"
          :total="mailboxResult.total"
          @current-change="changePage"
        />
      </V2AsyncRegion>
    </section>
  </div>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, reactive, ref } from 'vue';
import type { FormInstance, FormRules, TagProps } from 'element-plus';
import type {
  CreateV2ManagedMailboxInput,
  V2MailProvider,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxStatus
} from '@apple-business/shared';
import { V2_MAIL_VIEWER_LIMITS } from '@apple-business/shared';
import { CopyDocument, Plus, Refresh, Search } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';

const formRef = ref<FormInstance>();
const form = reactive<CreateV2ManagedMailboxInput>({
  email: '',
  provider: 'gmail',
  appPassword: '',
  label: ''
});
const filters = reactive<{
  q: string;
  provider: V2MailProvider | '';
  status: V2ManagedMailboxStatus | '';
  page: number;
}>({ q: '', provider: '', status: '', page: 1 });
const creating = ref(false);
const updatingId = ref('');
const issuedQueryCode = ref('');
const credentialMailboxId = ref('');
const replacementPassword = ref('');
const rules: FormRules<CreateV2ManagedMailboxInput> = {
  provider: [{ required: true, message: '请选择邮箱类型', trigger: 'change' }],
  email: [
    { required: true, message: '请输入邮箱地址', trigger: 'blur' },
    { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' }
  ],
  appPassword: [{ required: true, message: '请输入应用专用密码', trigger: 'blur' }]
};
const appPasswordPlaceholder = computed(() =>
  form.provider === 'gmail'
    ? '输入 Google 生成的 16 位应用专用密码'
    : '输入 Apple 生成的应用专用密码'
);
const appPasswordHelp = computed(() =>
  form.provider === 'gmail'
    ? '需要先开启 Google 两步验证；不要填写 Gmail 普通登录密码。'
    : '需要先开启 Apple 双重认证；系统会优先使用邮箱名称部分登录 iCloud IMAP。'
);

const mailboxesQuery = useV2ModuleQuery<V2ManagedMailboxList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: () => createV2QueryKey({ ...filters }),
  trackRouteData: false,
  query: ({ signal }) =>
    idBusinessV2WorkspaceApi.listManagedMailboxes(
      {
        page: filters.page,
        pageSize: 20,
        provider: filters.provider || undefined,
        q: filters.q || undefined,
        status: filters.status || undefined
      },
      { signal }
    )
});
const mailboxResult = computed<V2ManagedMailboxList>(
  () => mailboxesQuery.data.value ?? { items: [], page: 1, pageSize: 20, total: 0 }
);
const mailboxes = computed(() => mailboxResult.value.items);
const listError = computed(() =>
  mailboxesQuery.error.value ? getApiErrorMessage(mailboxesQuery.error.value) : ''
);

async function createMailbox() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  creating.value = true;
  try {
    const result = await idBusinessV2WorkspaceApi.createManagedMailbox({
      email: form.email.trim(),
      provider: form.provider,
      appPassword: form.appPassword,
      label: form.label?.trim() || undefined
    });
    issuedQueryCode.value = result.buyerCredential;
    form.email = '';
    form.appPassword = '';
    form.label = '';
    formRef.value?.clearValidate();
    filters.page = 1;
    await mailboxesQuery.refresh();
    ElMessage.success('邮箱已验证并加入邮箱池');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function updateStatus(item: V2ManagedMailbox, enabled: boolean) {
  updatingId.value = item.id;
  try {
    await idBusinessV2WorkspaceApi.updateManagedMailboxStatus(item.id, {
      status: enabled ? 'active' : 'disabled'
    });
    await mailboxesQuery.refresh();
    ElMessage.success(enabled ? '已允许买家查询' : '已停用买家查询');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    updatingId.value = '';
  }
}

function startCredentialUpdate(item: V2ManagedMailbox) {
  credentialMailboxId.value = item.id;
  replacementPassword.value = '';
}

function cancelCredentialUpdate() {
  credentialMailboxId.value = '';
  replacementPassword.value = '';
}

async function updateCredential(item: V2ManagedMailbox) {
  if (!replacementPassword.value.trim()) {
    ElMessage.warning('请输入新的应用专用密码');
    return;
  }
  updatingId.value = item.id;
  try {
    await idBusinessV2WorkspaceApi.updateManagedMailboxCredential(item.id, {
      appPassword: replacementPassword.value
    });
    cancelCredentialUpdate();
    await mailboxesQuery.refresh();
    ElMessage.success('邮箱授权已更新');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    updatingId.value = '';
  }
}

async function rotateQueryCode(item: V2ManagedMailbox) {
  try {
    await ElMessageBox.confirm(
      '重置后旧查询码立即失效，新查询码有效期 30 天，需要把新查询码重新交给买家。',
      '重置查询码',
      {
        confirmButtonText: '确认重置',
        cancelButtonText: '取消',
        type: 'warning'
      }
    );
  } catch {
    return;
  }
  updatingId.value = item.id;
  try {
    const result = await idBusinessV2WorkspaceApi.rotateManagedMailboxQueryCode(item.id);
    issuedQueryCode.value = result.buyerCredential;
    await mailboxesQuery.refresh();
    ElMessage.success('查询码已重置');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    updatingId.value = '';
  }
}

function applyFilters() {
  filters.page = 1;
  void mailboxesQuery.refresh();
}

function changePage(page: number) {
  filters.page = page;
  void mailboxesQuery.refresh();
}

function providerLabel(provider: V2MailProvider) {
  return provider === 'gmail' ? '谷' : '苹';
}

function statusMeta(status: V2ManagedMailboxStatus): { label: string; type: TagProps['type'] } {
  if (status === 'active') return { label: '可查询', type: 'success' };
  if (status === 'disabled') return { label: '已停用', type: 'info' };
  return { label: '授权失效', type: 'danger' };
}

function formatDate(value: string | null) {
  return formatV2DateTime(value, {}, '尚未查询');
}

function queryCodeExpiryMeta(value: string): { label: string; type: TagProps['type'] } {
  const expiresAt = Date.parse(value);
  const now = getV2BusinessNowMs();
  const formatted = formatV2DateTime(value, {}, '时间异常');
  if (!Number.isFinite(expiresAt)) return { label: '时间异常', type: 'danger' };
  if (now !== null && expiresAt <= now) return { label: `已过期 · ${formatted}`, type: 'danger' };
  if (now !== null && expiresAt - now <= 3 * 24 * 60 * 60 * 1000) {
    return { label: `即将到期 · ${formatted}`, type: 'warning' };
  }
  return { label: `有效至 ${formatted}`, type: 'success' };
}

async function copyText(value: string, message: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success(message);
  } catch {
    ElMessage.error('无法复制，请手动选择复制');
  }
}

function clearAll() {
  form.appPassword = '';
  replacementPassword.value = '';
  credentialMailboxId.value = '';
  issuedQueryCode.value = '';
}

defineExpose({
  clearAll,
  hasContent: () => Boolean(form.appPassword || replacementPassword.value || issuedQueryCode.value)
});
</script>

<style scoped>
.v2-managed-mailbox-panel {
  display: grid;
  min-width: 0;
  gap: 24px;
}

.v2-managed-mailbox-panel__add,
.v2-managed-mailbox-panel__list {
  display: grid;
  min-width: 0;
  gap: 16px;
}

.v2-managed-mailbox-panel__add > header,
.v2-managed-mailbox-panel__list > header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.v2-managed-mailbox-panel__add > header > div,
.v2-managed-mailbox-panel__list > header > div {
  display: grid;
  gap: 2px;
}

.v2-managed-mailbox-panel header strong {
  color: var(--v2-text);
  font-size: 15px;
  line-height: 22px;
}

.v2-managed-mailbox-panel header span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-managed-mailbox-panel__form {
  display: grid;
  gap: 14px;
}

.v2-managed-mailbox-panel__form :deep(.el-form-item) {
  margin-bottom: 0;
}

.v2-managed-mailbox-panel__password-field {
  display: grid;
  width: 100%;
  gap: 4px;
}

.v2-managed-mailbox-panel__password-field small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-managed-mailbox-panel__form-actions {
  display: flex;
  justify-content: flex-end;
}

.v2-managed-mailbox-panel__issued {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px 14px;
  padding: 14px;
  border: 1px solid var(--v3-success-border-soft);
  border-radius: 7px;
  background: var(--v3-success-soft);
}

.v2-managed-mailbox-panel__issued > div {
  display: grid;
  gap: 2px;
}

.v2-managed-mailbox-panel__issued strong,
.v2-managed-mailbox-panel__issued span {
  font-size: 12px;
  line-height: 19px;
}

.v2-managed-mailbox-panel__issued strong {
  color: var(--v2-text);
}

.v2-managed-mailbox-panel__issued span {
  color: var(--v2-text-soft);
}

.v2-managed-mailbox-panel__issued code {
  grid-column: 1 / -1;
  min-width: 0;
  padding: 10px;
  overflow-wrap: anywhere;
  border-radius: 5px;
  background: var(--v2-surface);
  color: var(--v2-text);
  font-family: var(--v3-font-mono);
  font-size: 12px;
  line-height: 20px;
}

.v2-managed-mailbox-panel__filters {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 140px 140px;
  gap: 8px;
}

.v2-managed-mailbox-panel__items {
  display: grid;
  min-width: 0;
  gap: 8px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}

.v2-managed-mailbox-panel__items > li {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding: 14px;
  border: 1px solid var(--v2-border);
  border-radius: 7px;
  background: var(--v2-surface);
}

.v2-managed-mailbox-panel__identity {
  display: grid;
  min-width: 0;
  grid-template-columns: 34px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
}

.v2-managed-mailbox-panel__identity > span {
  display: grid;
  width: 34px;
  height: 34px;
  place-items: center;
  border-radius: 6px;
  background: var(--v2-surface-muted);
  color: var(--v2-text);
  font-size: 12px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-managed-mailbox-panel__identity > span.is-gmail {
  border: 1px solid var(--v3-danger-border-soft);
  color: var(--v2-danger);
}

.v2-managed-mailbox-panel__identity > span.is-icloud {
  border: 1px solid var(--v3-info-border-soft);
  color: var(--v3-info);
}

.v2-managed-mailbox-panel__identity > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}

.v2-managed-mailbox-panel__identity strong,
.v2-managed-mailbox-panel__identity small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-managed-mailbox-panel__identity strong {
  color: var(--v2-text);
  font-size: 13px;
}

.v2-managed-mailbox-panel__identity small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-managed-mailbox-panel__items dl {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 10px;
  margin: 0;
  padding: 10px 0;
  border-block: 1px solid var(--v2-border-soft);
}

.v2-managed-mailbox-panel__items dl > div {
  display: grid;
  gap: 3px;
}

.v2-managed-mailbox-panel__items dt,
.v2-managed-mailbox-panel__items dd {
  margin: 0;
  font-size: 11px;
  line-height: 18px;
}

.v2-managed-mailbox-panel__items dt {
  color: var(--v2-text-soft);
}

.v2-managed-mailbox-panel__items dd {
  color: var(--v2-text);
}

.v2-managed-mailbox-panel__actions {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.v2-managed-mailbox-panel__actions > span {
  margin-right: auto;
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-managed-mailbox-panel__credential-form {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  padding-top: 2px;
}

.v2-managed-mailbox-panel :deep(.el-pagination) {
  justify-content: flex-end;
  min-height: 32px;
}

@media (max-width: 680px) {
  .v2-managed-mailbox-panel__filters,
  .v2-managed-mailbox-panel__items dl,
  .v2-managed-mailbox-panel__credential-form {
    grid-template-columns: 1fr;
  }

  .v2-managed-mailbox-panel__actions {
    align-items: flex-start;
    flex-wrap: wrap;
    justify-content: flex-start;
  }

  .v2-managed-mailbox-panel__actions > span {
    flex: 1 0 calc(100% - 48px);
  }

  .v2-managed-mailbox-panel__issued {
    grid-template-columns: 1fr;
  }
}
</style>
