import { describe, expect, it } from 'vitest';
import view from './V2TopupRecordsView.vue?raw';
import overview from './components/V2TopupRecordsOverview.vue?raw';
import mobileList from './components/V2GiftCardMobileList.vue?raw';
import tables from './components/V2TopupRecordsTables.vue?raw';
import pageState from './useTopupRecordsPage.ts?raw';

describe('top-up records scheme 3 redesign contract', () => {
  it('uses the shared overview, command panel and list hierarchy', () => {
    expect(view).toContain('<V2TopupRecordsOverview');
    expect(view).toContain('class="v2-topup-records-command-panel"');
    expect(view).toContain("'记录分类与筛选'");
    expect(tables).toContain('class="v2-topup-records-list__header"');
    expect(tables).toContain("'余额流水列表'");
  });

  it('keeps all existing record tabs, filters and actions', () => {
    for (const tab of ['giftCards', 'ledger', 'suppliers', 'payments']) {
      expect(view).toContain(`name="${tab}"`);
    }
    for (const binding of [
      'filters.keyword',
      'giftCardQuery.status',
      'ledgerQuery.entryType',
      'filters.cardNameOptionId',
      'filters.countryOptionId',
      'filters.supplierOptionId',
      'filters.dateRange'
    ]) {
      expect(view).toContain(binding);
    }
    expect(view).toContain('@keyup.enter="handleSearch"');
    expect(view).toContain('@change="handleFilterChange"');
    expect(view).toContain('@refresh="loadActiveTab"');
    expect(view).toContain('@click="resetFilters"');
  });

  it('uses page-scoped counters without introducing money arithmetic', () => {
    expect(overview).toContain('筛选结果');
    expect(overview).toContain('当前页');
    expect(overview).toContain("item.direction === 'credit'");
    expect(overview).toContain("item.direction === 'debit'");
    expect(overview).not.toContain('Number(');
    expect(overview).not.toContain('parseFloat(');
  });

  it('keeps tables, pagination and stable page geometry', () => {
    expect(tables).toContain(':schema="v2TableSchemas.topupRecords.giftCards"');
    expect(tables).toContain(':schema="v2TableSchemas.topupRecords.balanceLedger"');
    expect(tables).toContain(':current-page="giftCardPage"');
    expect(tables).toContain(':current-page="ledgerPage"');
    expect(tables).not.toContain('v-model:current-page');
    expect(tables).toContain(':disabled="queryPhase === \'transitioning\'"');
    expect(pageState).toContain('giftCardDisplayedPage.value = snapshot.list.page');
    expect(pageState).toContain('trackRouteData: () =>');
    expect(tables).toContain('useV2StableListFrame');
  });

  it('shows the same explicit action block reason on desktop and mobile', () => {
    expect(tables).toContain('actionState(row).blockedReason');
    expect(mobileList).toContain('actionState(item).blockedReason');
    expect(tables).not.toContain('<span v-else>—</span>');
  });
});
