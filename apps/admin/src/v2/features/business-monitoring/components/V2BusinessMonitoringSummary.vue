<template>
  <nav v-if="page.summary" class="v2-business-monitoring-categories" aria-label="业务风险分类">
    <button
      v-for="item in categoryItems"
      :key="item.category"
      type="button"
      :class="{ 'is-active': page.query.category === item.category }"
      :aria-pressed="page.query.category === item.category"
      @click="page.applyCategory(item.category)"
    >
      <span class="v2-business-monitoring-categories__icon" aria-hidden="true">
        <el-icon><component :is="item.icon" /></el-icon>
      </span>
      <span class="v2-business-monitoring-categories__copy">
        <strong>{{ item.label }}</strong>
        <small>{{ item.description }}</small>
      </span>
      <span class="v2-business-monitoring-categories__count">{{ item.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Calendar, DataLine, Tickets, TrendCharts, Wallet } from '@element-plus/icons-vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

const props = defineProps<{ page: BusinessMonitoringPage }>();

const categoryDescriptions = {
  order: '订单状态与流程',
  balance: '账户余额与可用性',
  renewal: '开通到期与续费',
  exchange_rate: '采集运行与汇率',
  finance: '历史账务基线'
} as const;

const categoryIcons = {
  order: markRaw(Tickets),
  balance: markRaw(Wallet),
  renewal: markRaw(Calendar),
  exchange_rate: markRaw(TrendCharts),
  finance: markRaw(DataLine)
} as const;

const categoryItems = computed(() =>
  props.page.categoryBreakdown.map((item) => ({
    ...item,
    description: categoryDescriptions[item.category],
    icon: categoryIcons[item.category]
  }))
);
</script>
