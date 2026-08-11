<template>
  <nav class="v2-system-monitoring-navigation" aria-label="系统监控证据分区">
    <button
      v-for="item in sections"
      :key="item.key"
      type="button"
      :class="{ 'is-active': page.activeSection === item.key }"
      :aria-pressed="page.activeSection === item.key"
      @click="page.setActiveSection(item.key)"
    >
      <span class="v2-system-monitoring-navigation__icon" aria-hidden="true">
        <el-icon><component :is="item.icon" /></el-icon>
      </span>
      <span class="v2-system-monitoring-navigation__copy">
        <strong>{{ item.label }}</strong>
        <small>{{ item.description }}</small>
      </span>
      <span class="v2-system-monitoring-navigation__count">{{ item.count }}</span>
    </button>
  </nav>
</template>

<script setup lang="ts">
import { computed, markRaw } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Connection, DataAnalysis, Warning } from '@element-plus/icons-vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;

const props = defineProps<{ page: SystemMonitoringPage }>();

const sections = computed(() => [
  {
    key: 'health' as const,
    label: '健康证据',
    description: 'API、数据库与版本补偿',
    icon: markRaw(DataAnalysis),
    count: `${props.page.sortedChecks.length} 项`
  },
  {
    key: 'operations' as const,
    label: '认证与任务',
    description: '认证聚合与汇率调度',
    icon: markRaw(Connection),
    count: props.page.overview ? '2 组' : '—'
  },
  {
    key: 'gaps' as const,
    label: '可观测缺口',
    description: '当前运行时无法证明',
    icon: markRaw(Warning),
    count: props.page.overview ? `${props.page.overview.observabilityGaps.length} 项` : '—'
  }
]);
</script>
