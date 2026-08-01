<template>
  <section v-if="page.summary" class="v2-monitoring-summary" aria-label="业务异常汇总">
    <article>
      <span>当前异常</span>
      <strong>{{ page.summary.total }}</strong>
      <small>全部规则实时快照</small>
    </article>
    <article class="is-critical">
      <span>紧急</span>
      <strong>{{ page.summary.critical }}</strong>
      <small>需要优先复核</small>
    </article>
    <article class="is-warning">
      <span>警告</span>
      <strong>{{ page.summary.warning }}</strong>
      <small>需要跟进处理</small>
    </article>
    <article>
      <span>监控规则</span>
      <strong>{{ page.rules.length }}</strong>
      <small>按源状态自动判定</small>
    </article>
  </section>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

defineProps<{ page: BusinessMonitoringPage }>();
</script>

<style scoped>
.v2-monitoring-summary {
  display: grid;
  min-width: 0;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.v2-monitoring-summary article {
  display: grid;
  min-width: 0;
  gap: 5px;
  padding: 14px 16px;
  border: 1px solid var(--v2-border);
  border-left: 3px solid var(--v2-accent);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-monitoring-summary article.is-critical {
  border-left-color: var(--v2-danger);
}

.v2-monitoring-summary article.is-warning {
  border-left-color: var(--el-color-warning);
}

.v2-monitoring-summary span,
.v2-monitoring-summary small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-monitoring-summary strong {
  color: var(--v2-text);
  font-size: 22px;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 900px) {
  .v2-monitoring-summary {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 480px) {
  .v2-monitoring-summary {
    grid-template-columns: minmax(0, 1fr);
  }
}
</style>
