<template>
  <el-form-item label="付款安全上限">
    <div class="recharge-cap-control">
      <span :title="current ? `${current.maxAmount} ${currencyCode}` : '尚未配置'">{{
        current ? `${current.maxAmount} ${currencyCode}` : '尚未配置'
      }}</span>
      <AppButton
        link
        variant="primary"
        aria-label="设置上限"
        :loading="drawerLoading"
        @click="openDrawer"
        >设置</AppButton
      >
    </div>
  </el-form-item>
  <V2AsyncRegion
    v-if="drawerLoadError"
    variant="field"
    skeleton="control"
    phase="initial-error"
    :error="drawerLoadError"
    loading-title="正在加载付款上限设置"
    error-title="付款上限设置加载失败"
    @retry="openDrawer"
  />
  <V2RechargePaymentCapDrawer
    v-if="open"
    v-model="open"
    :plan="plan"
    :currency-code="currencyCode"
    :caps="caps"
    :phase="phase"
    :load-error="loadError"
    @retry="$emit('refresh')"
    @saved="$emit('refresh')"
  />
</template>

<script setup lang="ts">
import AppButton from '@/components/ui/AppButton.vue';
import { computed, defineAsyncComponent, ref } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import type { V2QueryPhase } from '@/v2/composables/useV2Query';
import type { V2RechargePaymentCap, V2RechargePlan } from './contracts';
const drawerLoading = ref(false);
const drawerLoadError = ref('');
let retryDrawer: (() => void) | undefined;
let retryUrl = '';
const V2RechargePaymentCapDrawer = defineAsyncComponent({
  loader: () => {
    drawerLoading.value = true;
    const request: Promise<typeof import('./V2RechargePaymentCapDrawer.vue')> = retryUrl
      ? import(/* @vite-ignore */ retryUrl)
      : import('./V2RechargePaymentCapDrawer.vue');
    return request.finally(() => {
      drawerLoading.value = false;
    });
  },
  onError(error, retry) {
    // Chromium caches failed module URLs; retry only this same-origin drawer chunk.
    const failedUrl = error.message.match(/https?:\/\/\S+/)?.[0];
    if (failedUrl) {
      const url = new URL(failedUrl);
      if (
        url.origin === window.location.origin &&
        /\/V2RechargePaymentCapDrawer(?:-[\w-]+\.js|\.vue)$/.test(url.pathname)
      ) {
        url.searchParams.set('t', String(Date.now()));
        retryUrl = url.href;
      }
    }
    drawerLoadError.value = '请检查网络后重新加载，当前页面的输入已保留。';
    retryDrawer = retry;
  }
});

const props = defineProps<{
  plan: V2RechargePlan;
  currencyCode: string;
  caps: V2RechargePaymentCap[];
  phase: V2QueryPhase;
  loadError: string;
}>();
defineEmits<{ refresh: [] }>();
const open = ref(false);
function openDrawer() {
  drawerLoadError.value = '';
  open.value = true;
  const retry = retryDrawer;
  retryDrawer = undefined;
  retry?.();
}
const current = computed(() =>
  props.caps.find((item) => item.plan === props.plan && item.currencyCode === props.currencyCode)
);
</script>

<style scoped>
.recharge-cap-control {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  min-width: 0;
  min-height: 36px;
  padding: 0 10px;
  border: 1px solid var(--el-border-color);
  border-radius: var(--el-border-radius-base);
  background: var(--el-fill-color-lighter);
  font-size: 13px;
  line-height: 20px;
}
.recharge-cap-control > span {
  min-width: 0;
  overflow-wrap: anywhere;
  font-variant-numeric: tabular-nums;
}
.recharge-cap-control :deep(.el-button) {
  flex: 0 0 auto;
  margin: 0;
  padding: 0;
}
@media (max-width: 900px) {
  .recharge-cap-control {
    min-height: 44px;
  }
}
</style>
