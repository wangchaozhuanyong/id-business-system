import { describe, expect, it } from 'vitest';
import view from './V2DashboardView.vue?raw';
import pageState from './useDashboardPage.ts?raw';
import activity from './components/V2DashboardActivity.vue?raw';
import assets from './components/V2DashboardAssets.vue?raw';
import metricGrid from './components/V2DashboardMetricGrid.vue?raw';
import overview from './components/V2DashboardOverview.vue?raw';

describe('dashboard scheme 3 redesign contract', () => {
  it('composes the operational overview, risk, business and activity sections', () => {
    expect(view).toContain('<V2DashboardOverview :page="page" />');
    expect(view).toContain('variant="risk"');
    expect(view).toContain('variant="business"');
    expect(view).toContain('<V2DashboardActivity :page="page" />');
    expect(overview).toContain('经营状态总览');
    expect(metricGrid).toContain('v2-dashboard-metric__header');
    expect(assets).toContain('ID 库存与财务基线');
  });

  it('keeps the existing query, permission fallbacks, refresh and route actions', () => {
    expect(view).toContain('const page = reactive(useDashboardPage())');
    expect(pageState).toContain('v2DashboardApi.overview');
    expect(pageState).toContain('keepPreviousData: true');
    expect(pageState).toContain('dashboardQuery.refresh()');
    expect(pageState).toContain('navigateSafely(router, route)');
    expect(activity).toContain("page.overview.access.orders ? '暂无订单' : '无订单查看权限'");
    expect(activity).toContain(
      "page.overview.access.renewals ? '当前无到期待办' : '无续费查看权限'"
    );
    expect(activity).toContain("page.overview.access.audit ? '暂无审计动态' : '无审计日志权限'");
  });

  it('keeps table column settings inline and stabilizes paired activity frames', () => {
    const settingsIndex = activity.indexOf('<V2TableColumnSettings');
    const rowCountIndex = activity.indexOf('当前 {{ page.overview.recentOrders.length }} 条');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(rowCountIndex).toBeGreaterThan(settingsIndex);
    expect(activity).toContain(':show-column-settings="false"');
    expect(activity).toContain('v2-dashboard-panel--orders');
    expect(activity).toContain('v2-dashboard-panel--renewals');
    expect(activity).toContain('height: 361px');
    expect(activity).toContain('height: 341px');
    expect(activity).toContain('v2-dashboard-panel__fixed-body');
    expect(view).toContain("import '@/v2/styles/dashboard.css'");
  });
});
