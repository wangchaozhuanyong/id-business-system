<template>
  <div class="v2-shell v2-dashboard-design-fixture">
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
            <a class="v2-navigation__item router-link-active" href="#dashboard">
              <span class="v2-navigation__item-dot" aria-hidden="true" />
              <span class="v2-navigation__item-label">仪表盘</span>
            </a>
          </div>
        </section>
      </nav>
    </aside>

    <div class="v2-workspace">
      <header class="v2-topbar">
        <div class="v2-topbar__identity"><h1>仪表盘</h1></div>
        <div class="v2-topbar__utilities">
          <span>方案 3 · 设计验收</span>
          <el-icon><Bell /></el-icon>
          <span class="v2-dashboard-fixture-avatar">管</span>
        </div>
      </header>

      <main class="v2-content">
        <div class="v2-content__inner">
          <p v-if="notice" class="v2-dashboard-fixture-notice" role="status">{{ notice }}</p>
          <section class="v2-records-page v2-dashboard-page">
            <div class="v2-dashboard-content">
              <V2DashboardOverview :page="page" />
              <div class="v2-dashboard-overview-grid">
                <V2DashboardMetricGrid
                  variant="risk"
                  title="待办与风险"
                  :badge="`${page.activeRiskCategoryCount} 项需处理`"
                  help="风险数字是当前状态快照；点击可进入对应模块处理。"
                  :items="page.riskMetrics"
                  :page="page"
                />
                <V2DashboardMetricGrid
                  variant="business"
                  title="今日业务"
                  help="今日按马来西亚时区计算；完成数、收入和利润只包含当前仍为已完成状态的订单。"
                  :items="page.businessMetrics"
                  :page="page"
                />
              </div>
              <V2DashboardActivity :page="page" />
            </div>
          </section>
        </div>
      </main>
    </div>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue';
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
import V2DashboardActivity from '@/v2/features/dashboard/components/V2DashboardActivity.vue';
import V2DashboardMetricGrid from '@/v2/features/dashboard/components/V2DashboardMetricGrid.vue';
import V2DashboardOverview from '@/v2/features/dashboard/components/V2DashboardOverview.vue';
import type { V2DashboardOverview as DashboardOverviewContract } from '@/v2/features/dashboard/contracts';
import {
  auditActionLabel,
  dashboardOrderStatusMeta,
  financeHistoryLabel,
  formatDashboardDate,
  formatDashboardMoney,
  formatDashboardTime
} from '@/v2/features/dashboard/dashboard-presentation';
import type {
  DashboardMetricItem,
  useDashboardPage
} from '@/v2/features/dashboard/useDashboardPage';

type DashboardPage = UnwrapNestedRefs<ReturnType<typeof useDashboardPage>>;

const navigation = [
  { title: '工作台', icon: Document, active: true },
  { title: '业务中心', icon: Collection, active: false },
  { title: '客户管理', icon: User, active: false },
  { title: '财务管理', icon: DataAnalysis, active: false },
  { title: '系统设置', icon: Setting, active: false }
];
const notice = ref('');
const overview: DashboardOverviewContract = {
  generatedAt: '2026-08-10T09:42:00+08:00',
  businessDate: '2026-08-10',
  timezone: 'Asia/Kuala_Lumpur',
  warningDays: 3,
  access: {
    orders: true,
    activations: true,
    renewals: true,
    accounts: true,
    balances: true,
    exchangeRates: true,
    finance: true,
    audit: true
  },
  business: {
    todayOrders: 18,
    todayCompletedOrders: 14,
    todayActivations: 11,
    todayTopups: 7,
    todayTopupCostCny: '3860.00',
    todayRevenueCny: '7638.00',
    todayProfitCny: '1846.20'
  },
  risks: {
    pendingOrders: 4,
    failedOrders: 1,
    overdueRenewals: 2,
    dueSoonRenewals: 6,
    lowBalanceAccounts: 3,
    failedExchangeRuns: 0
  },
  assets: {
    totalAccounts: 126,
    availableAccounts: 38,
    inventoryBookValueCny: '28642.50',
    financeHistoryStatus: 'completed'
  },
  recentOrders: [
    order(
      'V2202608100832',
      '星海科技',
      'ChatGPT Plus',
      'processing',
      '589.00',
      '2026-08-10T09:31:00+08:00'
    ),
    order(
      'V2202608100829',
      '林先生',
      'Claude Pro',
      'completed',
      '628.00',
      '2026-08-10T09:17:00+08:00'
    ),
    order(
      'V2202608100824',
      '方舟设计',
      'Midjourney',
      'pending',
      '436.00',
      '2026-08-10T08:56:00+08:00'
    ),
    order(
      'V2202608100818',
      '远景贸易',
      'Canva Pro',
      'completed',
      '298.00',
      '2026-08-10T08:30:00+08:00'
    ),
    order('V2202608100811', '王先生', 'Google One', 'failed', '168.00', '2026-08-10T08:08:00+08:00')
  ],
  upcomingRenewals: [
    renewal(
      'renewal-1',
      '星海科技',
      'ChatGPT Plus',
      '85********@qq.com',
      '2026-08-10T18:00:00+08:00'
    ),
    renewal(
      'renewal-2',
      '远景贸易',
      'Canva Pro',
      'ra***********@icloud.com',
      '2026-08-11T10:30:00+08:00'
    ),
    renewal(
      'renewal-3',
      '林先生',
      'Claude Pro',
      'li********@gmail.com',
      '2026-08-12T16:00:00+08:00'
    )
  ],
  recentAudits: [
    audit('audit-1', '订单管理', 'order_update', '订单', '2026-08-10T09:36:00+08:00', '陈主管'),
    audit(
      'audit-2',
      '续费管理',
      'renewal_confirm',
      '续费记录',
      '2026-08-10T09:22:00+08:00',
      '王莉'
    ),
    audit('audit-3', 'ID 管理', 'account_update', 'ID 账号', '2026-08-10T09:06:00+08:00', '李明'),
    audit(
      'audit-4',
      '汇率管理',
      'exchange_rate_update',
      '汇率记录',
      '2026-08-10T08:45:00+08:00',
      '系统'
    ),
    audit('audit-5', '客户管理', 'customer_create', '客户', '2026-08-10T08:18:00+08:00', '王莉')
  ]
};

const riskMetrics: DashboardMetricItem[] = [
  metric(
    'pending-orders',
    '待处理订单',
    4,
    '单',
    '草稿、待处理、等待外部或处理中',
    '处理待处理订单',
    'warning'
  ),
  metric('failed-orders', '失败订单', 1, '单', '当前状态为失败', '查看失败订单', 'danger'),
  metric('overdue-renewals', '已逾期', 2, '条', '服务到期时间早于今日', '处理逾期续费', 'danger'),
  metric('due-soon', '即将到期', 6, '条', '3 天预警窗口内', '查看即将到期', 'warning'),
  metric(
    'low-balance',
    '可用余额不足',
    3,
    '个 ID',
    '未售、未报损且当前余额不大于 0',
    '处理余额不足',
    'warning'
  ),
  metric('fx-failed', '汇率采集失败', 0, '次', '最近 24 小时无失败运行', '查看汇率记录', 'neutral')
];
const businessMetrics: DashboardMetricItem[] = [
  metric('orders', '今日订单', 18, '单', '今日新建订单', '查看今日订单', 'primary'),
  metric(
    'completed',
    '今日完成',
    14,
    '单',
    '今日进入且仍为完成状态',
    '查看今日完成订单',
    'success'
  ),
  metric('activations', '今日开通', 11, '条', '今日生成开通记录', '查看今日开通记录', 'success'),
  metric('topups', '今日加卡', 7, '张', '成本 ¥3,860.00', '查看今日加卡记录', 'primary'),
  {
    ...metric(
      'revenue',
      '今日收入',
      '7638.00',
      '',
      '只计当前仍为已完成的订单',
      '查看今日收入分析',
      'primary'
    ),
    money: true
  },
  {
    ...metric(
      'profit',
      '今日利润',
      '1846.20',
      '',
      '仅展示已确认的订单利润',
      '查看今日利润分析',
      'success'
    ),
    money: true
  }
];

if (new URLSearchParams(window.location.search).get('state') === 'empty') {
  overview.recentOrders = [];
  overview.upcomingRenewals = [];
  overview.recentAudits = [];
}

const page = reactive({
  overview,
  resolved: true,
  loading: false,
  error: '',
  businessMetrics,
  riskMetrics,
  activeRiskCategoryCount: 4,
  refresh: () => {
    notice.value = '仪表盘数据已刷新。';
  },
  openRoute: (route?: string) => {
    if (route) notice.value = `预览操作：将进入 ${route}`;
  },
  metricValue: (item: DashboardMetricItem) => {
    if (item.value === null) return '无权限';
    if (item.money) return formatDashboardMoney(String(item.value));
    return `${item.value}${item.suffix ? ` ${item.suffix}` : ''}`;
  },
  formatDashboardDate,
  formatDashboardTime,
  formatDashboardMoney,
  dashboardOrderStatusMeta,
  financeHistoryLabel,
  auditActionLabel
}) as unknown as DashboardPage;

function metric(
  key: string,
  label: string,
  value: number | string,
  suffix: string,
  description: string,
  actionLabel: string,
  tone: DashboardMetricItem['tone']
): DashboardMetricItem {
  return { key, label, value, suffix, description, actionLabel, route: '#', tone };
}

function order(
  orderNo: string,
  customer: string,
  service: string,
  status: DashboardOverviewContract['recentOrders'][number]['status'],
  receivedAmount: string,
  createdAt: string
): DashboardOverviewContract['recentOrders'][number] {
  return {
    id: orderNo,
    orderNo,
    status,
    receivedAmount,
    profitAmount: status === 'completed' ? '86.00' : null,
    createdAt,
    customer: { name: customer },
    serviceOption: { name: service }
  };
}

function renewal(
  id: string,
  customer: string,
  service: string,
  appleIdMasked: string,
  dueAt: string
): DashboardOverviewContract['upcomingRenewals'][number] {
  return {
    id,
    status: 'active',
    dueAt,
    customer: { name: customer },
    serviceOption: { name: service },
    account: { appleIdMasked }
  };
}

function audit(
  id: string,
  module: string,
  action: string,
  objectType: string,
  createdAt: string,
  displayName: string
): DashboardOverviewContract['recentAudits'][number] {
  return {
    id,
    module,
    action,
    objectType,
    createdAt,
    user: { username: displayName, displayName }
  };
}
</script>

<style scoped>
.v2-dashboard-fixture-avatar {
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

.v2-dashboard-fixture-notice {
  margin: 0 0 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--v2-accent) 28%, var(--v2-border));
  border-radius: var(--v3-radius-sm);
  background: var(--v2-accent-soft);
  color: var(--v2-accent);
  font-size: 12px;
}
</style>
