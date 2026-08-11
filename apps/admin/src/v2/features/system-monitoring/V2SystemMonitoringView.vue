<template>
  <section class="v2-records-page v2-system-monitoring-page">
    <V2SystemMonitoringOverview :page="page" />
    <V2SystemMonitoringNavigation :page="page" />

    <V2AsyncRegion
      skeleton="metrics"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.error"
      loading-title="正在执行系统只读探针"
      refreshing-title="正在更新系统状态"
      error-title="系统监控加载失败"
      @retry="page.refresh"
    >
      <div class="v2-system-monitoring-content">
        <V2SystemMonitoringChecks v-if="page.activeSection === 'health'" :page="page" />
        <V2SystemMonitoringDetails v-else :page="page" />
      </div>
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2SystemMonitoringChecks from './components/V2SystemMonitoringChecks.vue';
import V2SystemMonitoringDetails from './components/V2SystemMonitoringDetails.vue';
import V2SystemMonitoringNavigation from './components/V2SystemMonitoringNavigation.vue';
import V2SystemMonitoringOverview from './components/V2SystemMonitoringOverview.vue';
import { useSystemMonitoringPage } from './useSystemMonitoringPage';
import '@/v2/styles/records.css';
import '@/v2/styles/system-monitoring.css';

const page = reactive(useSystemMonitoringPage());
</script>
