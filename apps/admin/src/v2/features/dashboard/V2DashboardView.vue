<template>
  <section class="v2-records-page v2-dashboard-page">
    <header class="v2-dashboard-header">
      <div>
        <span v-if="page.overview">
          业务日 {{ page.overview.businessDate }} · Asia/Kuala_Lumpur
        </span>
        <strong>经营仪表盘</strong>
        <p>所有数字均来自当前系统记录；无权限的数据会明确标记，不使用 0 代替。</p>
      </div>
      <AppButton icon-only title="刷新仪表盘" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
      </AppButton>
    </header>

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
        <V2DashboardMetricGrid
          title="今日业务"
          help="今日按马来西亚时区计算；完成数、收入和利润只包含当前仍为已完成状态的订单。"
          :items="page.businessMetrics"
          :page="page"
        />
        <V2DashboardMetricGrid
          title="待办与风险"
          help="风险数字是当前状态快照；点击可进入对应模块处理。"
          :items="page.riskMetrics"
          :page="page"
        />
        <V2DashboardAssets :page="page" />
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
import V2DashboardActivity from './components/V2DashboardActivity.vue';
import V2DashboardAssets from './components/V2DashboardAssets.vue';
import V2DashboardMetricGrid from './components/V2DashboardMetricGrid.vue';
import { useDashboardPage } from './useDashboardPage';
import '@/v2/styles/records.css';

const page = reactive(useDashboardPage());
</script>

<style scoped>
.v2-dashboard-header {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-header > div {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-dashboard-header span,
.v2-dashboard-header p {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-header strong {
  color: var(--v2-text);
  font-size: 20px;
}

.v2-dashboard-header p {
  margin: 0;
  line-height: 1.5;
}

.v2-dashboard-content {
  display: grid;
  min-width: 0;
  gap: 20px;
}
</style>
