import { describe, expect, it } from 'vitest';
import financeApi from '@/v2/api/finance.ts?raw';
import view from './V2FinanceLedgerView.vue?raw';
import pageState from './useFinanceLedgerPage.ts?raw';
import inflowState from './useFinanceLedgerInflows.ts?raw';
import inflowDrawer from './components/V2FinanceInflowDrawer.vue?raw';
import expenses from './components/V2FinanceExpensesTable.vue?raw';
import inflows from './components/V2FinanceInflowsTable.vue?raw';
import overview from './components/V2FinanceExpensesOverview.vue?raw';
import toolbar from './components/V2FinanceExpensesToolbar.vue?raw';

describe('finance expenses scheme 3 redesign contract', () => {
  it('composes the income and expense overview, switch, filters, stable lists and drawers', () => {
    expect(view).toContain('<V2FinanceExpensesOverview :page="page" />');
    expect(view).toContain('<V2FinanceCashbookNavigation :page="page" />');
    expect(view).toContain('<V2FinanceExpensesToolbar :page="page" />');
    expect(view).toContain('<V2FinanceInflowsTable v-if="page.cashbookView === \'inflows\'"');
    expect(view).toContain('<V2FinanceExpensesTable v-else :page="page" />');
    expect(view).toContain('<V2FinanceLedgerDrawers :page="page" />');
    expect(view).toContain('loading-title="正在加载收支记录"');
  });

  it('preserves posting and correction permission boundaries and backend mutations', () => {
    expect(overview).toContain('v-if="page.canPost"');
    expect(expenses).toContain('v-if="page.canAdjust && page.canPost"');
    expect(expenses).toContain(':disabled="row.status === \'reversed\'"');
    expect(pageState).toContain("hasUserPermission(authStore.user, 'finance.post')");
    expect(pageState).toContain("hasUserPermission(authStore.user, 'finance.adjust')");
    expect(pageState).toContain('idBusinessV2FinanceApi.createExpense');
    expect(pageState).toContain('idBusinessV2FinanceApi.correctExpense');
    expect(inflowState).toContain('idBusinessV2FinanceApi.createInflow');
    expect(inflowState).toContain('idBusinessV2FinanceApi.correctInflow');
    expect(inflows).toContain('v-if="page.canAdjust && page.canPost"');
  });

  it('requires immutable income evidence, protects dirty close, and exposes audited receipt viewing', () => {
    expect(inflowDrawer).toContain('label="收款流水号" required');
    expect(inflowDrawer).toContain('label="收款凭证" required');
    expect(inflowDrawer).toContain('type="file"');
    expect(inflowDrawer).toContain(':dirty="page.inflowDirty"');
    expect(inflowState).toContain("return showWarning('请上传收款凭证')");
    expect(inflowState).toContain('inflowSnapshot() !== inflowInitialSnapshot.value');
    expect(inflowState).toContain('idBusinessV2FinanceApi.downloadInflowReceipt');
    expect(financeApi).toContain("formData.append('receipt', receipt, receipt.name)");
    expect(financeApi).toContain("responseType: 'blob'");
    expect(inflows).toContain('查看凭证');
  });

  it('keeps column settings in the list heading and stabilizes page geometry', () => {
    const settingsIndex = expenses.indexOf('<V2TableColumnSettings inline');
    const pageCountIndex = expenses.indexOf('本页 {{ page.expenses.length }} 条');
    expect(settingsIndex).toBeGreaterThan(-1);
    expect(pageCountIndex).toBeGreaterThan(settingsIndex);
    expect(expenses).toContain(':show-column-settings="false"');
    expect(expenses).toContain('useV2StableListFrame');
    expect(expenses).toContain('共 {{ page.expenseTotal }} 条');
    expect(inflows).toContain('useV2StableListFrame');
    expect(inflows).toContain('共 {{ page.inflowTotal }} 条');
  });

  it('does not convert business amounts to floating-point values in the redesign layer', () => {
    expect(overview).not.toMatch(/parseFloat|parseInt|Number\s*\(/);
    expect(toolbar).toContain('Decimal 字符串');
    expect(expenses).toContain('formatOriginal(row.amountOriginal, row.currency)');
    expect(expenses).toContain('formatCny(row.amountCny)');
    expect(inflows).toContain('formatOriginal(row.amountOriginal, row.currency)');
    expect(inflows).toContain('formatCny(row.amountCny)');
  });
});
