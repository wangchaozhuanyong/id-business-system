import { describe, expect, it } from 'vitest';
import view from './V2FinanceLedgerView.vue?raw';
import pageState from './useFinanceLedgerPage.ts?raw';
import accounts from './components/V2FinanceAccountsList.vue?raw';
import journals from './components/V2FinanceJournalsList.vue?raw';
import navigation from './components/V2FinanceLedgerNavigation.vue?raw';
import overview from './components/V2FinanceLedgerOverview.vue?raw';
import periods from './components/V2FinancePeriodsList.vue?raw';
import wallets from './components/V2FinanceWalletsList.vue?raw';

describe('finance ledger scheme 3 redesign contract', () => {
  it('composes the wallet overview, navigation, filters and dedicated workspaces', () => {
    expect(view).toContain('<V2FinanceLedgerOverview :page="page" />');
    expect(view).toContain('<V2FinanceLedgerNavigation :page="page" />');
    expect(view).toContain('<V2FinanceLedgerToolbar :page="page" />');
    expect(view).toContain('<V2FinanceLedgerWorkspace :page="page" />');
    expect(view).toContain('<V2FinanceLedgerDrawers :page="page" />');
    expect(view).toContain(
      'const page = reactive(useFinanceLedgerPage(props.moduleKey, props.expenseOnly))'
    );
    expect(navigation.match(/class="v2-finance-ledger-navigation__copy"/g)).toHaveLength(1);
  });

  it('preserves the expense-only route, finance query and all permission boundaries', () => {
    expect(view).toContain('<template v-if="page.expenseOnly">');
    expect(view).toContain('<V2FinanceExpensesTable v-else :page="page" />');
    expect(pageState).toContain('idBusinessV2FinanceApi.bootstrapLedger');
    expect(pageState).toContain('keepPreviousData: true');
    for (const permission of [
      'finance.post',
      'finance.adjust',
      'finance.manage',
      'finance.close'
    ]) {
      expect(pageState).toContain(permission);
    }
    expect(accounts).toContain('v-if="page.canManage"');
    expect(wallets).toContain('v-if="page.canPost || page.canAdjust"');
    expect(journals).toContain('v-if="page.canAdjust"');
    expect(periods).toContain('v-if="page.canClose"');
  });

  it('keeps column settings inline and stabilizes every ledger list frame', () => {
    for (const list of [accounts, wallets, journals, periods]) {
      const settingsIndex = list.indexOf('<V2TableColumnSettings inline');
      const rowCountIndex = list.indexOf('本页 {{ page.');
      expect(settingsIndex).toBeGreaterThan(-1);
      expect(rowCountIndex).toBeGreaterThan(settingsIndex);
      expect(list).toContain(':show-column-settings="false"');
      expect(list).toContain('useV2StableListFrame');
    }
  });

  it('keeps business amounts as strings and avoids new floating-point overview aggregation', () => {
    expect(overview).toContain('page.accounts.length');
    expect(overview).toContain('page.wallets.length');
    expect(overview).toContain('page.journalTotal');
    expect(overview).not.toMatch(/parseFloat|parseInt|Number\s*\(/);
    expect(accounts).toContain('formatOriginal(row.currentBalance, row.currency)');
    expect(wallets).toContain('formatOriginal(row.currentBalance, row.currency)');
    expect(journals).toContain('formatOriginal(line.amountOriginal, line.currency)');
  });
});
