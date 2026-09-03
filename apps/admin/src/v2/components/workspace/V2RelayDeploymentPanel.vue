<template>
  <div v-if="!ready" class="v2-relay-prerequisite">
    <el-icon><Warning /></el-icon>
    <span>请先完成 Google Cloud 授权并连接中转站管理员账号。</span>
    <AppButton size="small" variant="soft" @click="$emit('openSettings')">去设置</AppButton>
  </div>
  <template v-else>
    <V2AsyncRegion
      :phase="optionsQuery.phase.value"
      :empty="false"
      :error="optionsError"
      variant="section"
      skeleton="form"
      loading-title="正在读取结算账号和中转站配置"
      refreshing-title="正在更新部署选项"
      error-title="部署选项加载失败"
      @retry="optionsQuery.refresh"
    >
      <section v-if="options" class="v2-relay-deploy-form">
        <header>
          <div>
            <strong>新建 Vertex 部署任务</strong
            ><small>模型白名单从已启用的 Vertex 参考账号复制。</small>
          </div>
          <AppButton size="small" variant="ghost" @click="optionsQuery.refresh">刷新选项</AppButton>
        </header>
        <el-form
          label-position="left"
          label-width="142px"
          require-asterisk-position="right"
          @submit.prevent
        >
          <div class="v2-relay-form-grid">
            <el-form-item label="账号标记" required
              ><el-input v-model="form.accountLabel" maxlength="80"
            /></el-form-item>
            <el-form-item label="谷歌项目 ID" required
              ><el-input
                v-model="form.projectId"
                maxlength="30"
                placeholder="例如：英文小写项目标识"
            /></el-form-item>
            <el-form-item label="项目显示名称" required
              ><el-input v-model="form.projectDisplayName" maxlength="80"
            /></el-form-item>
            <el-form-item label="结算账号" required>
              <el-select v-model="form.billingAccount" filterable placeholder="请选择">
                <el-option
                  v-for="item in options.billingAccounts"
                  :key="String(item.id)"
                  :label="item.label"
                  :value="String(item.id)"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="参考账号" required>
              <el-select v-model="form.referenceAccountId" filterable placeholder="请选择">
                <el-option
                  v-for="item in options.referenceAccounts"
                  :key="item.id"
                  :label="`${item.label}（${item.models.length} 个模型）`"
                  :value="item.id"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="目标分组" required>
              <el-select v-model="form.targetGroupId" filterable placeholder="请选择">
                <el-option
                  v-for="item in options.groups"
                  :key="Number(item.id)"
                  :label="item.label"
                  :value="Number(item.id)"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="代理节点">
              <el-select v-model="form.proxyId" clearable filterable placeholder="不使用代理">
                <el-option
                  v-for="item in options.proxies"
                  :key="Number(item.id)"
                  :label="item.label"
                  :value="Number(item.id)"
                />
              </el-select>
            </el-form-item>
            <el-form-item label="Vertex 区域" required
              ><el-input v-model="form.location" maxlength="40"
            /></el-form-item>
            <el-form-item label="赠金到期日">
              <el-date-picker
                v-model="form.creditExpiresAt"
                type="date"
                value-format="YYYY-MM-DD"
                placeholder="可选"
              />
            </el-form-item>
          </div>
        </el-form>
        <div class="v2-relay-card__actions">
          <AppButton
            variant="primary"
            :loading="creatingJob"
            :disabled="!writesAllowed"
            @click="createAndRunJob"
            >创建并自动执行</AppButton
          >
        </div>
      </section>
    </V2AsyncRegion>

    <V2AsyncRegion
      class="v2-relay-jobs-region"
      :phase="jobsQuery.phase.value"
      :empty="jobs.length === 0"
      :error="jobsError"
      variant="section"
      skeleton="cards"
      loading-title="正在读取部署任务"
      refreshing-title="正在更新部署任务"
      empty-title="还没有部署任务"
      empty-message="填写上方表单后创建第一个任务。"
      error-title="部署任务加载失败"
      @retry="jobsQuery.refresh"
    >
      <div class="v2-relay-job-list">
        <article v-for="job in jobs" :key="job.id" class="v2-relay-job-card">
          <header>
            <div>
              <strong>{{ job.projectId }}</strong
              ><small>{{ job.accountLabel }} · {{ job.projectDisplayName }}</small>
            </div>
            <el-tag :type="jobStatusType(job.status)" effect="plain">{{
              jobStatusLabel(job.status)
            }}</el-tag>
          </header>
          <div class="v2-relay-job-card__progress">
            <span>{{ job.completedSteps.length }} / {{ V2_RELAY_JOB_STEPS.length }}</span>
            <el-progress :percentage="progressPercent(job)" :show-text="false" :stroke-width="6" />
          </div>
          <p v-if="job.currentStep">当前步骤：{{ stepLabel(job.currentStep) }}</p>
          <p v-if="job.lastErrorMessage" class="is-error" role="alert">
            {{ job.lastErrorMessage }}
          </p>
          <footer>
            <span
              >中转站账号：{{
                job.cloudBridgeAccountId ? `#${job.cloudBridgeAccountId}` : '尚未创建'
              }}</span
            >
            <AppButton
              v-if="job.status !== 'completed'"
              size="small"
              :variant="job.status === 'failed' ? 'soft' : 'primary'"
              :loading="runningJobId === job.id"
              :disabled="Boolean(runningJobId) || !writesAllowed"
              @click="runJob(job)"
              >{{ job.status === 'failed' ? '重试并继续' : '继续自动执行' }}</AppButton
            >
          </footer>
        </article>
      </div>
    </V2AsyncRegion>
  </template>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import {
  V2_RELAY_JOB_STEPS,
  type V2RelayDeploymentOptions,
  type V2RelayJob,
  type V2RelayJobList,
  type V2RelayJobStatus,
  type V2RelayJobStep
} from '@apple-business/shared';
import { Warning } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';

const props = defineProps<{ active: boolean; ready: boolean; writesAllowed: boolean }>();
const emit = defineEmits<{ openSettings: []; runningChange: [value: boolean] }>();
const creatingJob = ref(false);
const runningJobId = ref<string | null>(null);
const runGeneration = ref(0);
const form = reactive({
  accountLabel: '',
  billingAccount: '',
  creditExpiresAt: '',
  location: 'global',
  projectDisplayName: '',
  projectId: '',
  proxyId: null as number | null,
  referenceAccountId: null as number | null,
  targetGroupId: null as number | null
});

const optionsQuery = useV2ModuleQuery<V2RelayDeploymentOptions>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'relay-options',
  enabled: () => props.active,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.getRelayDeploymentOptions({ signal })
});
const jobsQuery = useV2ModuleQuery<V2RelayJobList>({
  moduleKey: 'profile',
  scope: 'workspace',
  key: 'relay-jobs',
  enabled: () => props.active,
  trackRouteData: false,
  query: ({ signal }) => idBusinessV2WorkspaceApi.listRelayJobs({ signal })
});
const options = computed(() => optionsQuery.data.value);
const jobs = computed(() => jobsQuery.data.value?.items ?? []);
const optionsError = computed(() =>
  optionsQuery.error.value ? getApiErrorMessage(optionsQuery.error.value) : ''
);
const jobsError = computed(() =>
  jobsQuery.error.value ? getApiErrorMessage(jobsQuery.error.value) : ''
);

async function createAndRunJob() {
  if (
    !form.accountLabel.trim() ||
    !form.projectId.trim() ||
    !form.projectDisplayName.trim() ||
    !form.billingAccount ||
    !form.referenceAccountId ||
    !form.targetGroupId
  ) {
    return void ElMessage.warning('请填写全部必填项');
  }
  creatingJob.value = true;
  try {
    const job = await idBusinessV2WorkspaceApi.createRelayJob({
      accountLabel: form.accountLabel.trim(),
      billingAccount: form.billingAccount,
      ...(form.creditExpiresAt ? { creditExpiresAt: form.creditExpiresAt } : {}),
      location: form.location.trim(),
      projectDisplayName: form.projectDisplayName.trim(),
      projectId: form.projectId.trim(),
      proxyId: form.proxyId,
      referenceAccountId: form.referenceAccountId,
      targetGroupId: form.targetGroupId
    });
    await jobsQuery.refresh();
    ElMessage.success('部署任务已创建');
    await runJob(job);
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    creatingJob.value = false;
  }
}

async function runJob(initialJob: V2RelayJob) {
  if (runningJobId.value) return;
  const generation = runGeneration.value + 1;
  runGeneration.value = generation;
  runningJobId.value = initialJob.id;
  emit('runningChange', true);
  let current = initialJob;
  try {
    for (let attempt = 0; attempt < 120 && runGeneration.value === generation; attempt += 1) {
      const previousCount = current.completedSteps.length;
      const previousStep = current.currentStep;
      current = await idBusinessV2WorkspaceApi.runRelayJob(current.id);
      await jobsQuery.refresh();
      if (current.status === 'completed')
        return void ElMessage.success(`${current.projectId} 已部署并通过逐模型验收`);
      if (current.status === 'failed')
        return void ElMessage.error(current.lastErrorMessage || '部署任务执行失败');
      if (current.completedSteps.length === previousCount && current.currentStep === previousStep) {
        await new Promise((resolve) => window.setTimeout(resolve, 1800));
      }
    }
    if (runGeneration.value === generation) ElMessage.warning('自动执行已暂停，可点击继续');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    if (runGeneration.value === generation) runningJobId.value = null;
    emit('runningChange', false);
    await jobsQuery.refresh();
  }
}

function stop() {
  runGeneration.value += 1;
  runningJobId.value = null;
  emit('runningChange', false);
}

function progressPercent(job: V2RelayJob) {
  return Math.round((job.completedSteps.length / V2_RELAY_JOB_STEPS.length) * 100);
}

function jobStatusLabel(status: V2RelayJobStatus) {
  return (
    {
      draft: '待执行',
      running: '执行中',
      action_required: '待处理',
      completed: '已完成',
      failed: '执行失败'
    } as const
  )[status];
}

function jobStatusType(status: V2RelayJobStatus) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'warning';
  return 'info';
}

function stepLabel(step: V2RelayJobStep) {
  return (
    {
      create_project: '创建或确认 Google 项目',
      link_billing: '绑定结算账号',
      enable_services: '启用 Google Cloud API',
      create_service_account: '创建服务账号',
      grant_permissions: '授予 Vertex 权限',
      create_service_account_key: '创建并加密保存服务账号密钥',
      create_cloudbridge_account: '创建中转站 Vertex 账号',
      test_models: '逐模型验收',
      attach_group: '加入正式分组并启用调度'
    } as const
  )[step];
}

defineExpose({ stop });
</script>
