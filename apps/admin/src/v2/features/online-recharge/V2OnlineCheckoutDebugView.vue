<template>
  <section v-if="canRead" class="v2-page-layout online-page">
    <V2PageContext description="按原逻辑生成支付链接，浏览器执行到付款前停止，不填写或提交银行卡。"
      ><template #actions
        ><AppButton v-if="canManage" variant="primary" @click="open = true"
          >生成支付链接</AppButton
        ></template
      ></V2PageContext
    ><V2AsyncRegion
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="form"
      loading-title="正在加载调试配置"
      @retry="query.refresh"
      ><section class="online-panel">
        <V2SectionHeading title="支付链接调试" />
        <p>默认使用已保存的地区和原版套餐映射；调试抽屉允许按原接口指定本次套餐标识。</p>
        <dl class="online-status-grid">
          <dt>支付地区</dt>
          <dd>{{ regionName }}</dd>
          <dt>调试方式</dt>
          <dd>付款前停止</dd>
        </dl>
        <p v-if="error" class="online-error" role="alert">{{ error }}</p>
      </section>
      <OnlineTaskProgress
        :task="task"
        :connected="tracker.connected.value"
        :error="tracker.error.value"
        @refresh="tracker.refresh" /></V2AsyncRegion
    ><OnlineActionDrawer
      v-model="open"
      section="checkout-debug"
      :action="action"
      @saved="onSaved"
    />
    <AppButton
      v-if="task?.status === 'succeeded' && canSensitive"
      variant="soft"
      @click="linkOpen = true"
      >查看支付链接</AppButton
    >
    <OnlineActionDrawer
      v-model="linkOpen"
      section="jobs"
      :action="linkAction"
      :row="taskRow"
      @saved="onLink"
    />
    <OnlineResultDialog v-model="resultOpen" :result="result" />
  </section>
</template>
<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import { useAuthStore } from '@/stores/auth';
import { canUseOnlineAction } from './permissions';
import { getApiErrorMessage } from '@/api/client';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2SessionDraft } from '@/v2/composables/useV2SessionDraft';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import OnlineActionDrawer from './OnlineActionDrawer.vue';
import OnlineResultDialog from './OnlineResultDialog.vue';
import OnlineTaskProgress from './OnlineTaskProgress.vue';
import { onlineApi } from './api';
import { planOptions, regionOptions } from './labels';
import type { OnlineAction, PublicTask } from './contracts';
import { useOnlineTask } from './useOnlineTask';
import './online-recharge.css';
const authStore = useAuthStore();
const canRead = computed(() => canUseOnlineAction(authStore.user, 'checkout-debug', 'detail'));
const canManage = computed(() => canUseOnlineAction(authStore.user, 'checkout-debug', 'start'));
const canSensitive = computed(() => canUseOnlineAction(authStore.user, 'jobs', 'checkout-link'));
const open = ref(false);
const linkOpen = ref(false);
const resultOpen = ref(false);
const result = ref<Record<string, unknown>>({});
watch(resultOpen, (value) => {
  if (!value) result.value = {};
});
watch(
  () => authStore.user?.id,
  () => {
    open.value = false;
    linkOpen.value = false;
    resultOpen.value = false;
    result.value = {};
    task.value = undefined;
    tracker.stop();
  }
);
const linkAction: OnlineAction = {
  key: 'checkout-link',
  label: '查看支付链接',
  fields: [{ key: 'reason', label: '查看原因', required: true }]
};
function onLink(value: Record<string, unknown>) {
  result.value = value;
  resultOpen.value = true;
}
const error = ref('');
const task = useV2SessionDraft('online-recharge/checkout-debug/task', () => ref<PublicTask>());
const taskRow = computed(() =>
  task.value ? { id: task.value.id, updatedAt: task.value.updatedAt } : undefined
);
const tracker = useOnlineTask(task, ref(''), false);
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-checkout-debug',
  scope: 'online-recharge',
  enabled: () => canUseOnlineAction(authStore.user, 'jobs', 'detail'),
  key: 'checkout-context',
  query: ({ signal }) => onlineApi.config(signal),
  keepPreviousData: true
});
const regionName = computed(
  () =>
    regionOptions.find((item) => item.value === query.data.value?.paymentRegion)?.label ??
    '等待配置'
);
const action = computed<OnlineAction>(() => ({
  key: 'start',
  label: '生成支付链接',
  fields: [
    { key: 'session', label: '完整会话资料', type: 'textarea', required: true, transient: true },
    {
      key: 'plan',
      label: '套餐',
      type: 'select',
      initial: 'plus',
      options: planOptions,
      required: true
    },
    {
      key: 'region',
      label: '支付地区',
      type: 'select',
      initial: String(query.data.value?.paymentRegion ?? 'PH'),
      options: regionOptions,
      required: true
    },
    { key: 'planName', label: '原版套餐标识', help: '留空使用已保存的原版套餐映射。' }
  ]
}));
function onSaved(value: Record<string, unknown>) {
  task.value = { ...value, taskToken: undefined } as unknown as PublicTask;
}
</script>
