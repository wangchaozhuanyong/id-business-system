<template>
  <section v-if="page.summary" class="v2-monitoring-summary" aria-label="业务异常态势">
    <div class="v2-monitoring-summary__lead">
      <span>当前异常</span>
      <strong>{{ page.summary.total }}</strong>
      <p>来自 {{ page.rules.length }} 条实时规则；修正源数据后自动退出队列。</p>
      <dl>
        <div class="is-critical">
          <dt>紧急</dt>
          <dd>{{ page.summary.critical }}</dd>
        </div>
        <div class="is-warning">
          <dt>警告</dt>
          <dd>{{ page.summary.warning }}</dd>
        </div>
        <div>
          <dt>提示</dt>
          <dd>{{ page.summary.info }}</dd>
        </div>
      </dl>
    </div>

    <div class="v2-monitoring-summary__distribution">
      <header>
        <div>
          <span>风险分布</span>
          <strong>按业务来源</strong>
        </div>
        <small>点击分类可筛选</small>
      </header>
      <button
        v-for="item in page.categoryBreakdown"
        :key="item.category"
        type="button"
        :class="{ 'is-active': page.query.category === item.category }"
        :aria-pressed="page.query.category === item.category"
        @click="page.applyCategory(item.category)"
      >
        <span>{{ item.label }}</span>
        <span class="v2-monitoring-summary__bar" aria-hidden="true">
          <i :style="{ width: `${item.share}%` }" />
        </span>
        <strong>{{ item.count }}</strong>
      </button>
    </div>
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
  grid-template-columns: minmax(260px, 0.82fr) minmax(380px, 1.18fr);
  overflow: hidden;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-monitoring-summary__lead {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 8px;
  padding: 22px;
  border-right: 1px solid var(--v2-border-soft);
  background: color-mix(in srgb, var(--v2-accent) 5%, var(--v2-surface));
}

.v2-monitoring-summary__lead > span,
.v2-monitoring-summary__distribution header span,
.v2-monitoring-summary__distribution small {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-monitoring-summary__lead > strong {
  color: var(--v2-text);
  font-size: clamp(34px, 4vw, 48px);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

.v2-monitoring-summary__lead p {
  max-width: 32em;
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.65;
}

.v2-monitoring-summary__lead dl {
  display: flex;
  margin: 10px 0 0;
  gap: 22px;
}

.v2-monitoring-summary__lead dl div {
  display: grid;
  gap: 3px;
}

.v2-monitoring-summary__lead dt {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-monitoring-summary__lead dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 18px;
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}

.v2-monitoring-summary__lead .is-critical dd {
  color: var(--v2-danger);
}

.v2-monitoring-summary__lead .is-warning dd {
  color: var(--el-color-warning);
}

.v2-monitoring-summary__distribution {
  display: grid;
  align-content: start;
  gap: 4px;
  padding: 18px 20px;
}

.v2-monitoring-summary__distribution header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 5px;
}

.v2-monitoring-summary__distribution header div {
  display: grid;
  gap: 3px;
}

.v2-monitoring-summary__distribution header strong {
  color: var(--v2-text);
  font-size: 14px;
}

.v2-monitoring-summary__distribution button {
  display: grid;
  min-width: 0;
  grid-template-columns: minmax(72px, auto) minmax(70px, 1fr) 28px;
  align-items: center;
  gap: 10px;
  min-height: 34px;
  padding: 5px 7px;
  border: 0;
  border-radius: calc(var(--v3-radius) - 2px);
  color: var(--v2-text-soft);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

.v2-monitoring-summary__distribution button:hover,
.v2-monitoring-summary__distribution button:focus-visible,
.v2-monitoring-summary__distribution button.is-active {
  color: var(--v2-text);
  background: color-mix(in srgb, var(--v2-accent) 8%, transparent);
  outline: none;
}

.v2-monitoring-summary__distribution button:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--v2-accent) 48%, transparent);
}

.v2-monitoring-summary__distribution button > strong {
  color: inherit;
  text-align: right;
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.v2-monitoring-summary__bar {
  display: block;
  height: 5px;
  overflow: hidden;
  border-radius: 999px;
  background: var(--v2-border-soft);
}

.v2-monitoring-summary__bar i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--v2-accent);
}

@media (max-width: 760px) {
  .v2-monitoring-summary {
    grid-template-columns: minmax(0, 1fr);
  }

  .v2-monitoring-summary__lead {
    border-right: 0;
    border-bottom: 1px solid var(--v2-border-soft);
  }
}

@media (max-width: 480px) {
  .v2-monitoring-summary__lead,
  .v2-monitoring-summary__distribution {
    padding: 16px;
  }
}
</style>
