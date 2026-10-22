<template>
  <section class="online-panel" aria-label="官网人工验证">
    <V2SectionHeading title="官网人工验证" />
    <p>请本人完成下方验证。验证通过后会重新核对原账号和套餐，再继续本次任务。</p>
    <p>只可操作验证组件。关闭窗口或连接中断后，本次接管会停止。</p>
    <V2AsyncRegion
      :phase="query.phase.value"
      :resolved="query.hasData.value"
      :error="query.error.value ? '验证连接失败，操作已暂停' : ''"
      :empty="false"
      loading-title="正在连接官网验证"
      skeleton="detail"
      variant="section"
      @retry="refresh"
    >
      <p v-if="!verificationView.available" role="status">验证已结束或已失效，请刷新任务结果。</p>
      <template v-else>
        <p role="status">
          剩余 {{ remainingSeconds }} 秒<span v-if="verificationView.busy"
            >，其他管理员正在处理</span
          >
        </p>
        <AppButton
          v-if="!verificationView.owned"
          :disabled="verificationView.busy || busy"
          @click="act('claim')"
          >开始本人验证</AppButton
        >
        <template v-else>
          <button
            v-if="verificationView.screen"
            type="button"
            class="online-verification-screen"
            aria-label="点击官网验证组件"
            :disabled="blocked"
            @click="clickScreen"
          >
            <img
              :src="`data:image/png;base64,${verificationView.screen.image}`"
              alt="官网验证组件，按图中提示点击"
              draggable="false"
            />
          </button>
          <p v-else role="status">正在等待官网验证画面。</p>
          <div class="online-inline-actions">
            <AppButton variant="soft" :disabled="blocked" @click="act('continue')"
              >已完成，重新核验</AppButton
            >
            <AppButton variant="soft" :disabled="busy" @click="act('cancel')"
              >停止本次验证</AppButton
            >
          </div>
        </template>
      </template>
      <p v-if="error" role="alert" class="online-error">{{ error }}</p>
    </V2AsyncRegion>
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { sessionCoordinator } from '@/auth/sessionCoordinator';
import { onlineApi, type HumanVerificationView } from './api';

const props = defineProps<{ taskId: string }>();
const verificationView = ref<HumanVerificationView>({ available: false });
const busy = ref(false),
  error = ref(''),
  now = ref(Date.now());
let active = true,
  revision = 0;
const controller = new AbortController();
const instance = crypto.randomUUID();
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-jobs',
  scope: 'online-recharge',
  key: `human-verification:${props.taskId}:${instance}`,
  trackRouteData: false,
  keepPreviousData: true,
  query: async ({ signal }) => {
    const current = ++revision;
    const identity = sessionCoordinator.identityEpoch.value;
    const response = await onlineApi.humanVerification(props.taskId, { action: 'view' }, signal);
    if (active && current === revision && identity === sessionCoordinator.identityEpoch.value) {
      verificationView.value = response;
      error.value = '';
    }
    // The shared query cache contains no screen or interaction authority.
    return { available: response.available };
  }
});
const remainingSeconds = computed(() =>
  Math.max(0, Math.ceil(((verificationView.value.deadline ?? 0) - now.value) / 1000))
);
const blocked = computed(
  () =>
    busy.value ||
    verificationView.value.pending ||
    Boolean(query.error.value) ||
    Boolean(error.value) ||
    !verificationView.value.owned ||
    remainingSeconds.value <= 0
);
async function refresh() {
  if (!active || busy.value) return;
  await query.refresh();
}
async function act(action: string, extra: object = {}) {
  if (!active || busy.value) return;
  busy.value = true;
  error.value = '';
  const current = ++revision;
  const identity = sessionCoordinator.identityEpoch.value;
  try {
    const response = await onlineApi.humanVerification(
      props.taskId,
      { action, generation: verificationView.value.generation, ...extra },
      controller.signal
    );
    if (active && current === revision && identity === sessionCoordinator.identityEpoch.value)
      verificationView.value = response;
  } catch {
    if (active) error.value = '操作未能确认，请等待画面刷新后再试。';
  } finally {
    busy.value = false;
  }
}
function clickScreen(event: MouseEvent) {
  if (blocked.value || !verificationView.value.screen || event.detail === 0) return;
  const image = (event.currentTarget as HTMLElement).querySelector('img');
  if (!image) return;
  const rect = image.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;
  void act('click', {
    frameId: verificationView.value.screen.frameId,
    x: ((event.clientX - rect.left) * verificationView.value.screen.width) / rect.width,
    y: ((event.clientY - rect.top) * verificationView.value.screen.height) / rect.height
  });
}
const timer = setInterval(() => {
  now.value = Date.now();
  if (!query.isRefreshing.value && !query.isInitialLoading.value) void refresh();
}, 1000);
function dispose() {
  if (!active) return;
  active = false;
  revision++;
  clearInterval(timer);
  controller.abort();
  query.cancel();
  const previous = verificationView.value;
  verificationView.value = { available: false };
  if (previous.owned && previous.generation)
    void onlineApi
      .humanVerification(props.taskId, { action: 'cancel', generation: previous.generation })
      .catch(() => {});
}
const stopIdentityWatch = sessionCoordinator.subscribeIdentityChange(dispose);
onBeforeUnmount(() => {
  dispose();
  stopIdentityWatch();
});
</script>
