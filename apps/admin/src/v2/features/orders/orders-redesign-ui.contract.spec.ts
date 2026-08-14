import { describe, expect, it } from 'vitest';
import view from './V2OrdersView.vue?raw';
import list from './components/V2OrdersList.vue?raw';
import overview from './components/V2OrdersOverview.vue?raw';
import toolbar from './components/V2OrdersToolbar.vue?raw';
import pageState from './useOrdersPage.ts?raw';

describe('orders scheme 3 redesign contract', () => {
  it('uses the order entry visual hierarchy without replacing business modules', () => {
    expect(view).toContain('<V2OrdersOverview :page="page" />');
    expect(view).toContain('<V2OrdersToolbar :page="page" />');
    expect(view).toContain('<V2OrdersList :page="page" />');
    expect(view).toContain('<V2OrderDialogs :page="page" />');
    expect(view).toContain('const page = reactive(useOrdersPage())');
  });

  it('preserves every existing filter binding and action', () => {
    for (const binding of [
      'page.query.keyword',
      'page.query.status',
      'page.query.accountDisposition',
      'page.query.serviceOptionId',
      'page.query.settlementPlatformOptionId',
      'page.openedRange'
    ]) {
      expect(toolbar).toContain(binding);
    }
    expect(toolbar).toContain('@keyup.enter="page.handleSearch"');
    expect(toolbar).toContain('@change="page.handleFilterChange"');
    expect(toolbar).toContain('@click="page.loadOrders"');
    expect(toolbar).toContain('@click="page.resetFilters"');
    expect(toolbar).toContain('page.activeFilterCount');
    expect(toolbar).toContain('title="订单筛选"');
    expect(toolbar).toContain('v2-orders-toolbar__search-row');
    expect(toolbar).toContain('v2-orders-toolbar__filter-row');
    expect(pageState).toContain('function resetFilters()');
  });

  it('labels page-scoped metrics explicitly and keeps the create permission gate', () => {
    expect(overview).toContain('当前页关键状态集中展示');
    expect(overview).toContain('当前页完成订单');
    expect(overview).toContain('v-if="page.canConsumeOrders"');
    expect(overview).toContain('@click="page.openOrderEntry"');
    expect(overview).toContain('item.operations.canConsume || item.operations.canComplete');
  });

  it('keeps table and pagination logic while adding a stable list heading', () => {
    expect(list).toContain('title="订单列表"');
    expect(list).toContain(':schema="v2TableSchemas.orders.main"');
    expect(list).toContain(':current-page="page.displayedPage"');
    expect(list).toContain(':page-size="page.displayedPageSize"');
    expect(list).toContain(':disabled="page.queryPhase === \'transitioning\'"');
    expect(list).toContain('@current-change="page.handlePageChange"');
    expect(list).toContain('@size-change="page.handlePageSizeChange"');
    expect(list).toContain('useV2StableListFrame');
    expect(pageState).toContain('detailRequest.cancel()');
  });
});
