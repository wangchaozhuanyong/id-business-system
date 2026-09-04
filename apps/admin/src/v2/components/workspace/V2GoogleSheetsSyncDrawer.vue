<template>
  <el-drawer
    class="v2-google-sheets-drawer"
    :model-value="modelValue"
    size="min(760px, 100vw)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    :before-close="beforeClose"
    @closed="resetTransientState"
  >
    <template #header="{ titleId, titleClass }">
      <div class="v2-google-sheets-drawer__heading">
        <span :id="titleId" :class="titleClass">Google 表格同步</span>
        <FeatureHelp
          title="Google 表格同步说明"
          :text="syncHelp"
          :links="helpLinks"
          placement="bottom"
          :width="390"
        />
      </div>
    </template>

    <div class="v2-google-sheets-drawer__body">
      <V2AsyncRegion
        :phase="statusQuery.phase.value"
        :empty="false"
        :error="statusError"
        variant="section"
        skeleton="form"
        loading-title="正在读取同步状态"
        refreshing-title="正在更新同步状态"
        error-title="同步状态加载失败"
        @retry="statusQuery.refresh"
      >
        <template v-if="status">
          <section class="v2-google-sheets-summary">
            <div>
              <span>连接状态</span>
              <strong>{{ connectionLabel }}</strong>
            </div>
            <div>
              <span>自动同步</span>
              <strong>{{ status.enabled ? '已开启' : '已暂停' }}</strong>
            </div>
            <div>
              <span>同步频率</span>
              <strong>约 {{ status.syncIntervalSeconds }} 秒</strong>
            </div>
            <div>
              <span>最后成功</span>
              <strong>{{ formatV2DateTime(status.lastSucceededAt) }}</strong>
            </div>
          </section>

          <div v-if="status.lastErrorMessage" class="v2-google-sheets-error" role="alert">
            <el-icon><WarningFilled /></el-icon>
            <span>
              <strong>最近一次同步未成功</strong>
              <small>{{ status.lastErrorMessage }}</small>
            </span>
          </div>

          <section class="v2-google-sheets-card">
            <header>
              <span>
                <el-icon><Setting /></el-icon>
                <strong>连接设置</strong>
              </span>
              <el-tag :type="status.authorized ? 'success' : 'info'" effect="plain">
                {{ connectionLabel }}
              </el-tag>
            </header>
            <p>
              在 Google Cloud 创建“Web 应用”OAuth 客户端，并把下方回调地址加入已获授权的重定向 URI。
            </p>
            <el-form
              label-position="left"
              label-width="150px"
              require-asterisk-position="right"
              @submit.prevent
            >
              <el-form-item label="OAuth 客户端 ID" required>
                <el-input
                  v-model="form.clientId"
                  autocomplete="off"
                  placeholder="例如：xxxx.apps.googleusercontent.com"
                  :disabled="busy"
                />
              </el-form-item>
              <el-form-item label="OAuth 客户端密钥" :required="!status.configured">
                <el-input
                  v-model="form.clientSecret"
                  type="password"
                  show-password
                  autocomplete="new-password"
                  :placeholder="status.configured ? '留空则沿用已保存的密钥' : '首次配置时必须填写'"
                  :disabled="busy"
                />
              </el-form-item>
              <el-form-item label="授权回调地址">
                <div class="v2-google-sheets-copy-row">
                  <el-input :model-value="status.callbackUrl" readonly />
                  <AppButton size="small" variant="soft" @click="copyText(status.callbackUrl)">
                    复制
                  </AppButton>
                </div>
              </el-form-item>
            </el-form>
            <div class="v2-google-sheets-actions">
              <AppButton
                variant="soft"
                :loading="action === 'save'"
                :disabled="busy || !writesAllowed"
                @click="saveConfig"
              >
                保存配置
              </AppButton>
              <AppButton
                variant="primary"
                :loading="action === 'authorize'"
                :disabled="busy || !status.configured || !writesAllowed"
                @click="startAuthorization"
              >
                {{ status.authorized ? '重新授权 Google' : '授权 Google' }}
              </AppButton>
              <AppButton variant="ghost" :disabled="busy" @click="statusQuery.refresh">
                刷新状态
              </AppButton>
            </div>
          </section>

          <section class="v2-google-sheets-card">
            <header>
              <span>
                <el-icon><DataAnalysis /></el-icon>
                <strong>同步内容</strong>
              </span>
              <el-switch
                :model-value="status.enabled"
                :disabled="busy || !status.authorized || !writesAllowed"
                aria-label="自动同步开关"
                @change="toggleEnabled"
              />
            </header>
            <div class="v2-google-sheets-report-list">
              <span v-for="name in status.reportNames" :key="name">
                <el-icon><CircleCheck /></el-icon>{{ name }}
              </span>
            </div>
            <div class="v2-google-sheets-exclusions">
              <strong>不会同步</strong>
              <span>{{ status.excludedData.join('、') }}</span>
            </div>
            <footer>
              <span>每张明细表最多同步最近 10,000 条记录；同步失败不会影响业务录入。</span>
              <div>
                <AppButton
                  v-if="status.spreadsheetUrl"
                  variant="ghost"
                  @click="openSpreadsheet(status.spreadsheetUrl)"
                >
                  打开 Google 表格
                </AppButton>
                <AppButton
                  variant="primary"
                  :loading="action === 'sync' || status.syncing"
                  :disabled="busy || !status.enabled || !writesAllowed"
                  @click="runSync"
                >
                  立即同步
                </AppButton>
              </div>
            </footer>
          </section>

          <div v-if="status.authorized" class="v2-google-sheets-disconnect">
            <AppButton
              variant="danger"
              :loading="action === 'disconnect'"
              :disabled="busy || !writesAllowed"
              @click="disconnect"
            >
              断开 Google 授权
            </AppButton>
            <span>断开后不会删除 Google 网盘中已经生成的报表。</span>
          </div>
        </template>
      </V2AsyncRegion>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import 'element-plus/es/components/message-box/style/css.mjs';
import { computed, onBeforeUnmount, reactive, ref, watch } from 'vue';
import type { V2GoogleSheetsSyncStatus } from '@apple-business/shared';
import { CircleCheck, DataAnalysis, Setting, WarningFilled } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus/es/components/message-box/index.mjs';
import AppButton from '@/components/ui/AppButton.vue';
import FeatureHelp from '@/components/ui/FeatureHelp.vue';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { ElMessage } from '@/v2/services/elementPlusMessage';
import { formatV2DateTime } from '@/v2/utils/dateTime';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const authStore = useAuthStore();
const action = ref<'save' | 'authorize' | 'toggle' | 'sync' | 'disconnect' | ''>('');
const form = reactive({ clientId: '', clientSecret: '' });

const syncHelp = [
  '这是单向报表同步，Google 表格不会反向修改系统数据库。',
  '授权只使用 drive.file，系统只能管理自己创建的报表文件。',
  '有业务变化时约 30 秒内自动更新，也可以手动立即同步。'
];
const helpLinks = [
  { label: '打开 Google API 凭据', href: 'https://console.cloud.google.com/apis/credentials' },
  {
    label: '启用 Google Sheets API',
    href: 'https://console.cloud.google.com/apis/library/sheets.googleapis.com'
  },
  {
    label: '查看官方 OAuth 说明',
    href: 'https://developers.google.com/identity/protocols/oauth2/web-server?hl=zh-cn'
  }
] as const;

const statusQuery = useV2ModuleQuery<V2GoogleSheetsSyncStatus>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'google-sheets-sync-status',
  enabled: () => props.modelValue,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.getGoogleSheetsSyncStatus({ signal })
});
const status = computed(() => statusQuery.data.value);
const statusError = computed(() =>
  statusQuery.error.value ? getApiErrorMessage(statusQuery.error.value) : ''
);
const busy = computed(() => Boolean(action.value));
const writesAllowed = computed(() => authStore.writesAllowed);
const connectionLabel = computed(() =>
  status.value?.authorized ? '已授权' : status.value?.configured ? '待授权' : '未配置'
);

watch(
  () => props.modelValue,
  (open) => {
    if (!open) return;
    void statusQuery.refresh();
    document.addEventListener('visibilitychange', refreshAfterAuthorization);
  }
);
watch(
  () => status.value?.clientId,
  (clientId) => {
    if (clientId) form.clientId = clientId;
  },
  { immediate: true }
);
onBeforeUnmount(() => document.removeEventListener('visibilitychange', refreshAfterAuthorization));

async function saveConfig() {
  if (!form.clientId.trim()) return void ElMessage.warning('请输入 Google OAuth 客户端 ID');
  if (!status.value?.configured && !form.clientSecret.trim()) {
    return void ElMessage.warning('首次配置时请输入 Google OAuth 客户端密钥');
  }
  action.value = 'save';
  try {
    await idBusinessV2WorkspaceApi.saveGoogleSheetsSyncConfig({
      clientId: form.clientId.trim(),
      ...(form.clientSecret ? { clientSecret: form.clientSecret } : {})
    });
    form.clientSecret = '';
    await statusQuery.refresh();
    ElMessage.success('Google OAuth 配置已保存');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    action.value = '';
  }
}

async function startAuthorization() {
  action.value = 'authorize';
  try {
    const result = await idBusinessV2WorkspaceApi.startGoogleSheetsAuthorization();
    const opened = window.open(result.authorizationUrl, '_blank', 'noopener,noreferrer');
    if (opened) opened.opener = null;
    ElMessage.success('已打开 Google 授权页，完成后回到这里刷新状态');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    action.value = '';
  }
}

async function toggleEnabled(value: string | number | boolean) {
  action.value = 'toggle';
  try {
    await idBusinessV2WorkspaceApi.updateGoogleSheetsSyncState({ enabled: value === true });
    await statusQuery.refresh();
    ElMessage.success(value === true ? '自动同步已开启' : '自动同步已暂停');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    action.value = '';
  }
}

async function runSync() {
  action.value = 'sync';
  try {
    const result = await idBusinessV2WorkspaceApi.runGoogleSheetsSync();
    await statusQuery.refresh();
    if (result.skipped) ElMessage.info('已有同步任务正在执行，请稍后刷新');
    else if (result.status.lastErrorMessage) ElMessage.error(result.status.lastErrorMessage);
    else ElMessage.success('Google 表格同步成功');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    action.value = '';
  }
}

async function disconnect() {
  try {
    await ElMessageBox.confirm(
      '将停止自动同步并清除系统保存的 Google 授权。Google 网盘中的既有报表不会删除。',
      '确认断开 Google 授权？',
      { confirmButtonText: '确认断开', cancelButtonText: '取消', type: 'warning' }
    );
  } catch {
    return;
  }
  action.value = 'disconnect';
  try {
    await idBusinessV2WorkspaceApi.disconnectGoogleSheetsSync();
    await statusQuery.refresh();
    ElMessage.success('Google 授权已断开');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    action.value = '';
  }
}

async function beforeClose(done: () => void) {
  if (busy.value) return void ElMessage.warning('当前操作完成后再关闭');
  emit('update:modelValue', false);
  done();
}

function resetTransientState() {
  action.value = '';
  form.clientSecret = '';
  document.removeEventListener('visibilitychange', refreshAfterAuthorization);
}

function refreshAfterAuthorization() {
  if (document.visibilityState === 'visible' && props.modelValue) void statusQuery.refresh();
}

function openSpreadsheet(url: string) {
  const opened = window.open(url, '_blank', 'noopener,noreferrer');
  if (opened) opened.opener = null;
}

async function copyText(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    ElMessage.success('已复制');
  } catch {
    ElMessage.error('复制失败，请手动复制');
  }
}
</script>

<style>
.v2-google-sheets-drawer .el-drawer__body {
  padding: 0;
}
.v2-google-sheets-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--v2-border);
}
.v2-google-sheets-drawer__heading,
.v2-google-sheets-card > header,
.v2-google-sheets-card > footer,
.v2-google-sheets-disconnect {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.v2-google-sheets-drawer__body {
  display: grid;
  gap: 14px;
  padding: 18px 20px 28px;
}
.v2-google-sheets-summary {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}
.v2-google-sheets-summary > div {
  display: grid;
  gap: 4px;
  padding: 14px;
  border-right: 1px solid var(--v2-border-soft);
}
.v2-google-sheets-summary > div:last-child {
  border-right: 0;
}
.v2-google-sheets-summary span,
.v2-google-sheets-card p,
.v2-google-sheets-card footer > span,
.v2-google-sheets-disconnect > span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}
.v2-google-sheets-summary strong,
.v2-google-sheets-card strong {
  color: var(--v2-text);
  font-size: 13px;
  line-height: 20px;
}
.v2-google-sheets-error {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  gap: 9px;
  padding: 11px 12px;
  border: 1px solid var(--v3-danger-border-soft);
  border-radius: 8px;
  background: var(--v3-danger-soft);
  color: var(--v3-danger);
}
.v2-google-sheets-error > span {
  display: grid;
  gap: 2px;
}
.v2-google-sheets-error small {
  color: var(--v2-text-soft);
}
.v2-google-sheets-card {
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}
.v2-google-sheets-card > header > span {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.v2-google-sheets-card > p {
  margin: 10px 0 16px;
}
.v2-google-sheets-copy-row {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.v2-google-sheets-actions,
.v2-google-sheets-card > footer > div {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.v2-google-sheets-report-list {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 8px;
  margin: 14px 0;
}
.v2-google-sheets-report-list > span {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 9px 10px;
  border-radius: 6px;
  background: var(--v2-surface-muted);
  color: var(--v2-text);
  font-size: 12px;
}
.v2-google-sheets-exclusions {
  display: grid;
  gap: 4px;
  padding: 12px;
  border-radius: 7px;
  background: var(--v2-surface-muted);
}
.v2-google-sheets-exclusions > span {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}
.v2-google-sheets-card > footer {
  align-items: flex-end;
  margin-top: 16px;
}
.v2-google-sheets-card > footer > span {
  max-width: 360px;
}
.v2-google-sheets-disconnect {
  justify-content: flex-start;
  padding-top: 2px;
}
@media (max-width: 720px) {
  .v2-google-sheets-summary,
  .v2-google-sheets-report-list {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .v2-google-sheets-card > footer {
    align-items: stretch;
    flex-direction: column;
  }
  .v2-google-sheets-card > footer > span {
    max-width: none;
  }
}
</style>
