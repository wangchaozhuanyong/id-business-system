import { describe, expect, it } from 'vitest';
import view from './V2FinanceLedgerView.vue?raw';
import pageState from './useFinanceLedgerPage.ts?raw';
import expenses from './components/V2FinanceExpensesTable.vue?raw';
import overview from './components/V2FinanceExpensesOverview.vue?raw';
import toolbar from './components/V2FinanceExpensesToolbar.vue?raw';

describe('finance expenses scheme 3 redesign contract', () => {
  it('composes the expense overview, filters, stable list and existing drawers', () => {
    expect(view).toContain('<V2FinanceExpensesOverview :page="page" />');
    expect(view).toContain('<V2FinanceExpensesToolbar :page="page" />');
    expect(view).toContain('<V2FinanceExpensesTable :page="page" />');
    expect(view).toContain('<V2FinanceLedgerDrawers :page="page" />');
    expect(view).toContain('loading-title="正在加载经营开支"');
  });

  it('preserves posting and correction permission boundaries and backend mutations', () => {
    expect(overview).toContain('v-if="page.canPost"');
    expect(expenses).toContain('v-if="page.canAdjust && page.canPost"');
    expect(expenses).toContain(':disabled="row.status === \'reversed\'"');
    expect(pageState).toContain("hasUserPermission(authStore.user, 'finance.post')");
    expect(pageState).toContain("hasUserPermission(authStore.user, 'finance.adjust')");
    expect(pageState).toContain('idBusinessV2FinanceApi.createExpense');
    expect(pageState).toContain('idBusinessV2FinanceApi.correctExpense');
  });

  it('keeps column settings in the list heading and stabilizes page geometry', () => {
    const settingsIndex = expenses.indexOf('<V2TableColumnSettings inline');
    const pageCountIndex = expenses.indexOf('本页 {{ page.expenses.length }} 条');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(pageCountIndex).toBeGreaterThan(settingsIndex);
    expect(expenses).toContain(':show-column-settings="false"');
    expect(expenses).toContain('useV2StableListFrame');
    expect(expenses).toContain('共 {{ page.expenseTotal }} 条');
  });

  it('does not convert business amounts to floating-point values in the redesign layer', () => {
    expect(overview).not.toMatch(/parseFloat|parseInt|Number\s*\(/);
    expect(toolbar).toContain('Decimal 字符串');
    expect(expenses).toContain('formatOriginal(row.amountOriginal, row.currency)');
    expect(expenses).toContain('formatCny(row.amountCny)');
  });
});
