<template>
  <div class="v2-managed-mailbox-panel">
    <section class="v2-managed-mailbox-panel__add" aria-labelledby="managed-mailbox-add-title">
      <header>
        <div>
          <strong id="managed-mailbox-add-title">添加邮箱</strong>
          <span>保存后加密存入服务器，换电脑仍可使用；Microsoft 邮箱使用官方 OAuth2。</span>
        </div>
        <AppButton
          class="v2-managed-mailbox-panel__submit"
          variant="primary"
          size="small"
          :loading="creating"
          @click="submitMailbox"
        >
          <el-icon><Connection v-if="form.provider === 'microsoft'" /><Plus v-else /></el-icon>
          {{ form.provider === 'microsoft' ? '连接 Microsoft 并添加' : '验证并添加' }}
        </AppButton>
      </header>

      <el-form
        ref="formRef"
        :model="form"
        :rules="rules"
        label-position="left"
        label-width="112px"
        require-asterisk-position="right"
        class="v2-horizontal-form v2-managed-mailbox-panel__form"
        @submit.prevent="submitMailbox"
      >
        <el-form-item label="邮箱类型" prop="provider" required>
          <el-radio-group v-model="form.provider">
            <el-radio-button value="gmail">谷歌邮箱</el-radio-button>
            <el-radio-button value="icloud">苹果邮箱</el-radio-button>
            <el-radio-button value="microsoft">微软邮箱</el-radio-button>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="邮箱地址" prop="email" required>
          <el-input
            v-model="form.email"
            :maxlength="V2_MAIL_VIEWER_LIMITS.email"
            autocomplete="off"
            autocapitalize="off"
            :spellcheck="false"
            :placeholder="emailPlaceholder"
          />
        </el-form-item>
        <el-form-item
          v-if="form.provider !== 'microsoft'"
          label="应用专用密码"
          prop="appPassword"
          required
        >
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
        <el-form-item v-else label="授权方式">
          <div class="v2-managed-mailbox-panel__oauth-note" role="note">
            <strong>Microsoft 安全授权</strong>
            <span>将打开 Microsoft 登录页授权 IMAP 只读访问，系统不会接收邮箱密码。</span>
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
    </section>

    <section class="v2-managed-mailbox-panel__list" aria-labelledby="managed-mailbox-list-title">
      <header>
        <div>
          <strong id="managed-mailbox-list-title">邮箱池管理</strong>
          <span>邮箱、授权状态和查询码保存在服务器；邮件正文和查询明细不持久化。</span>
        </div>
        <div class="v2-managed-mailbox-panel__header-actions" aria-label="邮箱池管理操作">
          <AppButton size="small" variant="ghost" @click="openQueryCodeSettings">
            <el-icon><Setting /></el-icon>
            有效期设置
          </AppButton>
          <AppButton size="small" variant="soft" @click="batchDrawerOpen = true">
            <el-icon><Upload /></el-icon>
            批量导入
          </AppButton>
          <AppButton
            size="small"
            variant="ghost"
            title="刷新邮箱列表"
            :disabled="mailboxesQuery.isRefreshing.value"
            @click="mailboxesQuery.refresh"
          >
            <el-icon><Refresh /></el-icon>
            刷新
          </AppButton>
        </div>
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
          <el-option label="微软邮箱" value="microsoft" />
        </el-select>
        <el-select v-model="filters.status" clearable placeholder="全部状态" @change="applyFilters">
          <el-option label="可查询" value="active" />
          <el-option label="已停用" value="disabled" />
          <el-option label="授权失效" value="auth_failed" />
        </el-select>
      </div>

      <V2AsyncRegion
        :phase="mailboxesQuery.phase.value"
        :previous-data="mailboxesQuery.isParameterTransition.value"
        :empty="mailboxes.length === 0"
        :error="listError"
        variant="section"
        skeleton="table"
        loading-title="正在读取邮箱池"
        refreshing-title="正在更新邮箱池"
        empty-title="暂无邮箱"
        empty-message="添加并验证邮箱后会显示在这里。"
        error-title="邮箱池加载失败"
        @retry="mailboxesQuery.refresh"
      >
        <V2Table
          :schema="v2TableSchemas.workspace.managedMailboxes"
          :show-column-settings="false"
          :data="mailboxes"
          :view-key="`${mailboxResult.page}-${mailboxResult.pageSize}`"
          :aria-busy="mailboxesQuery.isRefreshing.value"
          class="v2-managed-mailbox-panel__table"
        >
          <V2TableColumn :definition="v2TableSchemas.workspace.managedMailboxes.columns[0]">
            <template #default="{ row }">
              <span :class="['v2-managed-mailbox-panel__provider', `is-${row.provider}`]">
                {{ providerShortLabel(row.provider) }}
              </span>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.workspace.managedMailboxes.columns[1]"
            prop="email"
          >
            <template #default="{ row }">
              <div class="v2-managed-mailbox-panel__identity">
                <strong>{{ row.email }}</strong>
                <small>{{ row.label || '未填写备注' }}</small>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn
            :definition="v2TableSchemas.workspace.managedMailboxes.columns[2]"
            prop="status"
          >
            <template #default="{ row }">
              <el-tag :type="statusMeta(row.status).type" effect="plain" size="small">
                {{ statusMeta(row.status).label }}
              </el-tag>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.workspace.managedMailboxes.columns[3]">
            <template #default="{ row }">
              <div class="v2-managed-mailbox-panel__query-code">
                <code v-if="queryCodeFor(row)">{{ queryCodeFor(row) }}</code>
                <span v-else class="v2-managed-mailbox-panel__legacy-code">
                  历史查询码无法还原
                </span>
                <AppButton
                  v-if="queryCodeFor(row)"
                  size="small"
                  variant="soft"
                  :title="`复制 ${row.email} 的买家查询码`"
                  @click="copyQueryCode(row)"
                >
                  <el-icon><CopyDocument /></el-icon>
                  复制查询码
                </AppButton>
                <AppButton
                  v-else
                  size="small"
                  variant="soft"
                  :loading="updatingId === row.id"
                  :title="`为 ${row.email} 生成并复制新的买家查询码`"
                  @click="generateAndCopyLegacyCode(row)"
                >
                  <el-icon><CopyDocument /></el-icon>
                  生成并复制
                </AppButton>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.workspace.managedMailboxes.columns[4]">
            <template #default="{ row }">
              <div class="v2-managed-mailbox-panel__expiry">
                <el-tag
                  :type="queryCodeExpiryMeta(row.queryCodeExpiresAt).type"
                  effect="plain"
                  size="small"
                >
                  {{ queryCodeExpiryMeta(row.queryCodeExpiresAt).label }}
                </el-tag>
                <small>{{ queryCodeExpiryMeta(row.queryCodeExpiresAt).detail }}</small>
              </div>
            </template>
          </V2TableColumn>
          <V2TableColumn :definition="v2TableSchemas.workspace.managedMailboxes.columns[5]">
            <template #default="{ row }">{{ formatDate(row.lastQueriedAt) }}</template>
          </V2TableColumn>
          <V2TableActionColumn :definition="v2TableSchemas.workspace.managedMailboxes.columns[6]">
            <template #default="{ row }">
              <el-switch
                :model-value="row.status === 'active'"
                :disabled="updatingId === row.id || row.status === 'auth_failed'"
                :loading="updatingId === row.id"
                :aria-label="`${row.email} 允许买家查询`"
                @change="(value: string | number | boolean) => updateStatus(row, Boolean(value))"
              />
              <el-dropdown
                trigger="click"
                :disabled="updatingId === row.id"
                @command="handleMailboxAction(row, $event)"
              >
                <AppButton size="small" variant="ghost" :disabled="updatingId === row.id">
                  更多操作
                </AppButton>
                <template #dropdown>
                  <el-dropdown-menu>
                    <el-dropdown-item command="credential">
                      {{ row.provider === 'microsoft' ? '重新授权' : '更新授权' }}
                    </el-dropdown-item>
                    <el-dropdown-item command="query-code" divided>重置查询码</el-dropdown-item>
                  </el-dropdown-menu>
                </template>
              </el-dropdown>
            </template>
          </V2TableActionColumn>
        </V2Table>

        <el-pagination
          background
          layout="total, sizes, prev, pager, next"
          :current-page="mailboxResult.page"
          :page-size="mailboxResult.pageSize"
          :page-sizes="[10, 20, 50]"
          :pager-count="5"
          :total="mailboxResult.total"
          @current-change="changePage"
          @size-change="changePageSize"
        />
      </V2AsyncRegion>
    </section>

    <V2ManagedMailboxBatchDrawer v-model="batchDrawerOpen" @imported="handleBatchImported" />

    <el-drawer
      class="v2-mailbox-query-code-settings-drawer"
      :model-value="queryCodeSettingsOpen"
      title="查询码有效期设置"
      size="min(480px, 100vw)"
      append-to-body
      destroy-on-close
      :before-close="handleQueryCodeSettingsClose"
      @close="queryCodeSettingsOpen = false"
    >
      <div class="v2-mailbox-query-code-settings-drawer__body">
        <div class="v2-mailbox-query-code-settings-drawer__notice" role="note">
          <strong>查询码到期后不会自动更换</strong>
          <span>到期会标红并停止查询，需要管理员手动生成新码并重新交付买家。</span>
        </div>

        <V2AsyncRegion
          :phase="queryCodeSettingsQuery.phase.value"
          :previous-data="queryCodeSettingsQuery.isParameterTransition.value"
          :empty="false"
          :error="queryCodeSettingsError"
          variant="section"
          skeleton="form"
          loading-title="正在读取查询码设置"
          refreshing-title="正在更新查询码设置"
          error-title="查询码设置加载失败"
          @retry="queryCodeSettingsQuery.refresh"
        >
          <el-form
            :model="queryCodeSettingsForm"
            label-position="left"
            label-width="144px"
            require-asterisk-position="right"
            class="v2-horizontal-form"
            @submit.prevent="saveQueryCodeSettings"
          >
            <el-form-item label="查询码有效天数" required>
              <div class="v2-mailbox-query-code-settings-drawer__field">
                <el-input-number
                  v-model="queryCodeSettingsForm.validityDays"
                  :min="queryCodeSettings.minValidityDays"
                  :max="queryCodeSettings.maxValidityDays"
                  :step="1"
                  step-strictly
                  controls-position="right"
                />
                <small> 新建邮箱和手动生成新码时，统一使用这个有效天数。 </small>
              </div>
            </el-form-item>
            <el-form-item label="到期处理方式">
              <div class="v2-mailbox-query-code-settings-drawer__field">
                <el-tag effect="plain" type="info">手动生成新码</el-tag>
                <small>系统不会静默换码，避免买家持有的查询码突然失效。</small>
              </div>
            </el-form-item>
            <el-form-item label="同步现有查询码">
              <div class="v2-mailbox-query-code-settings-drawer__field">
                <el-checkbox v-model="queryCodeSettingsForm.applyToExisting">
                  保存时统一重算现有查询码到期时间
                </el-checkbox>
                <small>勾选后，所有现有查询码从保存时刻重新计算有效期，但查询码本身不变。</small>
              </div>
            </el-form-item>
          </el-form>
        </V2AsyncRegion>

        <footer>
          <AppButton variant="ghost" @click="closeQueryCodeSettings">取消</AppButton>
          <AppButton
            variant="primary"
            :loading="savingQueryCodeSettings"
            :disabled="Boolean(queryCodeSettingsError)"
            @click="saveQueryCodeSettings"
          >
            保存设置
          </AppButton>
        </footer>
      </div>
    </el-drawer>

    <el-drawer
      class="v2-mailbox-credential-drawer"
      :model-value="credentialDrawerOpen"
      title="更新邮箱授权"
      size="min(460px, 100vw)"
      append-to-body
      destroy-on-close
      :before-close="handleCredentialDrawerClose"
      @close="credentialDrawerOpen = false"
      @closed="cancelCredentialUpdate"
    >
      <div v-if="credentialMailbox" class="v2-mailbox-credential-drawer__body">
        <div>
          <strong>{{ credentialMailbox.email }}</strong>
          <span>{{ providerLabel(credentialMailbox.provider) }}</span>
        </div>
        <el-form
          label-position="left"
          label-width="112px"
          require-asterisk-position="right"
          class="v2-horizontal-form"
          @submit.prevent="updateCredential"
        >
          <el-form-item label="应用专用密码" required>
            <el-input
              v-model="replacementPassword"
              type="password"
              show-password
              :maxlength="V2_MAIL_VIEWER_LIMITS.providerCredential"
              autocomplete="new-password"
              data-1p-ignore="true"
              placeholder="输入新的应用专用密码"
            />
          </el-form-item>
        </el-form>
        <footer>
          <AppButton variant="ghost" @click="credentialDrawerOpen = false">取消</AppButton>
          <AppButton
            variant="primary"
            :loading="updatingId === credentialMailbox.id"
            @click="updateCredential"
          >
            验证并保存
          </AppButton>
        </footer>
      </div>
    </el-drawer>
  </div>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue';
import type { FormInstance, FormRules, TagProps } from 'element-plus';
import type {
  CreateV2ManagedMailboxInput,
  V2MailProvider,
  V2ManagedMailbox,
  V2ManagedMailboxList,
  V2ManagedMailboxQueryCodeSettings,
  V2ManagedMailboxStatus
} from '@apple-business/shared';
import {
  V2_MAIL_VIEWER_LIMITS,
  V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY
} from '@apple-business/shared';
import {
  Connection,
  CopyDocument,
  Plus,
  Refresh,
  Search,
  Setting,
  Upload
} from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2Table from '@/v2/components/V2Table.vue';
import V2TableActionColumn from '@/v2/components/V2TableActionColumn.vue';
import V2TableColumn from '@/v2/components/V2TableColumn.vue';
import { v2TableSchemas } from '@/v2/features/tableSchemas';
import { createV2QueryKey, useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { getV2BusinessNowMs } from '@/v2/runtime/businessClock';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import V2ManagedMailboxBatchDrawer from './V2ManagedMailboxBatchDrawer.vue';
import { resolveV2ManagedMailboxQueryCodeExpiry } from './managedMailboxExpiry';

interface ManagedMailboxForm {
  appPassword: string;
  email: string;
  label: string;
  provider: V2MailProvider;
}

const formRef = ref<FormInstance>();
const form = reactive<ManagedMailboxForm>({
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
  pageSize: number;
}>({ q: '', provider: '', status: '', page: 1, pageSize: 10 });
const creating = ref(false);
const updatingId = ref('');
const batchDrawerOpen = ref(false);
const queryCodeSettingsOpen = ref(false);
const savingQueryCodeSettings = ref(false);
const credentialDrawerOpen = ref(false);
const credentialMailbox = ref<V2ManagedMailbox | null>(null);
const replacementPassword = ref('');
const clockTick = ref(getV2BusinessNowMs() ?? Date.now());
const queryCodeSettingsForm = reactive({ applyToExisting: false, validityDays: 30 });
const queryCodeSettingsSnapshot = ref('');
const queryCodeOverrides = reactive(new Map<string, string>());
let microsoftAuthorizationGeneration = 0;
let microsoftAuthorizationPopup: Window | null = null;
let expiryTickTimer: ReturnType<typeof setInterval> | undefined;

const rules: FormRules<ManagedMailboxForm> = {
  provider: [{ required: true, message: '请选择邮箱类型', trigger: 'change' }],
  email: [
    { required: true, message: '请输入邮箱地址', trigger: 'blur' },
    { type: 'email', message: '请输入有效的邮箱地址', trigger: 'blur' }
  ],
  appPassword: [{ required: true, message: '请输入应用专用密码', trigger: 'blur' }]
};
const emailPlaceholder = computed(() =>
  form.provider === 'gmail'
    ? 'name@gmail.com'
    : form.provider === 'icloud'
      ? 'name@icloud.com'
      : 'name@outlook.com'
);
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
        pageSize: filters.pageSize,
        provider: filters.provider || undefined,
        q: filters.q || undefined,
        status: filters.status || undefined
      },
      { signal }
    )
});
const queryCodeSettingsQuery = useV2ModuleQuery<V2ManagedMailboxQueryCodeSettings>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'managed-mailbox-query-code-settings',
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.getManagedMailboxQueryCodeSettings({ signal })
});
const mailboxResult = computed<V2ManagedMailboxList>(
  () =>
    mailboxesQuery.data.value ?? {
      items: [],
      page: 1,
      pageSize: filters.pageSize,
      total: 0
    }
);
const mailboxes = computed(() => mailboxResult.value.items);
const queryCodeSettings = computed<V2ManagedMailboxQueryCodeSettings>(
  () =>
    queryCodeSettingsQuery.data.value ?? {
      validityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.defaultDays,
      defaultValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.defaultDays,
      minValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.minDays,
      maxValidityDays: V2_MANAGED_MAILBOX_QUERY_CODE_VALIDITY.maxDays,
      rotationMode: 'manual',
      updatedAt: null
    }
);
const listError = computed(() =>
  mailboxesQuery.error.value ? getApiErrorMessage(mailboxesQuery.error.value) : ''
);
const queryCodeSettingsError = computed(() =>
  queryCodeSettingsQuery.error.value ? getApiErrorMessage(queryCodeSettingsQuery.error.value) : ''
);

watch(
  () => queryCodeSettingsQuery.data.value,
  (settings) => {
    if (!settings || !queryCodeSettingsOpen.value || queryCodeSettingsDirty()) return;
    resetQueryCodeSettingsForm(settings.validityDays);
  }
);

onMounted(() => {
  expiryTickTimer = setInterval(() => {
    clockTick.value = getV2BusinessNowMs() ?? Date.now();
  }, 60_000);
});

onBeforeUnmount(() => {
  if (expiryTickTimer) clearInterval(expiryTickTimer);
});

async function submitMailbox() {
  try {
    await formRef.value?.validate();
  } catch {
    return;
  }
  if (form.provider === 'microsoft') {
    await authorizeMicrosoftMailbox({ email: form.email, label: form.label || undefined });
    return;
  }
  await createPasswordMailbox();
}

async function createPasswordMailbox() {
  if (form.provider === 'microsoft') return;
  creating.value = true;
  try {
    const input: CreateV2ManagedMailboxInput = {
      email: form.email.trim(),
      provider: form.provider,
      appPassword: form.appPassword,
      label: form.label.trim() || undefined
    };
    const result = await idBusinessV2WorkspaceApi.createManagedMailbox(input);
    queryCodeOverrides.set(result.mailbox.id, result.buyerCredential);
    resetForm();
    filters.page = 1;
    await mailboxesQuery.refresh();
    ElMessage.success('邮箱已验证并加入邮箱池，买家查询码已显示');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    creating.value = false;
  }
}

async function authorizeMicrosoftMailbox(input: {
  email: string;
  label?: string;
  mailboxId?: string;
}) {
  const popup = window.open('about:blank', '_blank', 'popup,width=560,height=760');
  if (!popup) {
    ElMessage.error('浏览器阻止了授权窗口，请允许弹窗后重试');
    return;
  }
  popup.opener = null;
  microsoftAuthorizationPopup = popup;
  const generation = ++microsoftAuthorizationGeneration;
  creating.value = !input.mailboxId;
  if (input.mailboxId) updatingId.value = input.mailboxId;
  try {
    const authorization = await idBusinessV2WorkspaceApi.startMicrosoftMailboxAuthorization({
      email: input.email.trim(),
      label: input.label?.trim() || undefined,
      mailboxId: input.mailboxId
    });
    popup.location.assign(authorization.authorizationUrl);
    const status = await pollMicrosoftAuthorization(
      authorization.authorizationId,
      Date.parse(authorization.expiresAt),
      generation
    );
    if (generation !== microsoftAuthorizationGeneration || !status) return;
    if (status.status === 'failed') {
      ElMessage.error(status.failureMessage || 'Microsoft 邮箱授权失败');
      return;
    }
    if (!input.mailboxId) resetForm();
    filters.page = 1;
    await mailboxesQuery.refresh();
    ElMessage.success(input.mailboxId ? 'Microsoft 邮箱已重新授权' : 'Microsoft 邮箱已加入邮箱池');
  } catch (error) {
    if (generation === microsoftAuthorizationGeneration) ElMessage.error(getApiErrorMessage(error));
  } finally {
    if (generation === microsoftAuthorizationGeneration) {
      creating.value = false;
      updatingId.value = '';
    }
    if (!popup.closed) popup.close();
    if (microsoftAuthorizationPopup === popup) microsoftAuthorizationPopup = null;
  }
}

async function pollMicrosoftAuthorization(
  authorizationId: string,
  expiresAt: number,
  generation: number
) {
  while (generation === microsoftAuthorizationGeneration && Date.now() < expiresAt + 2_000) {
    const status =
      await idBusinessV2WorkspaceApi.getMicrosoftMailboxAuthorizationStatus(authorizationId);
    if (status.status !== 'pending') return status;
    await new Promise((resolve) => window.setTimeout(resolve, 1_200));
  }
  return null;
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

function handleMailboxAction(item: V2ManagedMailbox, command: unknown) {
  if (command === 'credential') {
    startCredentialUpdate(item);
    return;
  }
  if (command === 'query-code') void rotateQueryCode(item);
}

function startCredentialUpdate(item: V2ManagedMailbox) {
  if (item.provider === 'microsoft') {
    void authorizeMicrosoftMailbox({
      email: item.email,
      label: item.label || undefined,
      mailboxId: item.id
    });
    return;
  }
  credentialMailbox.value = item;
  replacementPassword.value = '';
  credentialDrawerOpen.value = true;
}

function cancelCredentialUpdate() {
  credentialDrawerOpen.value = false;
  credentialMailbox.value = null;
  replacementPassword.value = '';
}

async function updateCredential() {
  const item = credentialMailbox.value;
  if (!item) return;
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
      `重置后旧查询码立即失效，新查询码有效期 ${queryCodeSettings.value.validityDays} 天。生成后系统会自动复制，请把新码重新交给买家。`,
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
    queryCodeOverrides.set(item.id, result.buyerCredential);
    const copied = await writeClipboardText(result.buyerCredential);
    await mailboxesQuery.refresh();
    ElMessage.success(copied ? '新查询码已生成并复制' : '新查询码已生成，请在当前行复制');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    updatingId.value = '';
  }
}

async function generateAndCopyLegacyCode(item: V2ManagedMailbox) {
  await rotateQueryCode(item);
}

async function copyQueryCode(item: V2ManagedMailbox) {
  const queryCode = queryCodeFor(item);
  if (!queryCode) return;
  const copied = await writeClipboardText(queryCode);
  if (copied) ElMessage.success('查询码已复制');
  else ElMessage.error('无法自动复制，请手动选择查询码复制');
}

function queryCodeFor(item: V2ManagedMailbox) {
  return item.queryCode ?? queryCodeOverrides.get(item.id) ?? null;
}

function applyFilters() {
  filters.page = 1;
  void mailboxesQuery.refresh();
}

function changePage(page: number) {
  filters.page = page;
  void mailboxesQuery.refresh();
}

function changePageSize(pageSize: number) {
  filters.page = 1;
  filters.pageSize = pageSize;
  void mailboxesQuery.refresh();
}

function handleBatchImported() {
  filters.page = 1;
  void mailboxesQuery.refresh();
}

function openQueryCodeSettings() {
  resetQueryCodeSettingsForm(queryCodeSettings.value.validityDays);
  queryCodeSettingsOpen.value = true;
  if (!queryCodeSettingsQuery.data.value) void queryCodeSettingsQuery.refresh();
}

function resetQueryCodeSettingsForm(validityDays: number) {
  queryCodeSettingsForm.validityDays = validityDays;
  queryCodeSettingsForm.applyToExisting = false;
  queryCodeSettingsSnapshot.value = JSON.stringify(queryCodeSettingsForm);
}

function queryCodeSettingsDirty() {
  return JSON.stringify(queryCodeSettingsForm) !== queryCodeSettingsSnapshot.value;
}

async function saveQueryCodeSettings() {
  const validityDays = Number(queryCodeSettingsForm.validityDays);
  if (
    !Number.isInteger(validityDays) ||
    validityDays < queryCodeSettings.value.minValidityDays ||
    validityDays > queryCodeSettings.value.maxValidityDays
  ) {
    ElMessage.warning(
      `请输入 ${queryCodeSettings.value.minValidityDays} 至 ${queryCodeSettings.value.maxValidityDays} 天的整数`
    );
    return;
  }

  savingQueryCodeSettings.value = true;
  try {
    const result = await idBusinessV2WorkspaceApi.updateManagedMailboxQueryCodeSettings({
      validityDays,
      applyToExisting: queryCodeSettingsForm.applyToExisting
    });
    resetQueryCodeSettingsForm(result.validityDays);
    await queryCodeSettingsQuery.refresh();
    if (result.updatedExistingCount > 0) await mailboxesQuery.refresh();
    queryCodeSettingsOpen.value = false;
    ElMessage.success(
      result.updatedExistingCount > 0
        ? `设置已保存，已同步 ${result.updatedExistingCount} 个现有查询码`
        : '查询码有效期设置已保存'
    );
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    savingQueryCodeSettings.value = false;
  }
}

async function handleQueryCodeSettingsClose(done: () => void) {
  if (!queryCodeSettingsDirty()) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('关闭后会放弃尚未保存的有效期设置。', '放弃修改', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续设置',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续设置。
  }
}

async function closeQueryCodeSettings() {
  if (!queryCodeSettingsDirty()) {
    queryCodeSettingsOpen.value = false;
    return;
  }
  try {
    await ElMessageBox.confirm('关闭后会放弃尚未保存的有效期设置。', '放弃修改', {
      confirmButtonText: '放弃修改',
      cancelButtonText: '继续设置',
      type: 'warning'
    });
    queryCodeSettingsOpen.value = false;
  } catch {
    // 用户选择继续设置。
  }
}

function providerLabel(provider: V2MailProvider) {
  if (provider === 'gmail') return '谷歌邮箱';
  if (provider === 'icloud') return '苹果邮箱';
  return '微软邮箱';
}

function providerShortLabel(provider: V2MailProvider) {
  if (provider === 'gmail') return '谷歌';
  if (provider === 'icloud') return '苹果';
  return '微软';
}

function statusMeta(status: V2ManagedMailboxStatus): { label: string; type: TagProps['type'] } {
  if (status === 'active') return { label: '可查询', type: 'success' };
  if (status === 'disabled') return { label: '已停用', type: 'info' };
  return { label: '授权失效', type: 'danger' };
}

function formatDate(value: string | null) {
  return formatV2DateTime(value, {}, '尚未查询');
}

function queryCodeExpiryMeta(value: string): {
  detail: string;
  label: string;
  type: TagProps['type'];
} {
  const formatted = formatV2DateTime(value, {}, '时间异常');
  const meta = resolveV2ManagedMailboxQueryCodeExpiry(value, clockTick.value, formatted);
  return {
    detail: meta.detail,
    label: meta.label,
    type: meta.state === 'valid' ? 'success' : meta.state === 'warning' ? 'warning' : 'danger'
  };
}

async function writeClipboardText(value: string) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // 继续使用兼容旧浏览器和非安全上下文的复制方式。
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = value;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.inset = '-9999px auto auto -9999px';
  document.body.appendChild(textarea);
  textarea.select();
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

async function handleCredentialDrawerClose(done: () => void) {
  if (!replacementPassword.value) {
    done();
    return;
  }
  try {
    await ElMessageBox.confirm('关闭后会清空尚未保存的应用专用密码。', '清空并关闭', {
      confirmButtonText: '清空并关闭',
      cancelButtonText: '继续填写',
      type: 'warning'
    });
    done();
  } catch {
    // 用户选择继续填写。
  }
}

function resetForm() {
  form.email = '';
  form.appPassword = '';
  form.label = '';
  formRef.value?.clearValidate();
}

function clearAll() {
  microsoftAuthorizationGeneration += 1;
  microsoftAuthorizationPopup?.close();
  microsoftAuthorizationPopup = null;
  resetForm();
  cancelCredentialUpdate();
  batchDrawerOpen.value = false;
  queryCodeSettingsOpen.value = false;
  resetQueryCodeSettingsForm(queryCodeSettings.value.validityDays);
}

defineExpose({
  clearAll,
  hasContent: () =>
    Boolean(
      form.email ||
      form.label ||
      form.appPassword ||
      replacementPassword.value ||
      queryCodeSettingsDirty()
    )
});
</script>

<style scoped>
.v2-managed-mailbox-panel {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.v2-managed-mailbox-panel__add,
.v2-managed-mailbox-panel__list {
  display: grid;
  min-width: 0;
  gap: 10px;
}

.v2-managed-mailbox-panel__add > header,
.v2-managed-mailbox-panel__list > header {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px;
}

.v2-managed-mailbox-panel__add > header > div,
.v2-managed-mailbox-panel__list > header > div {
  display: grid;
  min-width: 0;
  gap: 1px;
}

.v2-managed-mailbox-panel header strong {
  color: var(--v2-text);
  font-size: 14px;
  line-height: 21px;
}

.v2-managed-mailbox-panel header span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}

.v2-managed-mailbox-panel__form {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  align-items: start;
  gap: 10px 16px;
}

.v2-managed-mailbox-panel__form :deep(.el-form-item) {
  min-width: 0;
  margin-bottom: 0;
}

.v2-managed-mailbox-panel__form :deep(.el-form-item__label) {
  min-height: 32px;
  align-items: center;
  white-space: nowrap;
}

.v2-managed-mailbox-panel__form :deep(.el-form-item__content) {
  min-width: 0;
}

.v2-managed-mailbox-panel__password-field {
  display: grid;
  width: 100%;
  gap: 2px;
}

.v2-managed-mailbox-panel__password-field small,
.v2-managed-mailbox-panel__query-code small {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 17px;
}

.v2-managed-mailbox-panel__oauth-note {
  display: grid;
  width: 100%;
  min-width: 0;
  gap: 1px;
}

.v2-managed-mailbox-panel__oauth-note strong,
.v2-managed-mailbox-panel__oauth-note span {
  font-size: 12px;
  line-height: 18px;
}

.v2-managed-mailbox-panel__oauth-note strong {
  color: var(--v2-text);
}

.v2-managed-mailbox-panel__oauth-note span {
  color: var(--v2-text-soft);
}

.v2-managed-mailbox-panel__header-actions {
  display: grid;
  grid-template-columns: repeat(3, 116px);
  gap: 8px;
}

.v2-managed-mailbox-panel__header-actions > .app-button.el-button {
  width: 100%;
  min-width: 116px;
}

.v2-managed-mailbox-panel__submit.app-button.el-button {
  min-width: 116px;
  white-space: nowrap;
}

.v2-managed-mailbox-panel__filters {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) 140px 140px;
  gap: 8px;
}

.v2-managed-mailbox-panel__table {
  min-width: 0;
}

.v2-managed-mailbox-panel__provider {
  display: inline-grid;
  min-width: 46px;
  place-items: center;
  padding: 3px 6px;
  border: 1px solid var(--v2-border);
  border-radius: 5px;
  color: var(--v2-text-soft);
  font-size: 11px;
  font-weight: var(--v3-font-weight-semibold);
}

.v2-managed-mailbox-panel__provider.is-gmail {
  border-color: var(--v3-danger-border-soft);
  color: var(--v2-danger);
}

.v2-managed-mailbox-panel__provider.is-icloud {
  border-color: var(--v3-info-border-soft);
  color: var(--v3-info);
}

.v2-managed-mailbox-panel__provider.is-microsoft {
  border-color: var(--v3-success-border-soft);
  color: var(--v3-success);
}

.v2-managed-mailbox-panel__identity,
.v2-managed-mailbox-panel__query-code,
.v2-managed-mailbox-panel__expiry {
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
  font-size: 12px;
}

.v2-managed-mailbox-panel__identity small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-managed-mailbox-panel__query-code {
  justify-items: start;
  gap: 4px;
}

.v2-managed-mailbox-panel__query-code code {
  max-width: 100%;
  overflow-x: auto;
  color: var(--v2-text);
  font-family: var(--v3-font-mono);
  font-size: 11px;
  white-space: nowrap;
}

.v2-managed-mailbox-panel__legacy-code {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 17px;
}

.v2-managed-mailbox-panel__expiry {
  justify-items: start;
  gap: 3px;
}

.v2-managed-mailbox-panel__expiry small {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 17px;
  white-space: nowrap;
}

.v2-managed-mailbox-panel :deep(.el-pagination) {
  justify-content: flex-end;
  margin-top: 12px;
}

@media (max-width: 900px) {
  .v2-managed-mailbox-panel__form {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 720px) {
  .v2-managed-mailbox-panel__add > header,
  .v2-managed-mailbox-panel__list > header {
    grid-template-columns: minmax(0, 1fr);
    align-items: start;
  }

  .v2-managed-mailbox-panel__header-actions {
    width: 100%;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .v2-managed-mailbox-panel__header-actions > .app-button.el-button,
  .v2-managed-mailbox-panel__submit.app-button.el-button {
    min-width: 0;
  }

  .v2-managed-mailbox-panel__filters {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-managed-mailbox-panel :deep(.el-pagination) {
    justify-content: flex-start;
    overflow-x: auto;
  }
}
</style>

<style>
.v2-mailbox-credential-drawer .el-drawer__body {
  padding: 0;
}

.v2-mailbox-query-code-settings-drawer .el-drawer__body {
  padding: 0;
}

.v2-mailbox-query-code-settings-drawer__body {
  display: grid;
  gap: 18px;
  padding: 18px;
}

.v2-mailbox-query-code-settings-drawer__notice {
  display: grid;
  gap: 3px;
  padding: 12px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
}

.v2-mailbox-query-code-settings-drawer__notice strong {
  color: var(--v2-text);
  font-size: 13px;
  line-height: 19px;
}

.v2-mailbox-query-code-settings-drawer__notice span,
.v2-mailbox-query-code-settings-drawer__field small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}

.v2-mailbox-query-code-settings-drawer__field {
  display: grid;
  width: 100%;
  min-width: 0;
  justify-items: start;
  gap: 4px;
}

.v2-mailbox-query-code-settings-drawer__field .el-input-number {
  width: 160px;
}

.v2-mailbox-query-code-settings-drawer__body > footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.v2-mailbox-credential-drawer__body {
  display: grid;
  gap: 20px;
  padding: 18px;
}

.v2-mailbox-credential-drawer__body > div:first-child {
  display: grid;
  gap: 2px;
}

.v2-mailbox-credential-drawer__body > div:first-child strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-mailbox-credential-drawer__body > div:first-child span {
  color: var(--v2-text-soft);
  font-size: 12px;
}

.v2-mailbox-credential-drawer__body > footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
