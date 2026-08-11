<template>
  <section class="v2-records-page v2-governance-page">
    <V2DataGovernanceOverview :page="page" />

    <el-alert
      v-if="page.previewBlockedReason && page.overviewHasData"
      type="warning"
      :title="page.previewBlockedReason"
      description="在异人审批条件恢复前，可以查看治理概况与历史任务，但不能生成新的恢复或清理预览。"
      :closable="false"
      show-icon
    />

    <V2DataGovernanceNavigation v-model:active-tab="page.activeTab" :page="page" />

    <div class="v2-governance-content">
      <V2DataGovernanceOverviewPanel v-show="page.activeTab === 'overview'" :page="page" />
      <V2DataGovernanceRecyclePanel v-show="page.activeTab === 'recycle'" :page="page" />
      <V2DataGovernanceJobsPanel v-show="page.activeTab === 'jobs'" :page="page" />
    </div>

    <V2DataGovernanceDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2DataGovernanceDrawers from './components/V2DataGovernanceDrawers.vue';
import V2DataGovernanceJobsPanel from './components/V2DataGovernanceJobsPanel.vue';
import V2DataGovernanceNavigation from './components/V2DataGovernanceNavigation.vue';
import V2DataGovernanceOverview from './components/V2DataGovernanceOverview.vue';
import V2DataGovernanceOverviewPanel from './components/V2DataGovernanceOverviewPanel.vue';
import V2DataGovernanceRecyclePanel from './components/V2DataGovernanceRecyclePanel.vue';
import { useDataGovernancePage } from './useDataGovernancePage';
import '@/v2/styles/records.css';
import '@/v2/styles/data-governance.css';

const page = reactive(useDataGovernancePage());
</script>
