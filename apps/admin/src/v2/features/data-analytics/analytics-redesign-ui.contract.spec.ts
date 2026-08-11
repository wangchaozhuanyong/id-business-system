import { describe, expect, it } from 'vitest';
import view from './V2DataAnalyticsView.vue?raw';
import pageState from './useDataAnalyticsPage.ts?raw';
import overview from './components/V2AnalyticsOverview.vue?raw';
import toolbar from './components/V2AnalyticsToolbar.vue?raw';
import navigation from './components/V2AnalyticsNavigation.vue?raw';
import currencyReport from './components/V2AnalyticsCurrencyReport.vue?raw';
import assetsReport from './components/V2AnalyticsAssetsReport.vue?raw';
import reconciliationReport from './components/V2AnalyticsReconciliationReport.vue?raw';
import settlementReport from './components/V2SettlementPlatformReport.vue?raw';

describe('data analytics scheme 3 redesign contract', () => {
  it('composes the overview, filters and four existing analysis sections', () => {
    expect(view).toContain('<V2AnalyticsOverview :page="page" />');
    expect(view).toContain('<V2AnalyticsToolbar :page="page" />');
    expect(view).toContain('v-model:active-section="activeAnalysisSection"');
    expect(view).toContain('<V2ProfitOverview');
    expect(view).toContain('<V2AnalyticsCurrencyReport');
    expect(view).toContain('<V2AnalyticsAssetsReport');
    expect(view).toContain('<V2AnalyticsReconciliationReport');
    expect(navigation).toContain("'profit' | 'cash-flow' | 'assets' | 'reconciliation'");
  });

  it('preserves the current report APIs, async loading standard and all filter dimensions', () => {
    expect(view).toContain('<V2AsyncRegion');
    expect(view).toContain('loading-title="正在核算经营数据"');
    expect(pageState).toContain('idBusinessV2FinanceApi.overview');
    expect(pageState).toContain('idBusinessV2FinanceApi.listAccounts');
    expect(pageState).toContain('idBusinessV2FinanceApi.listSupplierWallets');
    expect(pageState).toContain('idBusinessV2FinanceApi.listJournals');
    expect(toolbar).toContain('page.filters.dateRange');
    expect(toolbar).toContain('page.filters.currency');
    expect(toolbar).toContain('page.filters.supplierOptionId');
    expect(toolbar).toContain('page.filters.journalType');
    expect(toolbar).toContain('page.filters.financeAccountId');
    expect(toolbar).toContain('page.filters.settlementPlatformOptionId');
  });

  it('keeps column settings in each report heading and stabilizes report geometry', () => {
    for (const report of [currencyReport, assetsReport, reconciliationReport, settlementReport]) {
      const settingsIndex = report.indexOf('<V2TableColumnSettings');
      const pageCountIndex = report.indexOf('本页 {{');
      expect(settingsIndex).toBeGreaterThan(-1);
      expect(pageCountIndex).toBeGreaterThan(settingsIndex);
      expect(report).toContain(':show-column-settings="false"');
      expect(report).toContain('useV2StableListFrame');
    }
  });

  it('keeps Decimal strings and does not invent frontend financial aggregation', () => {
    for (const source of [view, overview, toolbar, currencyReport, assetsReport]) {
      expect(source).not.toMatch(/parseFloat|parseInt|Number\s*\(/);
    }
    expect(pageState).toContain('addDecimalStrings');
    expect(pageState).toContain('formatV2Decimal');
    expect(toolbar).toContain('Decimal 字符串');
    expect(currencyReport).toContain('formatOriginal(row.netCashFlow, row.currency)');
    expect(assetsReport).toContain('formatCny(overview.assets.totalBookValueCny)');
  });
});
