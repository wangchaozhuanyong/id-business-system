<template>
  <div class="v2-shell v2-business-monitoring-design-fixture">
    <aside class="v2-sidebar">
      <div class="v2-brand">
        <V2BrandLogo class="v2-brand__mark" logo-text="ID" />
        <div class="v2-brand__copy">
          <strong>ID 业务管理系统</strong>
          <span>业务管理工作台</span>
        </div>
      </div>

      <nav class="v2-navigation" aria-label="设计验收导航">
        <section
          v-for="section in navigation"
          :key="section.title"
          class="v2-navigation__section"
          :class="{ 'is-open': section.active, 'is-active': section.active }"
        >
          <button class="v2-navigation__parent" type="button">
            <el-icon class="v2-navigation__parent-icon"><component :is="section.icon" /></el-icon>
            <span class="v2-navigation__parent-label">{{ section.title }}</span>
            <el-icon class="v2-navigation__chevron"><ArrowDown /></el-icon>
          </button>
          <div v-if="section.active" class="v2-navigation__children">
            <a class="v2-navigation__item router-link-active" href="#business-monitoring">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">业务监控</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>业务监控</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-business-monitoring-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-business-monitoring-fixture-notice" role="status">
            {{ notice }}
          </p>
          <section class="v2-records-page v2-business-monitoring-page">
            <V2BusinessMonitoringOverview :page="page" />
            <V2BusinessMonitoringSummary :page="page" />
            <V2BusinessMonitoringToolbar :page="page" />
            <V2BusinessMonitoringWorkspace :page="page" />
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, reactive, ref } from 'vue';
import type { UnwrapNestedRefs } from 'vue';
import {
  ArrowDown,
  Bell,
  Collection,
  DataAnalysis,
  Document,
  Setting,
  User
} from '@element-plus/icons-vue';
import V2BrandLogo from '@/v2/components/V2BrandLogo.vue';
import V2BusinessMonitoringOverview from '@/v2/features/business-monitoring/components/V2BusinessMonitoringOverview.vue';
import V2BusinessMonitoringSummary from '@/v2/features/business-monitoring/components/V2BusinessMonitoringSummary.vue';
import V2BusinessMonitoringToolbar from '@/v2/features/business-monitoring/components/V2BusinessMonitoringToolbar.vue';
import V2BusinessMonitoringWorkspace from '@/v2/features/business-monitoring/components/V2BusinessMonitoringWorkspace.vue';
import {
  businessMonitoringCategoryBreakdown,
  businessMonitoringCategoryLabel,
  businessMonitoringSeverityMeta,
  formatBusinessMonitoringDate
} from '@/v2/features/business-monitoring/business-monitoring-presentation';
import type {
  V2BusinessMonitoringCategory,
  V2BusinessMonitoringFinding,
  V2BusinessMonitoringSeverity,
  V2BusinessMonitoringSummary as BusinessMonitoringSummary
} from '@/v2/features/business-monitoring/contracts';
import type { useBusinessMonitoringPage } from '@/v2/features/business-monitoring/useBusinessMonitoringPage';

type BusinessMonitoringPage = UnwrapNestedRefs<ReturnType<typeof useBusinessMonitoringPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: false },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '监控中心', icon: DataAnalysis, active: true },
  { title: '系统设置', icon: Setting, active: false }
];

const notice = ref('');
const emptyState = new URLSearchParams(window.location.search).get('state') === 'empty';
const categories: V2BusinessMonitoringCategory[] = [
  'order',
  'balance',
  'renewal',
  'exchange_rate',
  'finance'
];
const severities: V2BusinessMonitoringSeverity[] = ['critical', 'warning', 'info'];
const subjects = [
  '订单已等待处理超过 30 分钟',
  'ID 可用余额低于安全阈值',
  '服务将在 24 小时内到期',
  '汇率采集运行失败',
  '历史账务基线待核对'
];
const descriptions = [
  '订单仍处于待处理状态，需回到订单页确认真实处理进度。',
  '当前余额已无法覆盖下一笔预计消耗，需补充余额或更换 ID。',
  '开通记录进入续费预警窗口，需核对客户续费意向。',
  '最近一次采集没有产生可用汇率，请在汇率页复核运行结果。',
  '当前账务快照与历史基线存在差异，需回到财务流水核对。'
];
const routes = [
  '/v2/orders',
  '/v2/accounts',
  '/v2/renewals',
  '/v2/exchange-rates',
  '/v2/finance/ledger'
];

const allFindings: V2BusinessMonitoringFinding[] = emptyState
  ? []
  : Array.from({ length: 27 }, (_, index) => {
      const categoryIndex = index % categories.length;
      const severity = severities[index % severities.length];
      return {
        id: `finding-${index + 1}`,
        ruleKey: `${categories[categoryIndex]}.${severity}.${String(index + 1).padStart(2, '0')}`,
        category: categories[categoryIndex],
        severity,
        subject: `${subjects[categoryIndex]} ${String(index + 1).padStart(2, '0')}`,
        description: descriptions[categoryIndex],
        detectedAt: `2026-08-10T${String(8 + (index % 10)).padStart(2, '0')}:${String((index * 7) % 60).padStart(2, '0')}:00.000Z`,
        sourceType: categories[categoryIndex],
        sourceId: `source-${index + 1}`,
        route: routes[categoryIndex],
        status: 'open',
        resolutionMode: 'source_state'
      };
    });

const query = reactive({
  page: 1,
  pageSize: 10,
  severity: '' as V2BusinessMonitoringSeverity | '',
  category: '' as V2BusinessMonitoringCategory | ''
});
const selectedFindingId = ref<string | null>(allFindings[0]?.id ?? null);

const summary = computed<BusinessMonitoringSummary>(() => {
  const byCategory: BusinessMonitoringSummary['byCategory'] = {
    order: 0,
    balance: 0,
    renewal: 0,
    exchange_rate: 0,
    finance: 0
  };
  let critical = 0;
  let warning = 0;
  let info = 0;
  for (const finding of allFindings) {
    byCategory[finding.category] += 1;
    if (finding.severity === 'critical') critical += 1;
    if (finding.severity === 'warning') warning += 1;
    if (finding.severity === 'info') info += 1;
  }
  return { total: allFindings.length, critical, warning, info, byCategory };
});

const filteredFindings = computed(() =>
  allFindings.filter(
    (finding) =>
      (!query.severity || finding.severity === query.severity) &&
      (!query.category || finding.category === query.category)
  )
);
const items = computed(() => {
  const start = (query.page - 1) * query.pageSize;
  return filteredFindings.value.slice(start, start + query.pageSize);
});
const selectedFinding = computed(
  () =>
    items.value.find((finding) => finding.id === selectedFindingId.value) ?? items.value[0] ?? null
);

function resetSelection() {
  query.page = 1;
  selectedFindingId.value = filteredFindings.value[0]?.id ?? null;
}

const page = reactive({
  query,
  items,
  total: computed(() => filteredFindings.value.length),
  summary,
  categoryBreakdown: computed(() => businessMonitoringCategoryBreakdown(summary.value)),
  rules: Array.from({ length: 9 }, (_, index) => ({
    key: `fixture-rule-${index + 1}`,
    category: categories[index % categories.length],
    severity: severities[index % severities.length],
    title: `实时规则 ${index + 1}`,
    description: '按当前源数据状态计算'
  })),
  generatedAt: '2026-08-10T16:08:00.000Z',
  loading: false,
  error: '',
  selectedFinding,
  hasData: true,
  refresh: () => {
    notice.value = '业务异常快照已刷新；设计验收数据未被修改。';
  },
  handleFilterChange: resetSelection,
  applySeverity: (severity: V2BusinessMonitoringSeverity | '') => {
    if (query.severity === severity) return;
    query.severity = severity;
    resetSelection();
  },
  applyCategory: (category: V2BusinessMonitoringCategory) => {
    query.category = query.category === category ? '' : category;
    resetSelection();
  },
  selectFinding: (finding: V2BusinessMonitoringFinding) => {
    selectedFindingId.value = finding.id;
  },
  businessMonitoringRowClassName: ({ row }: { row: V2BusinessMonitoringFinding }) =>
    row.id === selectedFinding.value?.id ? 'is-monitoring-selected' : '',
  resetFilters: () => {
    query.severity = '';
    query.category = '';
    resetSelection();
  },
  handlePageChange: (currentPage: number) => {
    query.page = currentPage;
    selectedFindingId.value = items.value[0]?.id ?? null;
  },
  handlePageSizeChange: (pageSize: number) => {
    query.pageSize = pageSize;
    resetSelection();
  },
  openSource: (route: string) => {
    notice.value = `预览操作：将进入源数据页 ${route}`;
  },
  businessMonitoringCategoryLabel,
  businessMonitoringSeverityMeta,
  formatBusinessMonitoringDate
}) as unknown as BusinessMonitoringPage;
</script>

<style scoped>
.v2-business-monitoring-fixture-avatar {
  display: inline-grid;
  width: 32px;
  height: 32px;
  place-items: center;
  border-radius: 50%;
  background: #eaf1ff;
  color: #194ea8;
  font-size: 12px;
  font-weight: 700;
}

.v2-business-monitoring-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
