<template>
  <section class="v2-records-page v2-system-monitoring-page">
    <header class="v2-system-monitoring-header">
      <div>
        <strong>系统监控</strong>
        <p>受保护的只读健康视图；未知项不会被当作正常。</p>
      </div>
      <div class="v2-system-monitoring-header__status">
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
        <AppButton icon-only title="刷新系统监控" :disabled="page.loading" @click="page.refresh">
          <el-icon><Refresh /></el-icon>
        </AppButton>
      </div>
    </header>

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
import V2SystemMonitoringChecks from './components/V2SystemMonitoringChecks.vue';
import V2SystemMonitoringDetails from './components/V2SystemMonitoringDetails.vue';
import { useSystemMonitoringPage } from './useSystemMonitoringPage';
import '@/v2/styles/records.css';

const page = reactive(useSystemMonitoringPage());
</script>

<style scoped>
.v2-system-monitoring-header {
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

.v2-system-monitoring-header > div:first-child {
  display: grid;
  min-width: 0;
  gap: 4px;
}

.v2-system-monitoring-header strong {
  color: var(--v2-text);
  font-size: 20px;
}

.v2-system-monitoring-header p,
.v2-system-monitoring-header span {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-system-monitoring-header__status {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}

.v2-system-monitoring-content {
  display: grid;
  min-width: 0;
  gap: 14px;
}

@media (max-width: 720px) {
  .v2-system-monitoring-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-system-monitoring-header__status {
    justify-content: flex-start;
  }
}
</style>
