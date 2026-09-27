import { describe, expect, it, vi } from 'vitest';
import { BankRechargeCorrectionService } from './bank-recharge-correction.service';

const id = '11111111-1111-4111-8111-111111111111';
const operator = { id: '22222222-2222-4222-8222-222222222222' };
const date = new Date('2026-09-27T10:00:00Z');
function fixture() {
  const order = {
    id,
    status: 'completed',
    financeStatus: 'posted',
    updatedAt: date,
    customerId: null
  };
  const repository = {
    findOrder: vi.fn().mockResolvedValue(order),
    listRefundJournals: vi.fn().mockResolvedValue([]),
    findCompletionJournal: vi.fn().mockResolvedValue({ id: 'original' }),
    updateOrder: vi.fn().mockResolvedValue({ ...order, status: 'pending_details' })
  };
  const tx = {};
  const transactions = { execute: vi.fn(async (work: (value: unknown) => unknown) => work(tx)) };
  const audit = { append: vi.fn() };
  const posting = { reverse: vi.fn() };
  const orders = {
    updateInTransaction: vi.fn().mockResolvedValue({ ...order, status: 'pending_details' })
  };
  const finance = {
    completeInTransaction: vi.fn().mockResolvedValue({ ...order, profitAmountCny: '15' })
  };
  const service = new BankRechargeCorrectionService(
    repository as never,
    transactions as never,
    audit as never,
    posting as never,
    orders as never,
    finance as never
  );
  return { service, repository, posting, orders, finance, tx };
}
describe('银充更正事务', () => {
  it('reverses and reposts in the same transaction and preserves a revision-specific journal key', async () => {
    const f = fixture();
    await f.service.correct(
      id,
      { expectedUpdatedAt: date.toISOString(), reason: '修正到期时间' },
      operator as never
    );
    expect(f.posting.reverse.mock.calls[0]?.[0]).toBe(f.tx);
    expect(f.orders.updateInTransaction.mock.calls[0]?.[0]).toBe(f.tx);
    expect(f.finance.completeInTransaction).toHaveBeenCalledWith(
      f.tx,
      id,
      { expectedUpdatedAt: date.toISOString() },
      operator,
      `bank_recharge_completed:${id}:correction:${date.toISOString()}`
    );
  });
  it('rejects stale versions and refunded orders before altering the journal', async () => {
    const f = fixture();
    await expect(
      f.service.correct(
        id,
        { expectedUpdatedAt: new Date(date.getTime() - 1).toISOString(), reason: '更正' },
        operator as never
      )
    ).rejects.toThrow();
    expect(f.posting.reverse).not.toHaveBeenCalled();
    f.repository.listRefundJournals.mockResolvedValue([{ id: 'refund' }] as never);
    await expect(
      f.service.correct(
        id,
        { expectedUpdatedAt: date.toISOString(), reason: '更正' },
        operator as never
      )
    ).rejects.toThrow('已有退款');
    expect(f.posting.reverse).not.toHaveBeenCalled();
  });
  it('propagates validation failure without reposting or reporting a completed correction', async () => {
    const f = fixture();
    f.orders.updateInTransaction.mockRejectedValue(new Error('资料不完整'));
    await expect(
      f.service.correct(
        id,
        { expectedUpdatedAt: date.toISOString(), reason: '更正' },
        operator as never
      )
    ).rejects.toThrow('资料不完整');
    expect(f.finance.completeInTransaction).not.toHaveBeenCalled();
  });
});
