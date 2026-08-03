<template>
  <section class="v2-records-page v2-dashboard-page">
    <V2PageContext
      description="所有数字均来自当前系统记录；无权限的数据会明确标记，不使用 0 代替。"
      aria-label="仪表盘数据口径"
    >
      <template #meta>
        <span v-if="page.overview">
          业务日 {{ page.overview.businessDate }} · Asia/Kuala_Lumpur
        </span>
      </template>
      <template v-if="page.overview" #status>
        <span>更新于 {{ page.formatDashboardDate(page.overview.generatedAt) }}</span>
      </template>
      <template #actions>
        <AppButton icon-only title="刷新仪表盘" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </template>
    </V2PageContext>

    <V2AsyncRegion
      skeleton="metrics"
      :loading="page.loading"
      :resolved="page.resolved"
      :error="page.error"
      loading-title="正在汇总经营数据"
      refreshing-title="正在更新仪表盘"
      error-title="仪表盘加载失败"
      @retry="page.refresh"
    >
      <div class="v2-dashboard-content">
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
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2DashboardActivity from './components/V2DashboardActivity.vue';
import V2DashboardMetricGrid from './components/V2DashboardMetricGrid.vue';
import { useDashboardPage } from './useDashboardPage';
import '@/v2/styles/records.css';

const page = reactive(useDashboardPage());
</script>

<style scoped>
.v2-dashboard-content {
  display: grid;
  min-width: 0;
  gap: 14px;
}

.v2-dashboard-page > :deep(.v2-page-context) {
  min-height: 54px;
  padding: 8px 14px;
}

.v2-dashboard-page > :deep(.v2-page-context__copy) {
  display: flex;
  align-items: center;
  gap: 12px;
}

.v2-dashboard-page > :deep(.v2-page-context__meta) {
  padding-right: 12px;
  border-right: 1px solid var(--v2-border-soft);
}

.v2-dashboard-overview-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1.55fr) minmax(310px, 0.75fr);
  gap: 14px;
}

@media (max-width: 1040px) {
  .v2-dashboard-overview-grid {
    grid-template-columns: minmax(0, 1fr);
  }
}

@media (max-width: 700px) {
  .v2-dashboard-page > :deep(.v2-page-context__copy) {
    display: grid;
  }

  .v2-dashboard-page > :deep(.v2-page-context__meta) {
    padding-right: 0;
    border-right: 0;
  }
}
</style>
