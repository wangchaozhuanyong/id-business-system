<template>
  <V2PageOverview
    class="v2-orders-overview"
    aria-label="订单概览"
    title="订单业务总览"
    :help="'当前筛选范围内共 ' + page.total + ' 笔订单，当前页关键状态集中展示。'"
    metrics-label="当前页订单指标"
  >
    <template #metrics>
      <V2OverviewMetric label="筛选结果" :value="page.total" note="全部匹配订单" />
      <V2OverviewMetric label="当前页" :value="page.items.length" note="本页已加载" />
      <V2OverviewMetric label="待推进" :value="actionableCount" note="待扣减或待开通" />
      <V2OverviewMetric label="已完成" :value="completedCount" note="当前页完成订单" />
    </template>
    <template #actions>
      <AppButton
        v-if="page.canConsumeOrders"
        class="v2-orders-overview__primary"
        variant="primary"
        @click="page.openOrderEntry"
      >
        <el-icon><Plus /></el-icon>
        录入新订单
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Plus } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useOrdersPage } from '../useOrdersPage';

type OrdersPage = UnwrapNestedRefs<ReturnType<typeof useOrdersPage>>;

const props = defineProps<{
  page: OrdersPage;
}>();

const actionableCount = computed(
  () =>
    props.page.items.filter((item) => item.operations.canConsume || item.operations.canComplete)
      .length
);
const completedCount = computed(
  () => props.page.items.filter((item) => item.status === 'completed').length
);
</script>
