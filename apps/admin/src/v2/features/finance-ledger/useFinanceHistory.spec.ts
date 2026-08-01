import { describe, expect, it, vi } from 'vitest';
import { useFinanceHistory } from './useFinanceHistory';

vi.mock('@/v2/services/elementPlusMessage', () => ({
  ElMessage: { error: vi.fn(), success: vi.fn(), warning: vi.fn() }
}));

vi.mock('./api', () => ({ idBusinessV2FinanceApi: {} }));

describe('useFinanceHistory confirmation gate', () => {
  it('requires a current preview, all checklist items, and a meaningful note', () => {
    const history = useFinanceHistory({ refresh: vi.fn() });
    expect(history.historyConfirmationDisabledReason.value).toBe('请先加载历史确认预览');

    history.historyConfirmationPreview.value = {
      generatedAt: '2026-07-30T01:00:00.000Z',
      enabledAt: '2026-07-30T00:00:00.000Z',
      historyStatus: 'incomplete',
      canConfirm: true,
      fingerprint: 'a'.repeat(64),
      financeAccounts: {
        count: 0,
        openingBalanceCny: '0',
        currentBalanceCny: '0'
      },
      supplierWallets: {
        count: 1,
        openingBalanceCny: '1000',
        currentBalanceCny: '18677'
      },
      historicalExpenses: { count: 0, amountCny: '0' }
    };
    expect(history.historyConfirmationDisabledReason.value).toBe('请逐项完成三项历史数据核对');

    history.historyChecklist.financeAccountsConfirmed = true;
    history.historyChecklist.supplierBalancesConfirmed = true;
    history.historyChecklist.historicalExpensesConfirmed = true;
    history.historyNote.value = '111111';
    expect(history.historyConfirmationDisabledReason.value).toBe(
      '请填写至少 6 个字符的实际核对结论'
    );

    history.historyNote.value = '已核对资金、卡商余额和旧开支';
    expect(history.historyConfirmationDisabledReason.value).toBe('');
  });
});
