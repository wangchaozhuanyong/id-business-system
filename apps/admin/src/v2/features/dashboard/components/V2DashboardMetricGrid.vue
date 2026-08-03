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
        <el-icon
          v-if="variant === 'risk'"
          class="v2-dashboard-metric__indicator"
          aria-hidden="true"
        >
          <component :is="indicatorIcon(item)" />
        </el-icon>
        <div class="v2-dashboard-metric__identity">
          <span>{{ item.label }}</span>
          <el-tag v-if="variant === 'risk'" :type="statusType(item)" effect="light" size="small">
            {{ statusLabel(item) }}
          </el-tag>
        </div>
        <strong>{{ page.metricValue(item) }}</strong>
        <p>{{ item.description }}</p>
        <AppButton
          v-if="item.route"
          class="v2-dashboard-metric__action"
          size="small"
          variant="ghost"
          :icon-only="variant === 'business'"
          :title="item.actionLabel"
          @click="page.openRoute(item.route)"
        >
          <span v-if="variant === 'risk'">{{ item.actionLabel }}</span>
          <el-icon><ArrowRight /></el-icon>
        </AppButton>
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
  align-content: start;
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-dashboard-section > :deep(.v2-section-heading) {
  min-height: 50px;
  padding: 9px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-metric-list {
  display: grid;
  min-width: 0;
}

.v2-dashboard-metric {
  display: grid;
  min-width: 0;
  min-height: 49px;
  grid-template-columns: minmax(126px, 0.75fr) minmax(92px, auto) minmax(160px, 1.25fr) auto;
  align-items: center;
  gap: 12px;
  padding: 6px 14px;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-dashboard-metric:last-child {
  border-bottom: 0;
}

.v2-dashboard-section.is-risk .v2-dashboard-metric {
  grid-template-columns:
    6px minmax(150px, 0.8fr) minmax(80px, auto) minmax(180px, 1.15fr)
    minmax(116px, auto);
}

.v2-dashboard-section.is-business .v2-dashboard-metric {
  grid-template-columns: minmax(74px, 0.65fr) minmax(90px, auto) minmax(0, 1fr) 32px;
  gap: 8px;
}

.v2-dashboard-metric__indicator {
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
  justify-content: space-between;
  gap: 8px;
}

.v2-dashboard-metric__identity > span {
  color: var(--v2-text);
  font-size: 12px;
  font-weight: 700;
}

.v2-dashboard-metric p {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-dashboard-metric strong {
  color: var(--v2-text);
  font-size: 14px;
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

.v2-dashboard-section.is-business .v2-dashboard-metric strong {
  font-size: 16px;
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
  justify-self: end;
  white-space: nowrap;
}

@media (max-width: 1180px) {
  .v2-dashboard-section.is-risk .v2-dashboard-metric {
    grid-template-columns: 6px minmax(138px, 0.8fr) minmax(76px, auto) minmax(150px, 1fr) auto;
  }
}

@media (max-width: 700px) {
  .v2-dashboard-metric,
  .v2-dashboard-section.is-risk .v2-dashboard-metric {
    min-height: 92px;
    grid-template-columns: 6px minmax(0, 1fr) auto;
    gap: 8px 10px;
    padding-block: 12px;
  }

  .v2-dashboard-section.is-business .v2-dashboard-metric {
    grid-template-columns: minmax(0, 1fr) auto auto;
  }

  .v2-dashboard-section.is-risk .v2-dashboard-metric__identity {
    grid-column: 2;
  }

  .v2-dashboard-section.is-risk .v2-dashboard-metric strong {
    grid-column: 3;
    grid-row: 1;
  }

  .v2-dashboard-section.is-risk .v2-dashboard-metric p {
    grid-column: 2 / -1;
  }

  .v2-dashboard-section.is-risk .v2-dashboard-metric__action {
    grid-column: 2 / -1;
    justify-self: start;
  }

  .v2-dashboard-section.is-business .v2-dashboard-metric p {
    grid-column: 1 / -1;
  }
}
</style>
