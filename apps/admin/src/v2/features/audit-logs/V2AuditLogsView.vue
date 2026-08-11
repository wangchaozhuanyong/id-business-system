<template>
  <section class="v2-records-page v2-audit-logs-page">
    <V2AuditLogsOverview :page="page" />
    <V2AuditLogsNavigation :page="page" />
    <V2AuditLogsToolbar :page="page" />
    <V2AuditLogsList :page="page" />
    <V2AuditLogDetailDrawer
      v-model="page.detailDrawerVisible"
      :selected-operation="page.selectedOperation"
      :selected-sensitive-access="page.selectedSensitiveAccess"
      @restore="page.openRestoreFromOperationAudit"
    />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2AuditLogDetailDrawer from './components/V2AuditLogDetailDrawer.vue';
import V2AuditLogsList from './components/V2AuditLogsList.vue';
import V2AuditLogsNavigation from './components/V2AuditLogsNavigation.vue';
import V2AuditLogsOverview from './components/V2AuditLogsOverview.vue';
import V2AuditLogsToolbar from './components/V2AuditLogsToolbar.vue';
import { useAuditLogsPage } from './useAuditLogsPage';
import '@/v2/styles/records.css';
import '@/v2/styles/audit-logs.css';

const page = reactive(useAuditLogsPage());
</script>
