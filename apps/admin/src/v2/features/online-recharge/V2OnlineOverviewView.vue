<template>
  <section v-if="canRead" class="v2-page-layout online-page">
    <V2PageContext
      description="线上代充使用独立银行卡、代理、地址和兑换资格，账单与现有充值业务独立。"
      ><template #actions
        ><AppButton variant="ghost" allow-when-stale @click="query.refresh">刷新概览</AppButton
        ><RouterLink to="/online-recharge" target="_blank">客户兑换入口</RouterLink
        ><RouterLink to="/online-recharge/subscription" target="_blank"
          >客户订阅查询</RouterLink
        ></template
      ></V2PageContext
    ><V2AsyncRegion
      :phase="query.phase.value"
      :error="query.error.value ? getApiErrorMessage(query.error.value) : ''"
      skeleton="cards"
      loading-title="正在加载概览"
      @retry="query.refresh"
      ><V2PageOverview title="线上代充概览"
        ><template #metrics
          ><V2OverviewMetric
            v-for="metric in metrics"
            :key="metric.label"
            :label="metric.label"
            :value="metric.value"
            :note="metric.note" /></template
      ></V2PageOverview>
      <section class="online-panel">
        <V2SectionHeading title="运行与资源" />
        <dl class="online-status-grid">
          <template v-for="item in runtime" :key="item.label"
            ><dt>{{ item.label }}</dt>
            <dd>{{ item.value }}</dd></template
          >
        </dl>
      </section>
      <section class="online-panel">
        <V2SectionHeading title="实际账单金额" />
        <p v-if="!billing.length">当前没有已确认成功的实际账单。</p>
        <dl v-else class="online-status-grid">
          <template v-for="item in billing" :key="item.currency"
            ><dt>{{ item.currency }}</dt>
            <dd>{{ item.amount ?? '—' }}（{{ item.count }} 笔）</dd></template
          >
        </dl>
      </section></V2AsyncRegion
    >
  </section>
</template>
<script setup lang="ts">
import { computed } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { canUseOnlineAction } from './permissions';
import AppButton from '@/components/ui/AppButton.vue';
import { getApiErrorMessage } from '@/api/client';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { onlineApi } from './api';
import { regionOptions } from './labels';
import './online-recharge.css';
interface Group {
  status: string;
  _count: number;
}
const authStore = useAuthStore();
const canRead = computed(() => canUseOnlineAction(authStore.user, 'overview', 'detail'));
const query = useV2ModuleQuery({
  moduleKey: 'online-recharge-overview',
  scope: 'online-recharge',
  enabled: () => canUseOnlineAction(authStore.user, 'jobs', 'detail'),
  key: 'overview',
  query: ({ signal }) => onlineApi.overview(signal),
  keepPreviousData: true
});
function grouped(key: string, status?: string) {
  const rows = query.data.value?.[key];
  if (!Array.isArray(rows)) return '—';
  return (rows as Group[])
    .filter((row) => !status || row.status === status)
    .reduce((total, row) => total + Number(row._count ?? 0), 0);
}
const config = computed(() => query.data.value?.config as Record<string, unknown> | undefined);
const host = computed(() => query.data.value?.runtime as Record<string, unknown> | undefined);
const billing = computed(() =>
  Array.isArray(query.data.value?.billing)
    ? (query.data.value.billing as { currency: string; amount: string | null; count: number }[])
    : []
);
const metrics = computed(() => [
  { label: '全部任务', value: grouped('tasks'), note: '当前线上代充任务' },
  { label: '正在执行', value: grouped('tasks', 'running'), note: '包含本地与第三方通道' },
  { label: '确认成功', value: grouped('tasks', 'succeeded'), note: '已完成可靠结果确认' },
  { label: '待核对', value: grouped('tasks', 'awaiting_review'), note: '结果确认前不能重复付款' }
]);
function memory(key: string) {
  const value = host.value?.[key];
  return value === null || value === undefined
    ? '未获取'
    : `${(Number(value) / 1024 ** 3).toFixed(2)} GB`;
}
const runtime = computed(() => [
  { label: '状态可用银行卡', value: grouped('cards', 'active') },
  { label: '未使用兑换码', value: grouped('codes', 'available') },
  { label: '最大并发激活数', value: String(config.value?.maxConcurrent ?? '未获取') },
  { label: '维护模式', value: config.value?.maintenance ? '已开启' : '未开启' },
  { label: '执行通道', value: config.value?.gptApiEnabled ? '第三方代充' : '本地浏览器' },
  {
    label: '支付地区',
    value:
      regionOptions.find((item) => item.value === config.value?.paymentRegion)?.label ?? '未获取'
  },
  { label: '浏览器模式', value: config.value?.browserMode === 'pool' ? '池化模式' : '独立模式' },
  { label: '处理器核心数', value: String(host.value?.cpuCores ?? '未获取') },
  { label: '总内存', value: memory('totalMemory') },
  { label: '空闲内存', value: memory('freeMemory') },
  { label: '磁盘总容量', value: memory('diskTotal') },
  { label: '磁盘剩余容量', value: memory('diskFree') },
  {
    label: '服务运行时间',
    value:
      host.value?.uptime === undefined
        ? '未获取'
        : `${Math.floor(Number(host.value.uptime) / 3600)} 小时`
  }
]);
</script>
