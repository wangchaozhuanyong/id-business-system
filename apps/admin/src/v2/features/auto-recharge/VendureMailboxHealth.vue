<template>
  <V2AsyncRegion
    skeleton="settings"
    :phase="healthQuery.phase.value"
    :error="healthQuery.error.value ? getApiErrorMessage(healthQuery.error.value) : ''"
    loading-title="正在检查邮件自动收信"
    error-title="健康检查失败，以下信息为上次结果"
    @retry="refreshHealth"
  >
    <V2PageOverview
      title="自动收信状态"
      :help="description"
      :columns="4"
      metrics-label="邮件实时链路状态"
    >
      <template #meta>
        <span v-if="healthQuery.data.value"
          >检查于 {{ formatV2DateTime(healthQuery.data.value.checkedAt) }}</span
        >
        <span v-if="healthQuery.data.value?.status !== 'available'">{{ description }}</span>
      </template>
      <template #metrics>
        <V2OverviewMetric
          label="后台"
          :value="apiConnected ? '已连接' : '未连接'"
          note="仅代表邮件后台可访问"
        />
        <V2OverviewMetric
          label="收信"
          :value="listenerValue"
          :note="mailboxListenerSummary(healthQuery.data.value)"
        />
        <V2OverviewMetric
          label="投递"
          :value="deliveryValue"
          :note="mailboxDeliverySummary(healthQuery.data.value)"
        />
        <V2OverviewMetric label="页面" :value="streamLabel" :note="streamNote" />
      </template>
      <template #actions
        ><AppButton variant="soft" @click="refreshHealth">刷新状态</AppButton></template
      >
    </V2PageOverview>
  </V2AsyncRegion>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, watch } from 'vue';
import type { V2VendureMailboxHealth } from '@apple-business/shared';
import { getApiErrorMessage } from '@/api/client';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { v2ChangeSyncState } from '@/v2/runtime/changeSync';
import { formatV2DateTime } from '@/v2/utils/dateTime';
import { vendureMailboxApi } from './vendure-mailbox-api';
import { mailboxDeliverySummary, mailboxListenerSummary } from './vendure-mailbox-health';

const props = defineProps<{ enabled: boolean; apiConnected: boolean; refreshVersion: number }>();
const healthQuery = useV2ModuleQuery<V2VendureMailboxHealth>({
  moduleKey: 'vendure-mailbox',
  scope: 'vendure-mailbox',
  key: 'vendure-mailbox-health',
  enabled: () => props.enabled,
  trackRouteData: false,
  query: ({ signal }) => vendureMailboxApi.health({ signal })
});
const streamLabel = computed(
  () =>
    ({
      idle: '未连接',
      connecting: '连接中',
      connected: '已连接',
      degraded: '恢复中'
    })[v2ChangeSyncState.status]
);
const streamNote = computed(() =>
  v2ChangeSyncState.status === 'degraded' ? '连接异常，正在恢复' : '连接恢复后自动核对版本'
);
const listenerValue = computed(() => {
  const health = healthQuery.data.value;
  if (!health || health.status !== 'available') return '未知';
  if (!health.listeners.length) return '暂无邮箱';
  if (health.listeners.some((item) => item.state === 'unavailable')) return '异常';
  if (health.listeners.some((item) => item.state === 'unknown')) return '待核验';
  if (health.listeners.some((item) => item.state === 'recovering')) return '恢复中';
  return health.listeners.some((item) => item.state === 'listening') ? '监听中' : '已禁用';
});
const deliveryValue = computed(() => {
  const summary = mailboxDeliverySummary(healthQuery.data.value);
  return summary.includes('积压')
    ? '有积压'
    : summary.includes('未配置')
      ? '未配置'
      : summary === '等待首条回执'
        ? '待回执'
        : summary.includes('等待')
          ? '投递中'
          : summary === '最近投递成功'
            ? '已送达'
            : summary;
});
const description = computed(() => {
  const status = healthQuery.data.value?.status;
  return status === 'unsupported'
    ? '上游暂不支持健康检查，邮件列表仍可正常读取。'
    : status === 'unavailable'
      ? '健康状态暂时无法核验，邮件列表仍可读取；可刷新状态重试。'
      : '健康状态截至本次检查时间；刷新列表读取已入库邮件，立即同步从邮箱补收。';
});
let refreshing: Promise<unknown> | undefined;
function refreshHealth() {
  if (!props.enabled) return;
  if (refreshing) return refreshing;
  refreshing = healthQuery.refresh().finally(() => {
    refreshing = undefined;
  });
  return refreshing;
}
function onForeground() {
  if (document.visibilityState !== 'hidden') void refreshHealth();
}
watch(
  () => props.refreshVersion,
  () => void refreshHealth()
);
watch(
  () => v2ChangeSyncState.lastConnectedAt,
  (_value, previous) => {
    if (previous !== null) void refreshHealth();
  }
);
onMounted(() => {
  window.addEventListener('focus', onForeground);
  document.addEventListener('visibilitychange', onForeground);
});
onBeforeUnmount(() => {
  window.removeEventListener('focus', onForeground);
  document.removeEventListener('visibilitychange', onForeground);
});
</script>
