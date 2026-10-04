import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { describe, expect, it, vi } from 'vitest';
import { Amount4 } from '../runtime/public-api';
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
  const posting = { post: vi.fn(async (_tx, input) => ({ id: 'journal-1', lines: input.lines })) };
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
    posting as never,
    new BankRechargeFeesService({} as never, {} as never)
  );
  return { service, order, tx, posting, repository, audit, transactions };
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

  it('人民币代付 100、实收 150 使用固定汇率 1，成本100、利润50', async () => {
    const { service, order, repository, posting } = fixture();
    Object.assign(order, {
      chargeAmount: '100',
      chargeCurrencyCode: 'CNY',
      chargeFxRateToCny: '1',
      receivedAmount: '150',
      customerFeeAmount: '0',
      bankFeeAmount: '0'
    });
    await service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never);
    expect(repository.updateOrder.mock.calls[0]![1].data.profitAmountCny).toBe('50');
    expect(
      posting.post.mock.calls[0]![1].lines.find(
        (line: { accountCode: string }) => line.accountCode === 'bank_recharge_cost'
      ).amountCny.toString()
    ).toBe('100');
  });

  it.each(['charge', 'bankFee'])('已有非1人民币 %s 汇率拒绝完成且不产生凭证', async (kind) => {
    const { service, order, posting, repository } = fixture();
    Object.assign(
      order,
      kind === 'charge'
        ? { chargeCurrencyCode: 'CNY', chargeFxRateToCny: '2' }
        : { bankFeeCurrencyCode: 'CNY', bankFeeFxRateToCny: '2' }
    );
    await expect(
      service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never)
    ).rejects.toThrow('人民币时必须为 1');
    expect(posting.post).not.toHaveBeenCalled();
    expect(repository.updateOrder).not.toHaveBeenCalled();
  });

  it('自动单选中与原官网身份不同的账号拒绝完成', async () => {
    const { service, order, posting, repository } = fixture();
    repository.findOrderForCompletion.mockResolvedValue({
      ...order,
      source: 'automatic',
      rechargeJobId: 'source',
      account: { status: 'active', officialAccountKey: 'wrong' }
    } as never);
    Object.assign(repository, {
      findRechargeJob: vi.fn().mockResolvedValue({ accountKey: 'original' })
    });
    await expect(
      service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never)
    ).rejects.toThrow('原官网付款身份不一致');
    expect(posting.post).not.toHaveBeenCalled();
  });

  it('完成利润采用已过账手续费历史现金成本带来的汇兑损失', async () => {
    const f = fixture();
    Object.assign(f.order, {
      chargeAmount: '100',
      chargeCurrencyCode: 'CNY',
      chargeFxRateToCny: '1',
      receivedAmount: '150',
      accountingVersion: 'subscription_cost_v2',
      customerFeeAmount: '0',
      bankFeeAmount: '0'
    });
    const feeLines = [
      {
        accountCode: 'bank_recharge_usdt_fee',
        direction: 'debit',
        currency: 'USDT',
        amountOriginal: '2',
        fxRateToCny: '10',
        amountCny: '20'
      },
      {
        accountCode: 'cash',
        direction: 'credit',
        currency: 'USDT',
        amountOriginal: '2',
        fxRateToCny: '10',
        amountCny: '20',
        financeAccountId: 'usdt-source'
      }
    ];
    f.posting.post.mockImplementation(async (_tx, input) => ({
      id: 'posted',
      lines: [
        ...input.lines.map((line: { accountCode: string; currency: string; amountCny: unknown }) =>
          line.accountCode === 'cash' && line.currency === 'USDT'
            ? { ...line, amountCny: Amount4.from('30') }
            : line
        ),
        {
          accountCode: 'realized_fx_gain_loss',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: '10',
          fxRateToCny: '1',
          amountCny: Amount4.from('10')
        }
      ]
    }));
    const service = new BankRechargeFinanceService(
      f.repository as never,
      f.transactions as never,
      f.audit as never,
      f.posting as never,
      {
        postingLines: vi.fn().mockResolvedValue({ lines: feeLines, total: Amount4.from('20') })
      } as never
    );
    await service.complete(id, { expectedUpdatedAt: updatedAt.toISOString() }, operator as never);
    expect(f.repository.updateOrder.mock.calls[0]![1].data.profitAmountCny).toBe('20');
    expect(f.audit.append.mock.calls[0]![1].afterData.profitCny).toBe('20');
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

describe('银充实际退款入账', () => {
  it('外币客户退款的历史现金汇兑差计入累计真实利润', async () => {
    const f = fixture();
    const originalLines = [
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: 'USD',
        amountOriginal: '10',
        amountCny: '80',
        fxRateToCny: '8',
        financeAccountId: 'receipt'
      },
      {
        accountCode: 'bank_recharge_revenue',
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: '80',
        amountCny: '80',
        fxRateToCny: '1'
      },
      {
        accountCode: 'bank_recharge_cost',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: '100',
        amountCny: '100',
        fxRateToCny: '1'
      },
      {
        accountCode: 'cash',
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: '100',
        amountCny: '100',
        fxRateToCny: '1',
        financeAccountId: 'funding'
      }
    ];
    const repository = {
      ...f.repository,
      findOrder: vi.fn().mockResolvedValue({
        ...f.order,
        status: 'completed',
        financeStatus: 'posted',
        profitAmountCny: '-20'
      }),
      findCompletionJournal: vi.fn().mockResolvedValue({ id: 'original', lines: originalLines }),
      listRefundJournals: vi.fn().mockResolvedValue([])
    };
    f.posting.post.mockImplementation(async (_tx, input) => ({
      id: 'refund',
      lines: [
        ...input.lines.map((line: { accountCode: string }) =>
          line.accountCode === 'cash' ? { ...line, amountCny: Amount4.from('90') } : line
        ),
        {
          accountCode: 'realized_fx_gain_loss',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: '10',
          fxRateToCny: '1',
          amountCny: Amount4.from('10')
        }
      ]
    }));
    const service = new BankRechargeFinanceService(
      repository as never,
      f.transactions as never,
      f.audit as never,
      f.posting as never,
      {} as never
    );
    await service.refund(
      id,
      {
        expectedUpdatedAt: updatedAt.toISOString(),
        reason: '合成外币退款',
        refundReference: 'synthetic-usd-refund'
      },
      operator as never
    );
    expect(repository.updateOrder.mock.calls[0]![1].data.profitAmountCny).toBe('-110');
  });

  it('only posts customer refunds, preserves the loss, and requires evidence for upstream recovery', async () => {
    const f = fixture();
    const lines = [
      {
        accountCode: 'cash',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: '120',
        amountCny: '120',
        fxRateToCny: '1',
        financeAccountId: 'received'
      },
      {
        accountCode: 'bank_recharge_revenue',
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: '120',
        amountCny: '120',
        fxRateToCny: '1'
      },
      {
        accountCode: 'bank_recharge_cost',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: '100',
        amountCny: '100',
        fxRateToCny: '1'
      },
      {
        accountCode: 'cash',
        direction: 'credit',
        currency: 'CNY',
        amountOriginal: '100',
        amountCny: '100',
        fxRateToCny: '1',
        financeAccountId: 'funding'
      },
      {
        accountCode: 'bank_recharge_bank_fee',
        direction: 'debit',
        currency: 'CNY',
        amountOriginal: '2',
        amountCny: '2',
        fxRateToCny: '1'
      }
    ];
    const repository = {
      ...f.repository,
      findOrder: vi.fn().mockResolvedValue({
        ...f.order,
        status: 'completed',
        financeStatus: 'posted',
        profitAmountCny: '18'
      }),
      findCompletionJournal: vi.fn().mockResolvedValue({ id: 'original', lines }),
      listRefundJournals: vi.fn().mockResolvedValue([])
    };
    const service = new BankRechargeFinanceService(
      repository as never,
      f.transactions as never,
      f.audit as never,
      f.posting as never,
      new BankRechargeFeesService({} as never, {} as never)
    );
    const input = {
      expectedUpdatedAt: updatedAt.toISOString(),
      reason: '客户退款',
      refundReference: 'receipt-1'
    };
    await service.refund(id, input, operator as never);
    expect(repository.updateOrder).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        data: expect.objectContaining({ status: 'refunded', profitAmountCny: '-102' })
      })
    );
    expect(
      f.posting.post.mock.calls[0]![1].lines.every(
        (line: { financeAccountId?: string }) => line.financeAccountId !== 'funding'
      )
    ).toBe(true);
    f.posting.post.mockClear();
    await expect(
      service.refund(id, { ...input, chargeRecoveryAmountCny: '100' }, operator as never)
    ).rejects.toThrow('上游回款凭据');
    expect(f.posting.post).not.toHaveBeenCalled();
  });
});
