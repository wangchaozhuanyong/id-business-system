import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinanceExpensesService } from './id-business-v2-finance-expenses.service';

const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['finance.view', 'finance.post', 'finance.adjust']
};
const expenseId = '10000000-0000-4000-8000-000000000001';
const categoryId = '10000000-0000-4000-8000-000000000002';
const accountId = '10000000-0000-4000-8000-000000000003';
const journalId = '10000000-0000-4000-8000-000000000004';

function expenseRow(status: 'posted' | 'reversed' = 'posted') {
  return {
    id: expenseId,
    journalId,
    categoryOptionId: categoryId,
    financeAccountId: accountId,
    currency: 'CNY',
    amountOriginal: '20',
    fxRateToCny: '1',
    amountCny: '20',
    occurredAt: new Date('2026-08-07T08:00:00.000Z'),
    payee: '测试收款方',
    receiptAttachmentId: null,
    remark: '原备注',
    createdAt: new Date('2026-08-07T08:00:00.000Z'),
    categoryOption: { name: '办公开支' },
    financeAccount: { name: '人民币账户' },
    journal: { status }
  };
}

describe('IdBusinessV2FinanceExpensesService', () => {
  const tx = {};
  const commandTransactions = {
    execute: vi.fn(async (work: (transaction: typeof tx) => Promise<unknown>) => work(tx))
  };
  const commandRepository = {
    findExpenseReplay: vi.fn(),
    findExpenseForCorrection: vi.fn(),
    createExpense: vi.fn()
  };
  const queryRepository = {
    findExpensePrerequisites: vi.fn()
  };
  const audit = { append: vi.fn() };
  const fxService = { resolve: vi.fn() };
  const postingService = { reverse: vi.fn(), post: vi.fn() };
  const service = new IdBusinessV2FinanceExpensesService(
    commandTransactions as never,
    commandRepository as never,
    queryRepository as never,
    audit as never,
    fxService as never,
    postingService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    queryRepository.findExpensePrerequisites.mockResolvedValue({
      category: { id: categoryId, name: '工资' },
      account: { id: accountId, name: '人民币账户', currency: 'CNY', status: 'active' }
    });
    fxService.resolve.mockResolvedValue({ id: null, rateToCny: '1' });
    commandRepository.findExpenseReplay.mockResolvedValue(null);
    commandRepository.findExpenseForCorrection.mockResolvedValue(expenseRow());
    postingService.reverse.mockResolvedValue({
      id: '10000000-0000-4000-8000-000000000005'
    });
    postingService.post.mockResolvedValue({ id: '10000000-0000-4000-8000-000000000006' });
    commandRepository.createExpense.mockImplementation(
      async (_transaction: unknown, input: Record<string, unknown>) => ({
        ...expenseRow(),
        ...input,
        categoryOption: { name: '工资' },
        financeAccount: { name: '人民币账户' },
        journal: { status: 'posted' }
      })
    );
  });

  it('atomically reverses the original journal and posts a corrected expense', async () => {
    const result = await service.correct(
      expenseId,
      {
        categoryOptionId: categoryId,
        financeAccountId: accountId,
        amount: '30',
        currency: 'CNY',
        occurredAt: '2026-08-07T09:00:00.000Z',
        payee: '正确收款方',
        remark: '正确备注',
        reason: '原金额填写错误',
        idempotencyKey: 'expense-correction-test'
      },
      operator
    );

    expect(postingService.reverse).toHaveBeenCalledWith(
      tx,
      journalId,
      '原金额填写错误',
      'finance_expense_correction:expense-correction-test:reversal',
      operator
    );
    expect(postingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'expense',
        sourceType: 'expense',
        metadata: expect.objectContaining({ correctedExpenseId: expenseId })
      })
    );
    expect(commandRepository.createExpense).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        amountOriginal: '30',
        idempotencyKey: 'finance_expense_correction:expense-correction-test:replacement'
      })
    );
    expect(audit.append).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ action: 'id_business_v2.finance_expense.correct' })
    );
    expect(result.status).toBe('posted');
  });

  it('does not correct an expense whose journal is already reversed', async () => {
    commandRepository.findExpenseForCorrection.mockResolvedValue(expenseRow('reversed'));

    await expect(
      service.correct(
        expenseId,
        {
          categoryOptionId: categoryId,
          financeAccountId: accountId,
          amount: '30',
          currency: 'CNY',
          occurredAt: '2026-08-07T09:00:00.000Z',
          reason: '重复更正测试',
          idempotencyKey: 'expense-correction-reversed-test'
        },
        operator
      )
    ).rejects.toThrow('该经营开支已冲销');
    expect(postingService.reverse).not.toHaveBeenCalled();
  });
});
