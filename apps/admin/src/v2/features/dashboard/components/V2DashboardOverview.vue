<template>
  <section
    v-if="page.overview"
    class="v2-dashboard-overview"
    data-theme-dashboard-overview
    aria-label="仪表盘经营概览"
  >
    <div class="v2-dashboard-overview__intro">
      <span class="v2-dashboard-overview__eyebrow">OPERATIONS CONTROL</span>
      <h2>经营状态总览</h2>
      <p>
        业务日 {{ page.overview.businessDate }} · Asia/Kuala_Lumpur<br />
        权限外数据明确显示为“无权限”，不使用 0 代替。
      </p>
    </div>

    <div class="v2-dashboard-overview__metrics" aria-label="当前经营关键指标">
      <article>
        <span>需处理风险</span>
        <strong :class="{ 'is-danger': page.activeRiskCategoryCount > 0 }">
          {{ page.activeRiskCategoryCount }}
        </strong>
        <small>当前异常类别</small>
      </article>
      <article>
        <span>今日完成</span>
        <strong>{{ valueWithSuffix(page.overview.business.todayCompletedOrders, '单') }}</strong>
        <small>仍为完成状态</small>
      </article>
      <article>
        <span>可用 ID</span>
        <strong>{{ valueWithSuffix(page.overview.assets.availableAccounts, '个') }}</strong>
        <small>未售且未报损</small>
      </article>
      <article>
        <span>今日利润</span>
        <strong>{{ page.formatDashboardMoney(page.overview.business.todayProfitCny) }}</strong>
        <small>已确认订单利润</small>
      </article>
    </div>

    <div class="v2-dashboard-overview__actions">
      <span>更新于 {{ page.formatDashboardDate(page.overview.generatedAt) }}</span>
      <AppButton variant="ghost" :disabled="page.loading" @click="page.refresh">
        <el-icon><Refresh /></el-icon>
        刷新
      </AppButton>
    </div>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import { Refresh } from '@element-plus/icons-vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useDashboardPage } from '../useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

defineProps<{ page: DashboardPage }>();

function valueWithSuffix(value: number | null, suffix: string) {
  return value === null ? '无权限' : `${value} ${suffix}`;
}
</script>

<style scoped>
.v2-dashboard-overview {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(230px, 0.78fr) minmax(470px, 1.5fr) max-content;
  align-items: center;
  gap: 20px;
  padding: 18px 20px;
  border: 1px solid var(--v2-overview-border);
  border-radius: var(--v3-radius);
  background: var(--v2-overview-bg);
  color: var(--v2-overview-text);
  box-shadow: var(--v2-overview-shadow);
}

.v2-dashboard-overview__intro {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.v2-dashboard-overview__eyebrow {
  color: var(--v2-overview-accent);
  font-size: 10px;
  font-weight: var(--v3-font-weight-bold);
  letter-spacing: 0.14em;
}

.v2-dashboard-overview__intro h2,
.v2-dashboard-overview__intro p {
  margin: 0;
}

.v2-dashboard-overview__intro h2 {
  font-size: 17px;
  font-weight: var(--v3-font-weight-bold);
  letter-spacing: 0.01em;
}

.v2-dashboard-overview__intro p {
  max-width: 42ch;
  color: var(--v2-overview-text-soft);
  font-size: 11px;
  line-height: 1.6;
}

.v2-dashboard-overview__metrics {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(104px, 1fr));
  overflow: hidden;
  border: 1px solid var(--v2-overview-divider);
  border-radius: var(--v3-radius-sm);
}

.v2-dashboard-overview__metrics article {
  display: grid;
  min-width: 0;
  gap: 3px;
  padding: 11px 13px;
  border-left: 1px solid var(--v2-overview-divider);
  background: var(--v2-overview-surface);
}

.v2-dashboard-overview__metrics article:first-child {
  border-left: 0;
}

.v2-dashboard-overview__metrics span,
.v2-dashboard-overview__metrics small,
.v2-dashboard-overview__actions > span {
  color: var(--v2-overview-text-soft);
  font-size: 10px;
}

.v2-dashboard-overview__metrics strong {
  overflow: hidden;
  color: var(--v2-overview-text);
  font-size: 19px;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.v2-dashboard-overview__metrics strong.is-danger {
  color: var(--v2-danger);
}

.v2-dashboard-overview__actions {
  display: grid;
  min-width: 0;
  justify-items: end;
  gap: 8px;
}

.v2-dashboard-overview__actions .app-button--ghost.el-button {
  --el-button-text-color: var(--v2-overview-text);
  --el-button-border-color: var(--v2-overview-control-border);
  --el-button-hover-text-color: var(--v2-overview-text);
  --el-button-hover-bg-color: var(--v2-overview-control-hover);
  --el-button-hover-border-color: var(--v2-overview-control-hover-border);
  --el-button-active-text-color: var(--v2-overview-text);
  --el-button-active-bg-color: var(--v2-overview-control-active);
  --el-button-active-border-color: var(--v2-overview-control-active-border);
}

@media (max-width: 1180px) {
  .v2-dashboard-overview {
    grid-template-columns: minmax(210px, 0.72fr) minmax(0, 1.28fr);
  }

  .v2-dashboard-overview__actions {
    grid-column: 1 / -1;
    grid-template-columns: 1fr auto;
    align-items: center;
    justify-items: start;
  }

  .v2-dashboard-overview__actions .app-button {
    justify-self: end;
  }
}

@media (max-width: 1050px) {
  .v2-dashboard-overview {
    grid-template-columns: minmax(0, 1fr);
    padding: 16px;
  }

  .v2-dashboard-overview__metrics {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }

  .v2-dashboard-overview__metrics article:nth-child(3) {
    border-left: 0;
  }

  .v2-dashboard-overview__metrics article:nth-child(-n + 2) {
    border-bottom: 1px solid var(--v2-overview-divider);
  }

  .v2-dashboard-overview__actions {
    grid-column: auto;
  }
}

@media (max-width: 460px) {
  .v2-dashboard-overview__metrics {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-dashboard-overview__metrics article,
  .v2-dashboard-overview__metrics article:nth-child(3) {
    border-left: 0;
    border-bottom: 1px solid var(--v2-overview-divider);
  }

  .v2-dashboard-overview__metrics article:last-child {
    border-bottom: 0;
  }
}
</style>
