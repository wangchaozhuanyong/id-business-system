<template>
  <V2PageOverview
    class="v2-system-monitoring-overview"
    aria-label="系统运行总览"
    title="系统运行证据"
    help="仅展示当前运行时可证明的只读结果；未接入证据的项目始终标记为未知。"
    metrics-label="当前系统监控指标"
  >
    <template #metrics>
      <V2OverviewMetric label="整体状态" :value="overallStatusLabel" note="只基于已检查证据" />
      <V2OverviewMetric
        label="证据覆盖"
        :value="page.overview ? `${page.evidenceSummary.coverageRate}%` : '—'"
        :note="
          page.overview
            ? `${page.evidenceSummary.observable}/${page.evidenceSummary.total} 项可判定`
            : '等待探针'
        "
      />
      <V2OverviewMetric
        label="探针耗时"
        :value="page.overview ? `${page.overview.probeDurationMs} ms` : '—'"
        note="本次只读聚合请求"
      />
      <V2OverviewMetric
        label="不可观测项"
        :value="page.overview?.observabilityGaps.length ?? '—'"
        note="未知不计入正常"
      />
    </template>
    <template #actions>
      <span>{{ generatedAtLabel }}</span>
      <el-tag type="info" effect="plain">管理员只读</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        执行探针
      </AppButton>
    </template>
  </V2PageOverview>
</template>

<script setup lang="ts">
import V2PageOverview from '@/v2/components/V2PageOverview.vue';
import V2OverviewMetric from '@/v2/components/V2OverviewMetric.vue';
import { computed } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useSystemMonitoringPage } from '../useSystemMonitoringPage';

type SystemMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useSystemMonitoringPage>>;

const props = defineProps<{ page: SystemMonitoringPage }>();

const overallStatusLabel = computed(() =>
  props.page.overview
    ? props.page.systemOverallStatusMeta(props.page.overview.overallStatus).label
    : '—'
);

const generatedAtLabel = computed(() =>
  props.page.overview
    ? `更新于 ${props.page.formatSystemMonitoringDate(props.page.overview.generatedAt)}`
    : '等待首个快照'
);
</script>
