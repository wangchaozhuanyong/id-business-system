<template>
  <section class="v2-system-monitoring-overview" aria-label="系统运行总览">
    <div class="v2-system-monitoring-overview__intro">
      <span class="v2-system-monitoring-overview__eyebrow">系统运行证据</span>
      <h2>系统运行证据</h2>
      <p>仅展示当前运行时可证明的只读结果；未接入证据的项目始终标记为未知。</p>
    </div>

    <div class="v2-system-monitoring-overview__metrics" aria-label="当前系统监控指标">
      <article>
        <span>整体状态</span>
        <strong>{{ overallStatusLabel }}</strong>
        <small>只基于已检查证据</small>
      </article>
      <article>
        <span>证据覆盖</span>
        <strong>{{ page.overview ? `${page.evidenceSummary.coverageRate}%` : '—' }}</strong>
        <small>{{
          page.overview
            ? `${page.evidenceSummary.observable}/${page.evidenceSummary.total} 项可判定`
            : '等待探针'
        }}</small>
      </article>
      <article>
        <span>探针耗时</span>
        <strong>{{ page.overview ? `${page.overview.probeDurationMs} ms` : '—' }}</strong>
        <small>本次只读聚合请求</small>
      </article>
      <article>
        <span>不可观测项</span>
        <strong>{{ page.overview?.observabilityGaps.length ?? '—' }}</strong>
        <small>未知不计入正常</small>
      </article>
    </div>

    <div class="v2-system-monitoring-overview__actions">
      <span>{{ generatedAtLabel }}</span>
      <el-tag type="info" effect="plain">管理员只读</el-tag>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        执行探针
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
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
