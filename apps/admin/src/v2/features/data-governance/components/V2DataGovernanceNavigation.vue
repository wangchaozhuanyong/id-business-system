<template>
  <nav class="v2-governance-navigation" aria-label="数据治理分区">
    <button
      v-for="item in items"
      :key="item.key"
      type="button"
      :class="{ 'is-active': activeTab === item.key }"
      :aria-current="activeTab === item.key ? 'page' : undefined"
      @click="$emit('update:activeTab', item.key)"
    >
      <el-icon class="v2-governance-navigation__icon"><component :is="item.icon" /></el-icon>
      <span class="v2-governance-navigation__copy">
        <strong>{{ item.label }}</strong>
        <small>{{ item.description }}</small>
      </span>
      <span class="v2-governance-navigation__count">{{ item.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { DataAnalysis, Delete, Tickets } from '@element-plus/icons-vue';
import type { V2GovernanceTab } from '../data-governance-route';
import type { useDataGovernancePage } from '../useDataGovernancePage';

type DataGovernancePage = UnwrapNestedRefs<ReturnType<typeof useDataGovernancePage>>;

const props = defineProps<{ activeTab: V2GovernanceTab; page: DataGovernancePage }>();
defineEmits<{ 'update:activeTab': [value: V2GovernanceTab] }>();

const items = computed(() => [
  {
    key: 'overview' as const,
    label: '治理概况',
    description: '能力、审批与安全边界',
    icon: markRaw(DataAnalysis),
    count: props.page.overview?.capabilities.length ?? '—'
  },
  {
    key: 'recycle' as const,
    label: '回收站',
    description: '软删除盘点与恢复预览',
    icon: markRaw(Delete),
    count: props.page.recycleTotal
  },
  {
    key: 'jobs' as const,
    label: '治理任务',
    description: '异人审批与分批执行',
    icon: markRaw(Tickets),
    count: props.page.jobsTotal
  }
]);
</script>
