import { describe, expect, it } from 'vitest';
import view from './V2TopupWorkbenchView.vue?raw';
import pageState from './useTopupWorkbenchPage.ts?raw';
import list from './components/V2TopupWorkbenchList.vue?raw';
import availableTable from './components/V2TopupAvailableTable.vue?raw';
import creditAction from './components/V2TopupCreditAction.vue?raw';
import overview from './components/V2TopupWorkbenchOverview.vue?raw';
import soldTable from './components/V2TopupSoldTable.vue?raw';
import toolbar from './components/V2TopupWorkbenchToolbar.vue?raw';

describe('topup workbench scheme 3 redesign contract', () => {
  it('composes the overview, filters and stable list around the existing dialogs', () => {
    expect(view).toContain('<V2TopupWorkbenchOverview :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchToolbar :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchList :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchDialogs :page="page" />');
    expect(list).toContain('label="未售出 ID"');
    expect(list).toContain('label="已售出 ID"');
    expect(availableTable).toContain(':schema="v2TableSchemas.topups.available"');
    expect(soldTable).toContain(':schema="v2TableSchemas.topups.sold"');
    expect(soldTable).toContain('销售订单');
    expect(soldTable).toContain('归属客户');
  });

  it('keeps all existing filters and query handlers', () => {
    for (const binding of [
      'page.query.countryOptionId',
      'page.query.balancePreset',
      'page.query.balanceMin',
      'page.query.balanceMax',
      'page.query.onlyNormal'
    ]) {
      expect(toolbar).toContain(binding);
    }
    expect(toolbar).toContain('@change="page.handleBalancePresetChange"');
    expect(toolbar).toContain('@change="page.handleFilterChange"');
    expect(toolbar).toContain('@click="page.handleSearch"');
    expect(toolbar).toContain('@click="page.resetFilters"');
  });

  it('keeps topup and reversal permission gates and business actions', () => {
    expect(creditAction).toContain('v-if="page.canTopup"');
    expect(creditAction).toContain('@click="page.openCreditDrawer(item)"');
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.balance.topup')");
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.balance.adjust')");
    expect(pageState).toContain("account.saleState === 'sold'");
    expect(pageState).toContain('confirmedSoldByOrderId');
  });

  it('keeps both list switches and column settings in one header row', () => {
    expect(list).toContain('<V2TableColumnSettings');
    expect(list).toContain('class="v2-topup-list__tools"');
    expect(list).not.toContain('<V2SectionHeading');
    expect(availableTable).toContain(':show-column-settings="false"');
    expect(soldTable).toContain(':show-column-settings="false"');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain(':current-page="page.displayedPage"');
    expect(list).toContain(':page-size="page.displayedPageSize"');
    expect(list).toContain(':disabled="page.queryPhase === \'transitioning\'"');
    expect(overview).toContain('@click="page.loadWorkbench"');
  });
});
