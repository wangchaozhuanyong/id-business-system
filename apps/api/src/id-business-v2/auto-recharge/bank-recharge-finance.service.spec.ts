import { describe, expect, it, vi } from 'vitest';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';

const id = '11111111-1111-4111-8111-111111111111';
const financeAccountId = '22222222-2222-4222-8222-222222222222';
const operator = { id: '33333333-3333-4333-8333-333333333333' };
const updatedAt = new Date('2026-09-23T10:00:00.000Z');

function fixture() {
  const order = {
    id,
    orderNo: 'BC001',
    status: 'pending_details',
    financeStatus: 'unposted',
    account: { status: 'active' },
    customer: { deletedAt: null, recordStatus: 'active' },
    card: { id: 'card-1', active: true },
    openedAt: new Date('2026-09-23T00:00:00.000Z'),
    dueAt: new Date('2026-10-23T00:00:00.000Z'),
    chargeAmount: '1000',
    chargeCurrencyCode: 'PHP',
    customerFeeAmount: '25',
    bankFeeAmount: '3.5',
    bankFeeCurrencyCode: 'PHP',
    receivedAmount: '200',
    receivedCurrencyCode: 'CNY',
    receivedFinanceAccountId: financeAccountId,
    fundingFinanceAccountId: financeAccountId,
    chargeFxRateToCny: '0.13',
    bankFeeFxRateToCny: null,
    receivedFxRateToCny: null,
    updatedAt
  };
  const tx = {};
  const transactions = { execute: vi.fn((action: (value: unknown) => unknown) => action(tx)) };
  const posting = { post: vi.fn().mockResolvedValue({ id: 'journal-1' }) };
  const audit = { append: vi.fn().mockResolvedValue(undefined) };
  const repository = {
    findOrderForCompletion: vi.fn().mockResolvedValue(order),
    findFinanceAccount: vi.fn().mockResolvedValue({
      id: financeAccountId,
      status: 'active',
      currency: 'CNY'
    }),
    updateOrder: vi.fn().mockResolvedValue({ ...order, status: 'completed' })
  };
  const service = new BankRechargeFinanceService(
    repository as never,
    transactions as never,
    audit as never,
    posting as never
  );
  return { service, order, tx, posting, repository };
}

describe('银充预存资金卡入账', () => {
  it('完成订单时直接从代付资金账户扣除代付金额和银行手续费', async () => {
    const { service, tx, posting } = fixture();
    await service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never);
    expect(posting.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'bank_recharge_completed',
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'cash',
            direction: 'credit',
            financeAccountId
          })
        ])
      })
    );
    const lines = posting.post.mock.calls[0]![1].lines;
    const debits = lines.filter(
      (line: { accountCode: string; direction: string }) =>
        line.accountCode === 'cash' && line.direction === 'credit'
    );
    expect(
      debits.map((line: { amountCny: { toString(): string } }) => line.amountCny.toString())
    ).toEqual(['130', '0.455']);
  });

  it('没有指定预存卡代付资金账户时拒绝完成订单', async () => {
    const { service, order, posting, repository } = fixture();
    repository.findOrderForCompletion.mockResolvedValue({
      ...order,
      fundingFinanceAccountId: null
    });
    await expect(
      service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never)
    ).rejects.toThrow('请为预存资金银行卡选择代付资金账户');
    expect(posting.post).not.toHaveBeenCalled();
  });
});
