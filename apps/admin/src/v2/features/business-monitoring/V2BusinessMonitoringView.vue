<template>
  <section class="v2-records-page v2-business-monitoring-page">
    <V2BusinessMonitoringOverview :page="page" />
    <V2BusinessMonitoringSummary :page="page" />
    <V2BusinessMonitoringToolbar :page="page" />

    <V2AsyncRegion
      skeleton="table"
      :phase="page.queryPhase"
      :previous-data="page.isParameterTransition"
      :error="page.error"
      loading-title="正在计算业务异常"
      refreshing-title="正在更新业务异常"
      error-title="业务监控加载失败"
      @retry="page.refresh"
    >
      <V2BusinessMonitoringWorkspace :page="page" />
    </V2AsyncRegion>
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AsyncRegion from '@/v2/components/V2AsyncRegion.vue';
import V2BusinessMonitoringOverview from './components/V2BusinessMonitoringOverview.vue';
import V2BusinessMonitoringSummary from './components/V2BusinessMonitoringSummary.vue';
import V2BusinessMonitoringToolbar from './components/V2BusinessMonitoringToolbar.vue';
import V2BusinessMonitoringWorkspace from './components/V2BusinessMonitoringWorkspace.vue';
import { useBusinessMonitoringPage } from './useBusinessMonitoringPage';
import '@/v2/styles/records.css';
import '@/v2/styles/business-monitoring.css';

const page = reactive(useBusinessMonitoringPage());
</script>
