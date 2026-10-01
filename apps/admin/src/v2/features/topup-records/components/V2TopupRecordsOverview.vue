<template>
  <V2PageOverview
    class="v2-topup-records-overview"
    aria-label="加卡与余额记录概览"
    :title="activeTab === 'giftCards' ? '加卡记录总览' : '余额流水总览'"
    :help="
      activeTab === 'giftCards'
        ? '核对礼品卡入账、供应商归属和余额快照。'
        : '追踪每次余额与成本变化，原始账务流水不可覆盖。'
    "
    metrics-label="当前记录指标"
    :columns="metrics.length"
  >
    <template #metrics>
      <V2OverviewMetric
        v-for="metric in metrics"
        :key="metric.label"
        :label="metric.label"
        :value="metric.value"
        :note="metric.note"
      />
    </template>
    <template #actions>
      <AppButton variant="ghost" :disabled="loading" @click="emit('refresh')">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { V2BalanceLedgerRecord, V2GiftCardRecord } from '../contracts';

const props = defineProps<{
  activeTab: 'giftCards' | 'ledger';
  giftCards: V2GiftCardRecord[];
  giftCardTotal: number;
  ledgerEntries: V2BalanceLedgerRecord[];
  ledgerTotal: number;
  loading: boolean;
}>();

const emit = defineEmits<{
  refresh: [];
}>();

const metrics = computed(() => {
  if (props.activeTab === 'giftCards') {
    const creditedCount = props.giftCards.filter((item) => item.status === 'credited').length;
    return [
      { label: '筛选结果', value: props.giftCardTotal, note: '全部匹配记录' },
      { label: '当前页', value: props.giftCards.length, note: '本页已加载' },
      { label: '正常入账', value: creditedCount, note: '当前页有效记录' },
      {
        label: '已冲回',
        value: props.giftCards.length - creditedCount,
        note: '当前页赎回或撤回'
      }
    ];
  }

  return [
    { label: '筛选结果', value: props.ledgerTotal, note: '全部匹配流水' },
    { label: '当前页', value: props.ledgerEntries.length, note: '本页已加载' },
    {
      label: '余额增加',
      value: props.ledgerEntries.filter((item) => item.direction === 'credit').length,
      note: '当前页入账流水'
    },
    {
      label: '余额扣减',
      value: props.ledgerEntries.filter((item) => item.direction === 'debit').length,
      note: '当前页扣减流水'
    }
  ];
});
</script>
