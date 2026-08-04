<template>
  <aside class="v2-monitoring-detail" aria-label="选中异常详情" aria-live="polite">
    <template v-if="page.selectedFinding">
      <header>
        <div>
          <span>处置焦点</span>
          <h2>{{ page.selectedFinding.subject }}</h2>
        </div>
        <el-tag
          :type="page.businessMonitoringSeverityMeta(page.selectedFinding.severity).type"
          effect="plain"
        >
          {{ page.businessMonitoringSeverityMeta(page.selectedFinding.severity).label }}
        </el-tag>
      </header>

      <p>{{ page.selectedFinding.description }}</p>

      <dl>
        <div>
          <dt>业务分类</dt>
          <dd>{{ page.businessMonitoringCategoryLabel(page.selectedFinding.category) }}</dd>
        </div>
        <div>
          <dt>发现时间</dt>
          <dd>{{ page.formatBusinessMonitoringDate(page.selectedFinding.detectedAt) }}</dd>
        </div>
        <div>
          <dt>判定规则</dt>
          <dd>{{ page.selectedFinding.ruleKey }}</dd>
        </div>
        <div>
          <dt>退出条件</dt>
          <dd>修正源数据后自动消失</dd>
        </div>
      </dl>

      <div class="v2-monitoring-detail__note">
        <strong>处理边界</strong>
        <span>本页不维护“已处理”状态；请回到业务源页面修正真实数据。</span>
      </div>

      <AppButton variant="primary" @click="page.openSource(page.selectedFinding.route)">
        打开源数据
      </AppButton>
    </template>

    <div v-else class="v2-monitoring-detail__empty">
      <span>处置焦点</span>
      <strong>当前没有可查看的异常</strong>
      <p>调整筛选条件，或等待下一次实时计算。</p>
    </div>
  </aside>
</template>

<script setup lang="ts">
import type { UnwrapNestedRefs } from 'vue';
import AppButton from '@/components/ui/AppButton.vue';
import type { useBusinessMonitoringPage } from '../useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

defineProps<{ page: BusinessMonitoringPage }>();
</script>

<style scoped>
.v2-monitoring-detail {
  display: grid;
  min-width: 0;
  align-content: start;
  gap: 16px;
  padding: 18px;
  border: 1px solid var(--v2-border);
  border-radius: var(--v3-radius);
  background: var(--v2-surface);
}

.v2-monitoring-detail header {
  display: flex;
  min-width: 0;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.v2-monitoring-detail header > div {
  display: grid;
  min-width: 0;
  gap: 5px;
}

.v2-monitoring-detail header span,
.v2-monitoring-detail__empty > span {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-monitoring-detail h2 {
  margin: 0;
  color: var(--v2-text);
  font-size: 17px;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.v2-monitoring-detail > p,
.v2-monitoring-detail__empty p {
  margin: 0;
  color: var(--v2-text-soft);
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}

.v2-monitoring-detail dl {
  display: grid;
  margin: 0;
  gap: 0;
  border-top: 1px solid var(--v2-border-soft);
}

.v2-monitoring-detail dl div {
  display: grid;
  min-width: 0;
  grid-template-columns: 76px minmax(0, 1fr);
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--v2-border-soft);
}

.v2-monitoring-detail dt {
  color: var(--v2-text-soft);
  font-size: 11px;
}

.v2-monitoring-detail dd {
  margin: 0;
  color: var(--v2-text);
  font-size: 12px;
  font-weight: 650;
  overflow-wrap: anywhere;
}

.v2-monitoring-detail__note {
  display: grid;
  gap: 4px;
  padding: 11px 12px;
  border-left: 3px solid var(--v2-accent);
  background: color-mix(in srgb, var(--v2-accent) 6%, transparent);
}

.v2-monitoring-detail__note strong {
  color: var(--v2-text);
  font-size: 12px;
}

.v2-monitoring-detail__note span {
  color: var(--v2-text-soft);
  font-size: 11px;
  line-height: 1.6;
}

.v2-monitoring-detail .app-button {
  width: 100%;
}

.v2-monitoring-detail__empty {
  display: grid;
  min-height: 220px;
  align-content: center;
  gap: 8px;
}

.v2-monitoring-detail__empty strong {
  color: var(--v2-text);
  font-size: 15px;
}
</style>
