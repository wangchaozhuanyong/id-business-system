<template>
  <section class="v2-orders-overview" aria-label="订单概览">
    <div class="v2-orders-overview__intro">
      <span class="v2-orders-overview__eyebrow">订单工作台</span>
      <h2>订单业务总览</h2>
      <p>当前筛选范围内共 {{ page.total }} 笔订单，当前页关键状态集中展示。</p>
    </div>

    <div class="v2-orders-overview__metrics" aria-label="当前页订单指标">
      <article>
        <span>筛选结果</span>
        <strong>{{ page.total }}</strong>
        <small>全部匹配订单</small>
      </article>
      <article>
        <span>当前页</span>
        <strong>{{ page.items.length }}</strong>
        <small>本页已加载</small>
      </article>
      <article>
        <span>待推进</span>
        <strong>{{ actionableCount }}</strong>
        <small>待扣减或待开通</small>
      </article>
      <article>
        <span>已完成</span>
        <strong>{{ completedCount }}</strong>
        <small>当前页完成订单</small>
      </article>
    </div>

    <AppButton
      v-if="page.canConsumeOrders"
      class="v2-orders-overview__primary"
      variant="primary"
      @click="page.openOrderEntry"
    >
      <el-icon><Plus /></el-icon>
      录入新订单
    </AppButton>
  </section>
</template>

<script setup lang="ts">
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
