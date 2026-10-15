<template>
  <section v-if="canRead" class="v2-page-layout online-page">
    <V2PageContext
      description="使用兑换码和账号会话资料提交内部充值任务，目标套餐由兑换码决定，自动核对首次开通或升级。"
    />
    <V2AsyncRegion
      :phase="config.phase.value"
      :error="config.error.value ? onlineError(config.error.value) : ''"
      skeleton="form"
      loading-title="正在读取兑换服务"
      @retry="config.refresh"
      ><section class="online-panel">
        <V2SectionHeading title="兑换资料" />
        <p v-if="config.data.value?.maintenanceMode || config.data.value?.available === false">
          当前暂停接收新任务，仍可查询已有兑换结果。
        </p>
        <p v-else>先验证兑换码，再提交完整会话资料。同档、降档或当前套餐不明时停止执行。</p>
        <p>
          当前任务 {{ config.data.value?.activeJobs ?? 0 }}／{{
            config.data.value?.capacity ?? 0
          }}；容量已满时请稍后再提交。
        </p>
        <el-form
          label-position="left"
          label-width="100px"
          require-asterisk-position="right"
          @submit.prevent="redeem"
          ><el-form-item label="兑换码" required
            ><el-input
              v-model="code"
              :disabled="Boolean(busy)"
              autocomplete="off"
              placeholder="输入兑换码"
              @update:model-value="verified = undefined" /></el-form-item
          ><el-form-item label="会话资料" required
            ><div class="online-field">
              <el-input
                v-model="session"
                :disabled="Boolean(busy)"
                type="textarea"
                :rows="8"
                autocomplete="off"
                placeholder="粘贴包含访问凭据的完整会话 JSON"
              /><small
                >会话资料仅用于对应兑换任务；刷新页面后清除，请勿提交密码或银行卡信息。</small
              >
            </div></el-form-item
          ><el-form-item label="目标套餐"
            ><span>{{
              verified ? onlineLabel(verified.plan) : '验证兑换码后显示'
            }}</span></el-form-item
          ><el-form-item label="操作"
            ><div class="online-actions">
              <AppButton
                variant="soft"
                :loading="busy === 'verify'"
                :disabled="Boolean(busy)"
                @click="verify"
                >验证兑换码</AppButton
              ><AppButton
                variant="primary"
                :loading="busy === 'redeem'"
                :disabled="
                  !canManage ||
                  Boolean(busy) ||
                  config.data.value?.maintenanceMode ||
                  config.data.value?.available === false
                "
                @click="redeem"
                >提交充值</AppButton
              ><AppButton
                variant="ghost"
                :loading="busy === 'query'"
                :disabled="Boolean(busy)"
                @click="recover"
                >查询兑换结果</AppButton
              >
            </div></el-form-item
          ></el-form
        >
        <p v-if="message" :role="failure ? 'alert' : 'status'" :class="{ 'online-error': failure }">
          {{ message }}
        </p>
      </section></V2AsyncRegion
    ><OnlineTaskProgress
      :task="task"
      :connected="tracker.connected.value"
      :error="tracker.error.value"
      @refresh="tracker.refresh"
    />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { useAuthStore } from '@/stores/auth';
import AppButton from '@/components/ui/AppButton.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { onlineApi } from './api';
import { onlineError, onlineLabel } from './labels';
import type { PublicTask } from './contracts';
import { useOnlineTask } from './useOnlineTask';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import { canUseOnlineAction } from './permissions';
import './online-recharge.css';
const authStore = useAuthStore();
const canRead = computed(() => canUseOnlineAction(authStore.user, 'jobs', 'detail'));
const canManage = computed(() => canUseOnlineAction(authStore.user, 'jobs', 'start'));
const code = useV2SessionDraft('online-recharge/redeem/code', () => ref(''));
const session = ref('');
const busy = ref('');
const message = ref('');
const failure = ref(false);
const verified = ref<{ plan: string; status: string }>();
const task = useV2SessionDraft('online-recharge/redeem/task', () => ref<PublicTask>());
const token = useV2SessionDraft('online-recharge/redeem/task-token', () => ref(''));
const tracker = useOnlineTask(task, token);
let active = true;
let requestRevision = 0;
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(() => {
  requestRevision++;
  code.value = '';
  session.value = '';
  verified.value = undefined;
  task.value = undefined;
  token.value = '';
  tracker.stop();
});
onBeforeUnmount(() => {
  session.value = '';
  active = false;
  requestRevision++;
  stopIdentityWatch();
});
const config = useV2ModuleQuery({
  moduleKey: 'online-recharge-redeem',
  scope: 'online-recharge',
  enabled: () => canRead.value,
  key: 'public-config',
  query: ({ signal }) => onlineApi.publicConfig(signal),
  keepPreviousData: true
});
async function perform(key: string, action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = key;
  message.value = '';
  failure.value = false;
  const revision = requestRevision;
  try {
    await action();
  } catch (cause) {
    if (!active || revision !== requestRevision) return;
    failure.value = true;
    message.value = onlineError(cause);
  } finally {
    busy.value = '';
  }
}
function verify() {
  return perform('verify', async () => {
    const revision = requestRevision;
    const value = await onlineApi.verify(code.value.trim());
    if (!active || revision !== requestRevision) return;
    verified.value = value;
    message.value = `兑换码验证成功，套餐：${onlineLabel(verified.value.plan)}`;
  });
}
function recover() {
  return perform('query', async () => {
    const revision = requestRevision;
    const value = await onlineApi.query(code.value.trim());
    if (!active || revision !== requestRevision) return;
    if (!value.task) {
      message.value = '此兑换码尚未创建充值任务';
      return;
    }
    task.value = value.task;
    token.value = value.taskToken ?? value.task.taskToken ?? '';
    message.value = '已恢复原任务进度';
  });
}
function redeem() {
  return perform('redeem', async () => {
    const revision = requestRevision;
    if (!canManage.value) throw new Error('没有提交充值的权限');
    if (!verified.value) throw new Error('请先验证兑换码');
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(session.value);
    } catch {
      throw new Error('请填写完整的会话 JSON');
    }
    if (!parsed?.accessToken) throw new Error('会话资料缺少访问凭据');
    const value = await onlineApi.redeem(code.value.trim(), session.value);
    if (!active || revision !== requestRevision) return;
    task.value = value;
    token.value = value.taskToken ?? '';
    session.value = '';
    message.value = '任务已创建，请在下方查看进度';
  });
}
</script>
