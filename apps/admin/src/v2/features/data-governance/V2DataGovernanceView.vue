<template>
  <section class="v2-records-page v2-governance-page">
    <V2PageContext
      description="所有恢复和清理先冻结影响预览、确认备份证据，再由另一名管理员审批并分批执行。"
      aria-label="数据治理安全边界"
    >
      <template #status>
        <el-tag type="success" effect="plain">异人审批</el-tag>
        <el-tag type="info" effect="plain">通用硬删除关闭</el-tag>
      </template>
    </V2PageContext>

    <el-tabs v-model="page.activeTab" class="v2-governance-tabs">
      <el-tab-pane label="治理概况" name="overview">
        <V2DataGovernanceOverviewPanel :page="page" />
      </el-tab-pane>
      <el-tab-pane name="recycle">
        <template #label>
          <span>回收站</span>
          <el-badge v-if="page.recycleTotal" :value="page.recycleTotal" :max="999" />
        </template>
        <V2DataGovernanceRecyclePanel :page="page" />
      </el-tab-pane>
      <el-tab-pane name="jobs">
        <template #label>
          <span>治理任务</span>
          <el-badge v-if="page.jobsTotal" :value="page.jobsTotal" :max="999" />
        </template>
        <V2DataGovernanceJobsPanel :page="page" />
      </el-tab-pane>
    </el-tabs>

    <V2DataGovernanceDrawers :page="page" />
  </section>
</template>

<script setup lang="ts">
import { reactive } from 'vue';
import V2PageContext from '@/v2/components/V2PageContext.vue';
import V2DataGovernanceDrawers from './components/V2DataGovernanceDrawers.vue';
import V2DataGovernanceJobsPanel from './components/V2DataGovernanceJobsPanel.vue';
import V2DataGovernanceOverviewPanel from './components/V2DataGovernanceOverviewPanel.vue';
import V2DataGovernanceRecyclePanel from './components/V2DataGovernanceRecyclePanel.vue';
import { useDataGovernancePage } from './useDataGovernancePage';
import '@/v2/styles/records.css';

const page = reactive(useDataGovernancePage());
</script>

<style scoped>
.v2-governance-tabs {
  min-width: 0;
}

.v2-governance-tabs :deep(.el-tabs__item) {
  gap: 6px;
}

.v2-governance-tabs :deep(.el-tabs__content) {
  overflow: visible;
}
</style>
