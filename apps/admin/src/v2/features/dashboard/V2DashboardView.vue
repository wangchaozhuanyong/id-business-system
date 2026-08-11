<template>
  <section class="v2-records-page v2-dashboard-page">
    <V2AsyncRegion
      skeleton="metrics"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.error"
      loading-title="正在汇总经营数据"
      refreshing-title="正在更新仪表盘"
      error-title="仪表盘加载失败"
      @retry="page.refresh"
    >
      <div class="v2-dashboard-content">
        <V2DashboardOverview :page="page" />
        <div class="v2-dashboard-overview-grid">
          <V2DashboardMetricGrid
            variant="risk"
            title="待办与风险"
            :badge="`${page.activeRiskCategoryCount} 项需处理`"
            help="风险数字是当前状态快照；点击可进入对应模块处理。"
            :items="page.riskMetrics"
            :page="page"
          />
          <V2DashboardMetricGrid
            variant="business"
            title="今日业务"
            help="今日按马来西亚时区计算；完成数、收入和利润只包含当前仍为已完成状态的订单。"
            :items="page.businessMetrics"
            :page="page"
          />
        </div>
        <V2DashboardActivity :page="page" />
      </div>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2DashboardActivity from './components/V2DashboardActivity.vue';
import V2DashboardMetricGrid from './components/V2DashboardMetricGrid.vue';
import V2DashboardOverview from './components/V2DashboardOverview.vue';
import { useDashboardPage } from './useDashboardPage';
import '@/v2/styles/records.css';
import '@/v2/styles/dashboard.css';

const page = reactive(useDashboardPage());
</script>
