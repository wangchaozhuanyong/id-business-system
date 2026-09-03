<template>
  <el-drawer
    class="v2-relay-script-drawer"
    :model-value="modelValue"
    title="中转脚本"
    size="min(1180px, 100vw)"
    append-to-body
    close-on-click-modal
    close-on-press-escape
    :before-close="beforeClose"
  >
    <div class="v2-relay-script-drawer__body">
      <div class="v2-relay-script-disclosure" role="note">
        <el-icon><Lock /></el-icon>
        <span>
          <strong>在线自动部署 Google Cloud Vertex 账号到中转站</strong>
          <small
            >OAuth、服务账号密钥和中转站会话加密保存；密码与 2FA 验证码仅用于当前登录请求。</small
          >
        </span>
      </div>
      <V2AsyncRegion
        :phase="connectionQuery.phase.value"
        :empty="false"
        :error="connectionError"
        variant="section"
        skeleton="form"
        loading-title="正在读取连接状态"
        refreshing-title="正在更新连接状态"
        error-title="连接状态加载失败"
        @retry="connectionQuery.refresh"
      >
        <el-tabs v-if="connection" v-model="activeTab" class="v2-relay-script-tabs">
          <el-tab-pane label="连接设置" name="connection">
            <V2RelayConnectionPanel
              :connection="connection"
              :writes-allowed="writesAllowed"
              @refresh="refreshConnection"
            />
          </el-tab-pane>
          <el-tab-pane label="Vertex 部署" name="deploy">
            <V2RelayDeploymentPanel
              ref="deploymentPanel"
              :active="modelValue && readyForDeployment"
              :ready="readyForDeployment"
              :writes-allowed="writesAllowed"
              @open-settings="activeTab = 'connection'"
              @running-change="deploymentRunning = $event"
            />
          </el-tab-pane>
        </el-tabs>
      </V2AsyncRegion>
    </div>
  </el-drawer>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { V2RelayConnectionStatus } from '@apple-business/shared';
import { Lock } from '@element-plus/icons-vue';
import { ElMessageBox } from 'element-plus';
import { getApiErrorMessage } from '@/api/client';
import { useAuthStore } from '@/stores/auth';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import V2RelayConnectionPanel from './V2RelayConnectionPanel.vue';
import V2RelayDeploymentPanel from './V2RelayDeploymentPanel.vue';

const props = defineProps<{ modelValue: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>();
const authStore = useAuthStore();
const activeTab = ref<'connection' | 'deploy'>('connection');
const deploymentRunning = ref(false);
const deploymentPanel = ref<InstanceType<typeof V2RelayDeploymentPanel>>();

const connectionQuery = useV2ModuleQuery<V2RelayConnectionStatus>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'relay-connection',
  enabled: () => props.modelValue,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.getRelayConnection({ signal })
});
const connection = computed(() => connectionQuery.data.value);
const readyForDeployment = computed(
  () =>
    connection.value?.googleAuthorized === true && connection.value.cloudBridgeConnected === true
);
const writesAllowed = computed(() => authStore.writesAllowed);
const connectionError = computed(() =>
  connectionQuery.error.value ? getApiErrorMessage(connectionQuery.error.value) : ''
);

watch(
  () => props.modelValue,
  (open) => {
    if (open) void connectionQuery.refresh();
  }
);

async function refreshConnection() {
  await connectionQuery.refresh();
}

async function beforeClose(done: () => void) {
  if (!deploymentRunning.value) {
    emit('update:modelValue', false);
    done();
    return;
  }
  try {
    await ElMessageBox.confirm(
      '当前部署仍在执行。关闭后会停止浏览器端自动续跑，但已完成步骤会保留。',
      '确认关闭中转脚本？',
      { confirmButtonText: '停止并关闭', cancelButtonText: '继续执行', type: 'warning' }
    );
    deploymentPanel.value?.stop();
    emit('update:modelValue', false);
    done();
  } catch {
    // 用户选择继续执行。
  }
}
</script>

<style>
.v2-relay-script-drawer .el-drawer__body {
  padding: 0;
}
.v2-relay-script-drawer .el-drawer__header {
  margin-bottom: 0;
  padding: 16px 20px 12px;
  border-bottom: 1px solid var(--v2-border);
}
.v2-relay-script-drawer__body {
  display: grid;
  min-width: 0;
  gap: 12px;
  padding: 14px 20px 24px;
}
.v2-relay-script-disclosure {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr);
  align-items: start;
  gap: 9px;
  padding: 9px 11px;
  border: 1px solid var(--v3-warning-border-soft);
  border-radius: 7px;
  background: var(--v3-warning-soft);
}
.v2-relay-script-disclosure > span,
.v2-relay-deploy-form > header > div,
.v2-relay-job-card > header > div {
  display: grid;
  min-width: 0;
  gap: 2px;
}
.v2-relay-script-disclosure strong,
.v2-relay-deploy-form strong,
.v2-relay-job-card strong {
  color: var(--v2-text);
  font-size: 13px;
  line-height: 20px;
}
.v2-relay-script-disclosure small,
.v2-relay-deploy-form small,
.v2-relay-job-card small {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 18px;
}
.v2-relay-connection-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
}
.v2-relay-card,
.v2-relay-deploy-form,
.v2-relay-job-card {
  min-width: 0;
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  background: var(--v2-surface);
}
.v2-relay-card > header,
.v2-relay-deploy-form > header,
.v2-relay-job-card > header,
.v2-relay-job-card > footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.v2-relay-card > header > span {
  display: inline-flex;
  align-items: center;
  gap: 7px;
}
.v2-relay-card > p,
.v2-relay-job-card > p {
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 19px;
}
.v2-relay-card .el-form {
  margin-top: 14px;
}
.v2-relay-copy-row {
  display: grid;
  width: 100%;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px;
}
.v2-relay-card__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}
.v2-relay-prerequisite {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 16px;
  border: 1px solid var(--v2-border);
  border-radius: 8px;
  color: var(--v2-text-soft);
}
.v2-relay-prerequisite > span {
  flex: 1;
}
.v2-relay-deploy-form > header {
  margin-bottom: 16px;
}
.v2-relay-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  column-gap: 22px;
}
.v2-relay-form-grid .el-select,
.v2-relay-form-grid .el-date-editor {
  width: 100%;
}
.v2-relay-jobs-region {
  margin-top: 14px;
}
.v2-relay-job-list {
  display: grid;
  gap: 10px;
}
.v2-relay-job-card__progress {
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr);
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  color: var(--v2-text-soft);
  font-size: 12px;
}
.v2-relay-job-card > p.is-error {
  color: var(--v3-danger);
}
.v2-relay-job-card > footer {
  margin-top: 12px;
  color: var(--v2-text-soft);
  font-size: 12px;
}
@media (max-width: 820px) {
  .v2-relay-connection-grid,
  .v2-relay-form-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 560px) {
  .v2-relay-script-drawer__body {
    padding: 12px 14px 18px;
  }
  .v2-relay-card,
  .v2-relay-deploy-form,
  .v2-relay-job-card {
    padding: 13px;
  }
  .v2-relay-card .el-form-item,
  .v2-relay-deploy-form .el-form-item {
    grid-template-columns: 112px minmax(0, 1fr);
  }
  .v2-relay-job-card > footer {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
