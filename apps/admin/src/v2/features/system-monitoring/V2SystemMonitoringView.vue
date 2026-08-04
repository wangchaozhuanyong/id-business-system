<template>
  <section class="v2-records-page v2-system-monitoring-page">
    <V2PageContext
      description="受保护的只读健康视图；未知项不会被当作正常。"
      aria-label="系统监控说明"
    >
      <template #status>
        <template v-if="page.overview">
          <el-tag
            :type="page.systemOverallStatusMeta(page.overview.overallStatus).type"
            effect="plain"
          >
            {{ page.systemOverallStatusMeta(page.overview.overallStatus).label }}
          </el-tag>
          <span>探针 {{ page.overview.probeDurationMs }} ms</span>
          <span>{{ page.formatSystemMonitoringDate(page.overview.generatedAt) }}</span>
        </template>
      </template>
      <template #actions>
        <AppButton variant="soft" :loading="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
          重新执行探针
        </AppButton>
      </template>
    </V2PageContext>

    <V2AsyncRegion
      skeleton="metrics"
      :loading="page.loading"
      :resolved="page.hasData"
      :error="page.error"
      loading-title="正在执行系统只读探针"
      refreshing-title="正在更新系统状态"
      error-title="系统监控加载失败"
      @retry="page.refresh"
    >
      <div class="v2-system-monitoring-content">
        <V2SystemMonitoringChecks :page="page" />
        <V2SystemMonitoringDetails :page="page" />
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
import V2SystemMonitoringChecks from './components/V2SystemMonitoringChecks.vue';
import V2SystemMonitoringDetails from './components/V2SystemMonitoringDetails.vue';
import { useSystemMonitoringPage } from './useSystemMonitoringPage';
import '@/v2/styles/records.css';

const page = reactive(useSystemMonitoringPage());
</script>

<style scoped>
.v2-system-monitoring-content {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(0, 1fr) minmax(300px, 360px);
  align-items: start;
  gap: 14px;
}

@media (max-width: 1080px) {
  .v2-system-monitoring-content {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
