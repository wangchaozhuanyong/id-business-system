<template>
  <section class="v2-records-page v2-governance-page">
    <header class="v2-governance-header">
      <div>
        <strong>数据治理</strong>
        <p>所有恢复和清理先冻结影响预览、确认备份证据，再由另一名管理员审批并分批执行。</p>
      </div>
      <div>
        <el-tag type="success" effect="plain">异人审批</el-tag>
        <el-tag type="info" effect="plain">通用硬删除关闭</el-tag>
      </div>
    </header>

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
import V2DataGovernanceDrawers from './components/V2DataGovernanceDrawers.vue';
import V2DataGovernanceJobsPanel from './components/V2DataGovernanceJobsPanel.vue';
import V2DataGovernanceOverviewPanel from './components/V2DataGovernanceOverviewPanel.vue';
import V2DataGovernanceRecyclePanel from './components/V2DataGovernanceRecyclePanel.vue';
import { useDataGovernancePage } from './useDataGovernancePage';
import '@/v2/styles/records.css';

const page = reactive(useDataGovernancePage());
</script>

<style scoped>
.v2-governance-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 16px 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-governance-header > div:first-child {
  display: grid;
  gap: 4px;
  min-width: 0;
}

.v2-governance-header > div:last-child {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
}

.v2-governance-header strong {
  color: var(--v2-text);
  font-size: 20px;
}

.v2-governance-header p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.6;
}

.v2-governance-tabs {
  min-width: 0;
}

.v2-governance-tabs :deep(.el-tabs__item) {
  gap: 6px;
}

.v2-governance-tabs :deep(.el-tabs__content) {
  overflow: visible;
}

@media (max-width: 760px) {
  .v2-governance-header {
    align-items: flex-start;
    flex-direction: column;
  }

  .v2-governance-header > div:last-child {
    justify-content: flex-start;
  }
}
</style>
