import { describe, expect, it } from 'vitest';
import view from './V2TopupWorkbenchView.vue?raw';
import pageState from './useTopupWorkbenchPage.ts?raw';
import list from './components/V2TopupWorkbenchList.vue?raw';
import overview from './components/V2TopupWorkbenchOverview.vue?raw';
import toolbar from './components/V2TopupWorkbenchToolbar.vue?raw';

describe('topup workbench scheme 3 redesign contract', () => {
  it('composes the overview, filters and stable list around the existing dialogs', () => {
    expect(view).toContain('<V2TopupWorkbenchOverview :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchToolbar :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchList :page="page" />');
    expect(view).toContain('<V2TopupWorkbenchDialogs :page="page" />');
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
    expect(list).toContain('v-if="page.canTopup"');
    expect(list).toContain('@click="page.openCreditDrawer(row)"');
    expect(list).toContain('v-if="page.canAdjustBalance && row.topupRecordCount > 0"');
    expect(list).toContain('@click="page.openReversalDrawer(row)"');
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.balance.topup')");
    expect(pageState).toContain("hasUserPermission(authStore.user, 'apple.balance.adjust')");
  });

  it('keeps column settings in the list heading and pagination frame stable', () => {
    expect(list).toContain('<V2TableColumnSettings inline');
    expect(list).toContain(':show-column-settings="false"');
    expect(list).toContain('useV2StableListFrame');
    expect(list).toContain(':current-page="page.displayedPage"');
    expect(list).toContain(':page-size="page.displayedPageSize"');
    expect(list).toContain(':disabled="page.isParameterTransition"');
    expect(overview).toContain('@click="page.loadWorkbench"');
  });
});
