<template>
  <main class="online-public v2-page-layout">
    <header>
      <h1>订阅与账单查询</h1>
      <RouterLink to="/online-recharge">返回兑换入口</RouterLink>
    </header>
    <section class="online-panel">
      <V2SectionHeading title="查询当前订阅" /><el-form
        label-position="left"
        label-width="100px"
        require-asterisk-position="right"
        @submit.prevent="submit"
        ><el-form-item label="会话资料" required
          ><div class="online-field">
            <el-input
              v-model="session"
              type="textarea"
              :rows="8"
              autocomplete="off"
              placeholder="粘贴包含访问凭据的完整会话 JSON"
            /><small>用于查询当前账户订阅状态、到期时间和续费状态；不提交支付。</small>
          </div></el-form-item
        ><el-form-item label="操作"
          ><AppButton variant="primary" :loading="busy" :disabled="busy" @click="submit"
            >查询订阅</AppButton
          ></el-form-item
        ></el-form
      >
      <p v-if="error" role="alert" class="online-error">{{ error }}</p>
    </section>
    <OnlineTaskProgress
      :task="task"
      :connected="tracker.connected.value"
      :error="tracker.error.value"
      @refresh="tracker.refresh"
    />
    <section class="online-panel">
      <V2SectionHeading title="发票下载指引" />
      <p>
        在账户的订阅设置中打开账单管理，选择对应账单并下载发票。查询成功后，如服务端返回可用账单入口，会在结果中显示。
      </p>
    </section>
  </main>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { onlineApi } from './api';
import { onlineError } from './labels';
import type { PublicTask } from './contracts';
import { useOnlineTask } from './useOnlineTask';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import '@/v2/styles/base.css';
import '@/v2/styles/layout.css';
import './online-recharge.css';
const session = ref('');
const busy = ref(false);
const error = ref('');
const task = useV2SessionDraft('online-recharge/public/subscription-task', () => ref<PublicTask>());
const token = useV2SessionDraft('online-recharge/public/subscription-token', () => ref(''));
const tracker = useOnlineTask(task, token);
let active = true;
let requestRevision = 0;
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(() => {
  requestRevision++;
  session.value = '';
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
async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  const revision = requestRevision;
  try {
    const parsed = JSON.parse(session.value);
    if (!parsed?.accessToken) throw new Error('会话资料缺少访问凭据');
    const value = await onlineApi.subscription(session.value);
    if (!active || revision !== requestRevision) return;
    task.value = value;
    token.value = value.taskToken ?? '';
    session.value = '';
  } catch (cause) {
    if (!active || revision !== requestRevision) return;
    error.value = cause instanceof SyntaxError ? '请填写完整的会话 JSON' : onlineError(cause);
  } finally {
    busy.value = false;
  }
}
</script>
