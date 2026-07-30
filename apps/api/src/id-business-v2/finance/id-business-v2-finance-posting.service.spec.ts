import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function postingInput(
  overrides: Partial<Parameters<IdBusinessV2FinancePostingService['post']>[1]> = {}
) {
  return {
    journalType: 'order_completed' as const,
    sourceType: 'order' as const,
    sourceId: '11111111-1111-4111-8111-111111111111',
    sourceReference: 'V220260729001',
    occurredAt: new Date('2026-07-29T12:00:00.000Z'),
    summary: '订单完成',
    idempotencyKey: 'auto:order_completed:test',
    lines: [
      {
        accountCode: 'cash' as const,
        direction: 'debit' as const,
        currency: 'CNY' as const,
        amountOriginal: decimal('100'),
        fxRateToCny: decimal('1'),
        amountCny: decimal('100'),
        financeAccountId: '22222222-2222-4222-8222-222222222222'
      },
      {
        accountCode: 'sales_revenue' as const,
        direction: 'credit' as const,
        currency: 'CNY' as const,
        amountOriginal: decimal('100'),
        fxRateToCny: decimal('1'),
        amountCny: decimal('100')
      }
    ],
    ...overrides
  };
}

describe('IdBusinessV2FinancePostingService', () => {
  const tx = {
    idBusinessV2FinanceJournal: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      findUniqueOrThrow: vi.fn()
    },
    idBusinessV2FinancePeriod: {
      findUnique: vi.fn()
    },
    idBusinessV2FinanceAccount: {
      findUnique: vi.fn(),
      update: vi.fn()
    }
  };
  const service = new IdBusinessV2FinancePostingService();

  beforeEach(() => {
    vi.clearAllMocks();
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(null);
    tx.idBusinessV2FinancePeriod.findUnique.mockResolvedValue(null);
    tx.idBusinessV2FinanceAccount.findUnique.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      status: 'active',
      currentBalance: decimal('20')
    });
    tx.idBusinessV2FinanceAccount.update.mockResolvedValue({});
    tx.idBusinessV2FinanceJournal.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      ...data,
      lines: data.lines.create
    }));
  });

  it('posts a balanced journal and updates the linked cash account in the same client', async () => {
    const result = await service.post(tx as never, postingInput());

    expect(result.lines).toHaveLength(2);
    expect(tx.idBusinessV2FinanceJournal.create).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2FinanceAccount.update).toHaveBeenCalledWith({
      where: { id: '22222222-2222-4222-8222-222222222222' },
      data: {
        currentBalance: { increment: decimal('100') },
        currentBalanceCny: { increment: decimal('100') }
      }
    });
  });

  it('rejects an unbalanced journal before any database write', async () => {
    const input = postingInput({
      lines: [
        postingInput().lines[0],
        { ...postingInput().lines[1], amountOriginal: '99', amountCny: '99' }
      ]
    });

    await expect(service.post(tx as never, input)).rejects.toBeInstanceOf(BadRequestException);
    expect(tx.idBusinessV2FinanceJournal.create).not.toHaveBeenCalled();
  });

  it('does not duplicate a journal on idempotent replay', async () => {
    const replay = { id: 'journal-existing', lines: [] };
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(replay);

    await expect(service.post(tx as never, postingInput())).resolves.toBe(replay);
    expect(tx.idBusinessV2FinancePeriod.findUnique).not.toHaveBeenCalled();
    expect(tx.idBusinessV2FinanceJournal.create).not.toHaveBeenCalled();
  });

  it('rejects posting into a closed Kuala Lumpur period', async () => {
    tx.idBusinessV2FinancePeriod.findUnique.mockResolvedValue({ status: 'closed' });

    await expect(service.post(tx as never, postingInput())).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2FinanceJournal.create).not.toHaveBeenCalled();
  });

  it('rejects a cash payment that would make the linked account negative', async () => {
    const input = postingInput({
      journalType: 'expense',
      sourceType: 'expense',
      lines: [
        {
          accountCode: 'operating_expense',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: '30',
          fxRateToCny: '1',
          amountCny: '30'
        },
        {
          accountCode: 'cash',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: '30',
          fxRateToCny: '1',
          amountCny: '30',
          financeAccountId: '22222222-2222-4222-8222-222222222222'
        }
      ]
    });

    await expect(service.post(tx as never, input)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2FinanceAccount.update).not.toHaveBeenCalled();
  });
});
