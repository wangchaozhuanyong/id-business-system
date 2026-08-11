<template>
  <section class="v2-dashboard-section" :class="`is-${variant}`">
    <V2SectionHeading :title="title" :help="help">
      <template v-if="badge" #actions>
        <el-tag type="danger" effect="light" size="small">{{ badge }}</el-tag>
      </template>
    </V2SectionHeading>
    <div class="v2-dashboard-metric-list">
      <article
        v-for="item in items"
        :key="item.key"
        class="v2-dashboard-metric"
        :class="[`is-${item.tone || 'neutral'}`, { 'is-unavailable': item.value === null }]"
      >
        <header class="v2-dashboard-metric__header">
          <div class="v2-dashboard-metric__identity">
            <el-icon
              v-if="variant === 'risk'"
              class="v2-dashboard-metric__indicator"
              aria-hidden="true"
            >
              <component :is="indicatorIcon(item)" />
            </el-icon>
            <span>{{ item.label }}</span>
          </div>
          <el-tag v-if="variant === 'risk'" :type="statusType(item)" effect="light" size="small">
            {{ statusLabel(item) }}
          </el-tag>
        </header>
        <strong>{{ page.metricValue(item) }}</strong>
        <footer>
          <p>{{ item.description }}</p>
          <AppButton
            v-if="item.route"
            class="v2-dashboard-metric__action"
            size="small"
            variant="ghost"
            icon-only
            :title="item.actionLabel"
            @click="page.openRoute(item.route)"
          >
            <el-icon><ArrowRight /></el-icon>
          </AppButton>
        </footer>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { ArrowRight, CircleCloseFilled, InfoFilled, WarningFilled } from '@element-plus/icons-vue';
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import V2SectionHeading from '@/v2/components/V2SectionHeading.vue';
import type { DashboardMetricItem, useDashboardPage } from '../useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{
  title: string;
  help: string;
  badge?: string;
  variant: 'risk' | 'business';
  items: DashboardMetricItem[];
  page: DashboardPage;
}>();

function statusType(item: DashboardMetricItem) {
  return item.tone === 'danger' ? 'danger' : item.tone === 'warning' ? 'warning' : 'info';
}

function statusLabel(item: DashboardMetricItem) {
  if (item.value === null) return '无权限';
  if (item.tone === 'danger') return '异常';
  if (item.key === 'due-soon') return '预警';
  if (item.key === 'low-balance') return '不足';
  return '待处理';
}

function indicatorIcon(item: DashboardMetricItem) {
  if (item.value === null) return InfoFilled;
  return item.tone === 'danger' ? CircleCloseFilled : WarningFilled;
}
</script>

<style scoped>
.v2-dashboard-section {
  display: grid;
  min-width: 0;
  grid-template-rows: auto minmax(0, 1fr);
  align-content: start;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-section > :deep(.v2-section-heading) {
  min-height: 52px;
  padding: 10px 15px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-metric-list {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  padding: 12px;
  background: var(--v2-surface-muted);
}

.v2-dashboard-metric {
  display: grid;
  min-width: 0;
  min-height: 118px;
  grid-template-rows: auto auto minmax(28px, 1fr);
  align-content: start;
  gap: 7px;
  padding: 12px;
  border: 1px solid var(--v2-border-soft);
  border-radius: var(--v3-radius-sm);
  background: var(--v2-surface);
  transition:
    border-color 150ms var(--v3-ease),
    box-shadow 150ms var(--v3-ease);
}

.v2-dashboard-metric:hover {
  border-color: color-mix(in srgb, var(--v2-accent) 32%, var(--v2-border));
  box-shadow: 0 8px 18px rgba(7, 24, 41, 0.06);
}

.v2-dashboard-metric__header,
.v2-dashboard-metric footer {
  display: flex;
  min-width: 0;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.v2-dashboard-metric__indicator {
  flex: 0 0 auto;
  color: var(--v2-text-soft);
  font-size: 14px;
}

.v2-dashboard-metric.is-warning .v2-dashboard-metric__indicator {
  color: var(--el-color-warning);
}

.v2-dashboard-metric.is-danger .v2-dashboard-metric__indicator {
  color: var(--v2-danger);
}

.v2-dashboard-metric__identity {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
}

.v2-dashboard-metric__identity > span {
  color: var(--v2-text);
  font-size: 12px;
  font-weight: 700;
}

.v2-dashboard-metric p {
  min-width: 0;
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-metric strong {
  color: var(--v2-text);
  font-size: 20px;
  font-variant-numeric: tabular-nums;
  line-height: var(--v3-line-height-tight);
  overflow-wrap: anywhere;
}

.v2-dashboard-metric.is-danger strong {
  color: var(--v2-danger);
}

.v2-dashboard-metric.is-warning strong {
  color: var(--el-color-warning-dark-2);
}

.v2-dashboard-section.is-business .v2-dashboard-metric.is-success strong {
  color: var(--v2-success);
}

.v2-dashboard-metric.is-unavailable strong {
  color: var(--v2-text-soft);
  font-size: 13px;
}

.v2-dashboard-metric p {
  margin: 0;
  line-height: 1.55;
}

.v2-dashboard-metric__action {
  flex: 0 0 auto;
}

@media (max-width: 1100px) and (min-width: 701px) {
  .v2-dashboard-metric-list {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

@media (max-width: 700px) {
  .v2-dashboard-metric-list {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
