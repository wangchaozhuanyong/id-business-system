<template>
  <section class="v2-dashboard-section">
    <V2SectionHeading :title="title" :help="help" />
    <div class="v2-dashboard-metric-grid">
      <article
        v-for="item in items"
        :key="item.key"
        class="v2-dashboard-metric"
        :class="[`is-${item.tone || 'neutral'}`, { 'is-unavailable': item.value === null }]"
      >
        <span>{{ item.label }}</span>
        <strong>{{ page.metricValue(item) }}</strong>
        <p>{{ item.description }}</p>
        <AppButton
          v-if="item.route"
          class="v2-dashboard-metric__action"
          size="small"
          variant="ghost"
          @click="page.openRoute(item.route)"
        >
          查看详情
          <el-icon><ArrowRight /></el-icon>
        </AppButton>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { DashboardMetricItem, useDashboardPage } from '../useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{
  title: string;
  help: string;
  items: DashboardMetricItem[];
  page: DashboardPage;
}>();
</script>

<style scoped>
.v2-dashboard-section {
  display: grid;
  min-width: 0;
  gap: 12px;
}

.v2-dashboard-metric-grid {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}

.v2-dashboard-metric {
  position: relative;
  display: grid;
  min-width: 0;
  min-height: 142px;
  align-content: start;
  gap: 7px;
  padding: 16px;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-metric::before {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 3px;
  background: var(--v2-border);
  content: '';
}

.v2-dashboard-metric.is-primary::before {
  background: var(--v2-accent);
}

.v2-dashboard-metric.is-success::before {
  background: var(--v2-success);
}

.v2-dashboard-metric.is-warning::before {
  background: var(--el-color-warning);
}

.v2-dashboard-metric.is-danger::before {
  background: var(--v2-danger);
}

.v2-dashboard-metric > span,
.v2-dashboard-metric p {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-metric strong {
  color: var(--v2-text);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
  line-height: var(--v3-line-height-tight);
  overflow-wrap: anywhere;
}

.v2-dashboard-metric.is-unavailable strong {
  color: var(--v2-text-soft);
  font-size: 15px;
}

.v2-dashboard-metric p {
  margin: 0;
  line-height: 1.55;
}

.v2-dashboard-metric__action {
  justify-self: start;
  margin-top: auto;
}

@media (max-width: 980px) {
  .v2-dashboard-metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 560px) {
  .v2-dashboard-metric-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-dashboard-metric {
    min-height: 126px;
  }
}
</style>
