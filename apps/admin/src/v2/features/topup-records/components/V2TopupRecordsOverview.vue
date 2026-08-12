<template>
  <section class="v2-topup-records-overview" aria-label="加卡与余额记录概览">
    <div class="v2-topup-records-overview__intro">
      <span class="v2-topup-records-overview__eyebrow">余额记录</span>
      <h2>{{ activeTab === 'giftCards' ? '加卡记录总览' : '余额流水总览' }}</h2>
      <p>
        {{
          activeTab === 'giftCards'
            ? '核对礼品卡入账、供应商归属和余额快照。'
            : '追踪每次余额与成本变化，原始账务流水不可覆盖。'
        }}
      </p>
    </div>

    <div class="v2-topup-records-overview__metrics" aria-label="当前记录指标">
      <article v-for="metric in metrics" :key="metric.label">
        <span>{{ metric.label }}</span>
        <strong>{{ metric.value }}</strong>
        <small>{{ metric.note }}</small>
      </article>
    </div>

    <AppButton variant="ghost" :disabled="loading" @click="emit('refresh')">
      <el-icon><Refresh /></el-icon>
      刷新
    </AppButton>
  </section>
</template>

<script setup lang="ts">
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
