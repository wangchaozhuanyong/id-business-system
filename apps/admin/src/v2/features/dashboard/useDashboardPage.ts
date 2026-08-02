import { computed } from 'vue';
import { useRouter } from 'vue-router';
import { getApiErrorMessage } from '@/api/client';
import { useV2ModuleQuery } from '@/v2/composables/useV2Query';
import { navigateSafely } from '@/v2/router/navigateSafely';
import { v2DashboardApi } from './api';
import {
  auditActionLabel,
  dashboardOrderStatusMeta,
  financeHistoryLabel,
  formatDashboardDate,
  formatDashboardMoney
} from './dashboard-presentation';
import type { V2DashboardOverview } from './contracts';

export interface DashboardMetricItem {
  key: string;
  label: string;
  value: number | string | null;
  suffix?: string;
  description: string;
  route?: string;
  tone?: 'primary' | 'success' | 'warning' | 'danger' | 'neutral';
  money?: boolean;
}

export function useDashboardPage() {
  const router = useRouter();
  const dashboardQuery = useV2ModuleQuery<V2DashboardOverview>({
    moduleKey: 'dashboard',
    scope: 'dashboard',
    key: 'dashboard:overview',
    keepPreviousData: true,
    getRevalidateAt: () => Date.now() + 30_000,
    query: ({ signal }) => v2DashboardApi.overview({ signal })
  });

  const overview = computed(() => dashboardQuery.data.value ?? null);
  const resolved = computed(() => dashboardQuery.hasData.value);
  const loading = computed(
    () => dashboardQuery.isInitialLoading.value || dashboardQuery.isRefreshing.value
  );
  const error = computed(() =>
    dashboardQuery.error.value ? getApiErrorMessage(dashboardQuery.error.value) : ''
  );

  const businessMetrics = computed<DashboardMetricItem[]>(() => {
    const data = overview.value;
    if (!data) return [];
    return [
      {
        key: 'orders',
        label: '今日订单',
        value: data.business.todayOrders,
        suffix: '单',
        description: '今日新建订单',
        route: data.access.orders ? '/v2/orders' : undefined,
        tone: 'primary'
      },
      {
        key: 'completed',
        label: '今日完成',
        value: data.business.todayCompletedOrders,
        suffix: '单',
        description: '今日进入且仍为完成状态',
        route: data.access.orders ? '/v2/orders' : undefined,
        tone: 'success'
      },
      {
        key: 'activations',
        label: '今日开通',
        value: data.business.todayActivations,
        suffix: '条',
        description: '今日生成开通记录',
        route: data.access.activations ? '/v2/records/activations' : undefined,
        tone: 'success'
      },
      {
        key: 'topups',
        label: '今日加卡',
        value: data.business.todayTopups,
        suffix: '张',
        description:
          data.business.todayTopupCostCny === null
            ? '无余额查看权限'
            : `成本 ${formatDashboardMoney(data.business.todayTopupCostCny)}`,
        route: data.access.balances ? '/v2/records/topups' : undefined,
        tone: 'primary'
      },
      {
        key: 'revenue',
        label: '今日收入',
        value: data.business.todayRevenueCny,
        description: '只计当前仍为已完成的订单',
        route: data.access.finance ? '/v2/data/analytics' : undefined,
        tone: 'primary',
        money: true
      },
      {
        key: 'profit',
        label: '今日利润',
        value: data.business.todayProfitCny,
        description: '仅展示已确认的订单利润',
        route: data.access.finance ? '/v2/data/analytics' : undefined,
        tone: 'success',
        money: true
      }
    ];
  });

  const riskMetrics = computed<DashboardMetricItem[]>(() => {
    const data = overview.value;
    if (!data) return [];
    return [
      {
        key: 'pending-orders',
        label: '待处理订单',
        value: data.risks.pendingOrders,
        suffix: '单',
        description: '草稿、待处理、等待外部或处理中',
        route: data.access.orders ? '/v2/orders' : undefined,
        tone: 'warning'
      },
      {
        key: 'failed-orders',
        label: '失败订单',
        value: data.risks.failedOrders,
        suffix: '单',
        description: '当前状态为失败',
        route: data.access.orders ? '/v2/orders' : undefined,
        tone: 'danger'
      },
      {
        key: 'overdue-renewals',
        label: '已逾期',
        value: data.risks.overdueRenewals,
        suffix: '条',
        description: '服务到期时间早于今日',
        route: data.access.renewals ? '/v2/workbench/renewals' : undefined,
        tone: 'danger'
      },
      {
        key: 'due-soon',
        label: '即将到期',
        value: data.risks.dueSoonRenewals,
        suffix: '条',
        description: `${data.warningDays} 天预警窗口内`,
        route: data.access.renewals ? '/v2/workbench/renewals' : undefined,
        tone: 'warning'
      },
      {
        key: 'low-balance',
        label: '可用余额不足',
        value: data.risks.lowBalanceAccounts,
        suffix: '个 ID',
        description: '未售、未报损且当前余额不大于 0',
        route: data.access.accounts && data.access.balances ? '/v2/accounts' : undefined,
        tone: 'warning'
      },
      {
        key: 'fx-failed',
        label: '汇率采集失败',
        value: data.risks.failedExchangeRuns,
        suffix: '次',
        description: '最近 24 小时失败运行',
        route: data.access.exchangeRates ? '/v2/exchange-rates' : undefined,
        tone: 'danger'
      }
    ];
  });

  function refresh() {
    return dashboardQuery.refresh();
  }

  function openRoute(route?: string) {
    if (route) void navigateSafely(router, route);
  }

  function metricValue(item: DashboardMetricItem) {
    if (item.value === null) return '无权限';
    if (item.money) return formatDashboardMoney(String(item.value));
    return `${item.value}${item.suffix ? ` ${item.suffix}` : ''}`;
  }

  return {
    overview,
    resolved,
    loading,
    error,
    businessMetrics,
    riskMetrics,
    refresh,
    openRoute,
    metricValue,
    formatDashboardDate,
    formatDashboardMoney,
    dashboardOrderStatusMeta,
    financeHistoryLabel,
    auditActionLabel
  };
}
