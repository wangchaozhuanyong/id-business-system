<template>
  <div v-if="!ready" class="v2-relay-prerequisite">
    <el-icon><Warning /></el-icon>
    <span>请先连接中转站管理员账号。</span>
    <AppButton size="small" variant="soft" @click="$emit('openSettings')">去设置</AppButton>
  </div>
  <template v-else>
    <V2AsyncRegion
      :phase="optionsQuery.phase.value"
      :empty="false"
      :error="optionsError"
      variant="section"
      skeleton="form"
      loading-title="正在读取中转站部署选项"
      refreshing-title="正在更新部署选项"
      error-title="部署选项加载失败"
      @retry="optionsQuery.refresh"
    >
      <template #error-action>
        <AppButton variant="primary" allow-when-stale @click="recoverOptions">
          {{ requiresReconnect ? '重新连接中转站' : '重新加载' }}
        </AppButton>
      </template>
      <section v-if="options" class="v2-relay-deploy-form">
        <header>
          <div>
            <strong>新建中转站部署任务</strong>
            <small>{{ modeDescription }}</small>
          </div>
          <AppButton size="small" variant="ghost" @click="optionsQuery.refresh">刷新选项</AppButton>
        </header>

        <el-radio-group v-model="form.mode" class="v2-relay-mode-picker" @change="resetModeFields">
          <el-radio-button value="antigravity_subscription">Gemini 订阅号</el-radio-button>
          <el-radio-button value="gemini_api">AI Studio 密钥</el-radio-button>
          <el-radio-button value="vertex">Vertex 云端模式</el-radio-button>
        </el-radio-group>

        <div v-if="form.mode === 'vertex' && !googleReady" class="v2-relay-prerequisite">
          <el-icon><Warning /></el-icon>
          <span>Vertex AI 模式还需要先完成 Google Cloud 授权。</span>
          <AppButton size="small" variant="soft" @click="$emit('openSettings')">去授权</AppButton>
        </div>

        <el-form
          label-position="left"
          label-width="142px"
          require-asterisk-position="right"
          @submit.prevent
        >
          <div class="v2-relay-form-grid">
            <el-form-item label="任务标识" required>
              <el-input
                v-model="form.deploymentKey"
                maxlength="80"
                placeholder="小写字母、数字、短横线或下划线"
              />
            </el-form-item>
            <el-form-item label="账号标记" required>
              <el-input v-model="form.accountLabel" maxlength="80" />
            </el-form-item>

            <template v-if="form.mode === 'antigravity_subscription'">
              <el-form-item label="Google 订阅账号" required>
                <el-input v-model="form.googleEmail" maxlength="254" placeholder="name@gmail.com" />
              </el-form-item>
              <el-form-item label="参考账号" required>
                <el-select
                  v-model="form.referenceAccountId"
                  filterable
                  placeholder="请选择"
                  @change="syncReferenceSettings"
                >
                  <el-option
                    v-for="item in options.subscriptionReferenceAccounts"
                    :key="item.id"
                    :label="`${item.label}（${item.models.length} 个模型）`"
                    :value="item.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="同步模型" required class="v2-relay-form-grid__wide">
                <el-select
                  v-model="form.selectedModels"
                  multiple
                  collapse-tags
                  collapse-tags-tooltip
                  filterable
                  placeholder="请先选择参考账号"
                >
                  <el-option
                    v-for="model in subscriptionModels"
                    :key="model"
                    :label="model"
                    :value="model"
                  />
                </el-select>
              </el-form-item>
            </template>

            <template v-else-if="form.mode === 'gemini_api'">
              <el-form-item label="Gemini 接口密钥" required class="v2-relay-form-grid__wide">
                <el-input
                  v-model="form.apiKey"
                  type="password"
                  show-password
                  maxlength="500"
                  autocomplete="off"
                  placeholder="仅加密暂存到任务完成"
                />
              </el-form-item>
              <el-form-item label="固定模型" class="v2-relay-form-grid__wide">
                <div class="v2-relay-fixed-models">
                  <el-tag effect="plain"><code>gemini-3.7-flash</code></el-tag>
                  <el-tag effect="plain"><code>gemini-3.1-flash-tts-preview</code></el-tag>
                </div>
              </el-form-item>
            </template>

            <template v-else>
              <el-form-item label="谷歌项目 ID" required>
                <el-input
                  v-model="form.projectId"
                  maxlength="30"
                  placeholder="例如：英文小写项目标识"
                />
              </el-form-item>
              <el-form-item label="项目显示名称" required>
                <el-input v-model="form.projectDisplayName" maxlength="80" />
              </el-form-item>
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
              <el-form-item label="Vertex 参考账号" required>
                <el-select
                  v-model="form.referenceAccountId"
                  filterable
                  placeholder="请选择"
                  @change="syncReferenceSettings"
                >
                  <el-option
                    v-for="item in options.vertexReferenceAccounts"
                    :key="item.id"
                    :label="`${item.label}（${item.models.length} 个模型）`"
                    :value="item.id"
                  />
                </el-select>
              </el-form-item>
              <el-form-item label="Vertex 区域" required>
                <el-input v-model="form.location" maxlength="40" />
              </el-form-item>
            </template>

            <el-form-item label="目标分组" required>
              <el-select v-model="form.targetGroupId" filterable placeholder="请选择">
                <el-option
                  v-for="item in targetGroups"
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
            <el-form-item label="并发数" required>
              <el-input-number v-model="form.accountConcurrency" :min="1" :max="1000" />
            </el-form-item>
            <el-form-item label="负载系数" required>
              <el-input-number
                v-model="form.accountLoadFactor"
                :min="0.01"
                :max="10000"
                :precision="2"
              />
            </el-form-item>
            <el-form-item label="调度优先级" required>
              <el-input-number v-model="form.accountPriority" :min="1" :max="9999" />
            </el-form-item>
            <el-form-item label="费率倍率" required>
              <el-input-number
                v-model="form.accountRateMultiplier"
                :min="0.01"
                :max="1000"
                :precision="2"
              />
            </el-form-item>
            <template v-if="form.mode === 'antigravity_subscription'">
              <el-form-item label="允许超额">
                <el-switch v-model="form.allowOverages" />
              </el-form-item>
              <el-form-item label="混合调度">
                <el-switch v-model="form.mixedScheduling" />
              </el-form-item>
            </template>
            <el-form-item v-if="form.mode === 'vertex'" label="赠金到期日">
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
            :disabled="!writesAllowed || requiresReconnect"
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
              <strong>{{ job.deploymentKey }}</strong>
              <small>{{ v2RelayModeLabel(job.mode) }} · {{ job.accountLabel }}</small>
            </div>
            <el-tag :type="jobStatusType(job.status)" effect="plain">
              {{ v2RelayJobStatusLabel(job.status) }}
            </el-tag>
          </header>
          <div class="v2-relay-job-card__progress">
            <span>{{ job.completedSteps.length }} / {{ job.totalSteps }}</span>
            <el-progress :percentage="progressPercent(job)" :show-text="false" :stroke-width="6" />
          </div>
          <p v-if="job.currentStep">当前步骤：{{ v2RelayStepLabel(job.currentStep) }}</p>
          <p v-if="job.lastErrorMessage" class="is-error" role="alert">
            {{ job.lastErrorMessage }}
          </p>

          <div
            v-if="
              job.mode === 'antigravity_subscription' &&
              (job.status === 'action_required' || job.status === 'failed')
            "
            class="v2-relay-authorization"
          >
            <AppButton
              v-if="!authorizationUrls[job.id]"
              size="small"
              variant="soft"
              :loading="authorizingJobId === job.id"
              :disabled="!writesAllowed"
              @click="startSubscriptionAuthorization(job)"
              >生成 Google 授权链接</AppButton
            >
            <a v-else :href="authorizationUrls[job.id]" target="_blank" rel="noopener noreferrer"
              >打开 Google 授权页</a
            >
            <el-input
              v-model="callbackUrls[job.id]"
              maxlength="8192"
              placeholder="授权后粘贴 http://localhost:8085/callback?... 完整地址"
            />
            <AppButton
              size="small"
              variant="primary"
              :loading="authorizingJobId === job.id"
              :disabled="!writesAllowed"
              @click="completeSubscriptionAuthorization(job)"
              >提交回调并继续</AppButton
            >
          </div>

          <footer>
            <span>
              中转站账号：{{
                job.cloudBridgeAccountId ? `#${job.cloudBridgeAccountId}` : '尚未创建'
              }}
            </span>
            <AppButton
              v-if="job.status !== 'completed' && job.status !== 'action_required'"
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
import type {
  V2RelayDeploymentMode,
  V2RelayDeploymentOptions,
  V2RelayJob,
  V2RelayJobList,
  V2RelayJobStatus
} from '@apple-business/shared';
import { Warning } from '@element-plus/icons-vue';
import { ElMessage } from 'element-plus';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import { isApiError } from '@/api/apiError';
import { idBusinessV2WorkspaceApi } from '@/v2/api/workspace';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import {
  V2_RELAY_MODE_DESCRIPTIONS,
  v2RelayJobStatusLabel,
  v2RelayModeLabel,
  v2RelayStepLabel
} from './v2-relay-deployment-labels';

const props = defineProps<{
  active: boolean;
  googleReady: boolean;
  ready: boolean;
  writesAllowed: boolean;
}>();
const emit = defineEmits<{ openSettings: []; runningChange: [value: boolean] }>();
const creatingJob = ref(false);
const runningJobId = ref<string | null>(null);
const authorizingJobId = ref<string | null>(null);
const runGeneration = ref(0);
const authorizationUrls = reactive<Record<string, string>>({});
const callbackUrls = reactive<Record<string, string>>({});
const form = reactive({
  accountConcurrency: 1,
  accountLabel: '',
  accountLoadFactor: 1,
  accountPriority: 1,
  accountRateMultiplier: 1,
  allowOverages: false,
  apiKey: '',
  billingAccount: '',
  creditExpiresAt: '',
  deploymentKey: '',
  googleEmail: '',
  location: 'global',
  mode: 'antigravity_subscription' as V2RelayDeploymentMode,
  mixedScheduling: false,
  projectDisplayName: '',
  projectId: '',
  proxyId: null as number | null,
  referenceAccountId: null as number | null,
  selectedModels: [] as string[],
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
const targetGroups = computed(() =>
  form.mode === 'antigravity_subscription'
    ? (options.value?.antigravityGroups ?? [])
    : (options.value?.geminiGroups ?? [])
);
const subscriptionModels = computed(
  () =>
    options.value?.subscriptionReferenceAccounts.find((item) => item.id === form.referenceAccountId)
      ?.models ?? []
);
const modeDescription = computed(() => V2_RELAY_MODE_DESCRIPTIONS[form.mode]);
const optionsError = computed(() =>
  optionsQuery.error.value ? getApiErrorMessage(optionsQuery.error.value) : ''
);
const requiresReconnect = computed(() => {
  const error = optionsQuery.error.value;
  return (
    isApiError(error) &&
    ['RELAY_CLOUDBRIDGE_RECONNECT_REQUIRED', 'RELAY_CLOUDBRIDGE_PERMISSION_DENIED'].includes(
      error.code
    )
  );
});

function recoverOptions() {
  if (requiresReconnect.value) emit('openSettings');
  else void optionsQuery.refresh();
}

const jobsError = computed(() =>
  jobsQuery.error.value ? getApiErrorMessage(jobsQuery.error.value) : ''
);

function resetModeFields() {
  form.referenceAccountId = null;
  form.selectedModels = [];
  form.targetGroupId = null;
  form.accountConcurrency = 1;
  form.accountLoadFactor = form.mode === 'antigravity_subscription' ? 1 : 20;
  form.accountPriority = form.mode === 'antigravity_subscription' ? 1 : 99;
  form.accountRateMultiplier = 1;
  form.allowOverages = false;
  form.mixedScheduling = false;
}

function syncReferenceSettings() {
  const references =
    form.mode === 'antigravity_subscription'
      ? options.value?.subscriptionReferenceAccounts
      : options.value?.vertexReferenceAccounts;
  const reference = references?.find((item) => item.id === form.referenceAccountId);
  if (!reference) return;
  if (form.mode === 'antigravity_subscription') {
    form.selectedModels = [...reference.models];
    form.allowOverages = reference.allowOverages ?? false;
    form.mixedScheduling = reference.mixedScheduling ?? false;
  }
  form.accountConcurrency = reference.concurrency ?? 1;
  form.accountLoadFactor = reference.loadFactor ?? 1;
  form.accountRateMultiplier = reference.rateMultiplier ?? 1;
}

async function createAndRunJob() {
  if (!validForm()) return void ElMessage.warning('请填写当前部署模式的全部必填项');
  creatingJob.value = true;
  try {
    const job = await idBusinessV2WorkspaceApi.createRelayJob({
      accountLabel: form.accountLabel.trim(),
      accountConcurrency: form.accountConcurrency,
      accountLoadFactor: form.accountLoadFactor,
      accountPriority: form.accountPriority,
      accountRateMultiplier: form.accountRateMultiplier,
      allowOverages: form.allowOverages,
      deploymentKey: form.deploymentKey.trim(),
      mode: form.mode,
      mixedScheduling: form.mixedScheduling,
      targetGroupId: form.targetGroupId as number,
      proxyId: form.proxyId,
      ...(form.creditExpiresAt ? { creditExpiresAt: form.creditExpiresAt } : {}),
      ...(form.mode === 'antigravity_subscription'
        ? {
            googleEmail: form.googleEmail.trim(),
            referenceAccountId: form.referenceAccountId as number,
            selectedModels: form.selectedModels
          }
        : {}),
      ...(form.mode === 'gemini_api' ? { apiKey: form.apiKey } : {}),
      ...(form.mode === 'vertex'
        ? {
            billingAccount: form.billingAccount,
            location: form.location.trim(),
            projectDisplayName: form.projectDisplayName.trim(),
            projectId: form.projectId.trim(),
            referenceAccountId: form.referenceAccountId as number
          }
        : {})
    });
    form.apiKey = '';
    await jobsQuery.refresh();
    ElMessage.success('部署任务已创建');
    await runJob(job);
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    creatingJob.value = false;
  }
}

function validForm() {
  if (!form.accountLabel.trim() || !form.deploymentKey.trim() || !form.targetGroupId) return false;
  if (form.mode === 'antigravity_subscription')
    return Boolean(
      form.googleEmail.trim() && form.referenceAccountId && form.selectedModels.length
    );
  if (form.mode === 'gemini_api') return Boolean(form.apiKey.trim());
  return Boolean(
    props.googleReady &&
    form.projectId.trim() &&
    form.projectDisplayName.trim() &&
    form.billingAccount &&
    form.referenceAccountId &&
    form.location.trim()
  );
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
        return void ElMessage.success(`${current.deploymentKey} 已部署并通过验收`);
      if (current.status === 'action_required')
        return void ElMessage.warning('请完成 Google 订阅号授权后继续');
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

async function startSubscriptionAuthorization(job: V2RelayJob) {
  authorizingJobId.value = job.id;
  try {
    const result = await idBusinessV2WorkspaceApi.startRelaySubscriptionAuthorization(job.id);
    authorizationUrls[job.id] = result.authorizationUrl;
    ElMessage.success('授权链接已生成，请在新页面完成授权');
  } catch (error) {
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    authorizingJobId.value = null;
    await jobsQuery.refresh();
  }
}

async function completeSubscriptionAuthorization(job: V2RelayJob) {
  if (!callbackUrls[job.id]?.trim()) return void ElMessage.warning('请先粘贴完整的授权回调地址');
  authorizingJobId.value = job.id;
  try {
    const updated = await idBusinessV2WorkspaceApi.completeRelaySubscriptionAuthorization(job.id, {
      callbackUrl: callbackUrls[job.id].trim()
    });
    delete callbackUrls[job.id];
    delete authorizationUrls[job.id];
    await jobsQuery.refresh();
    ElMessage.success('订阅号授权已完成');
    await runJob(updated);
  } catch (error) {
    delete authorizationUrls[job.id];
    ElMessage.error(getApiErrorMessage(error));
  } finally {
    authorizingJobId.value = null;
  }
}

function stop() {
  runGeneration.value += 1;
  runningJobId.value = null;
  emit('runningChange', false);
}

function progressPercent(job: V2RelayJob) {
  return Math.round((job.completedSteps.length / job.totalSteps) * 100);
}

function jobStatusType(status: V2RelayJobStatus) {
  if (status === 'completed') return 'success';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'warning';
  return 'info';
}

defineExpose({ stop, refreshOptions: optionsQuery.refresh });
</script>
