import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as MysqlPrisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';

const financeAccountId = '22222222-2222-4222-8222-222222222222';

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
        financeAccountId
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

function replayFor(input = postingInput()) {
  return {
    id: 'journal-existing',
    journalType: input.journalType,
    sourceType: input.sourceType,
    sourceId: input.sourceId ?? null,
    sourceReference: input.sourceReference ?? null,
    occurredAt: input.occurredAt,
    summary: input.summary,
    metadata: input.metadata ?? null,
    reversalOfJournalId: input.reversalOfJournalId ?? null,
    lines: input.lines.map((line, index) => ({
      lineNo: index + 1,
      accountCode: line.accountCode,
      direction: line.direction,
      currency: line.currency,
      amountOriginal: line.amountOriginal,
      fxRateToCny: line.fxRateToCny,
      amountCny: line.amountCny,
      financeAccountId: line.financeAccountId ?? null,
      supplierAccountId: line.supplierAccountId ?? null,
      fxRateSnapshotId: line.fxRateSnapshotId ?? null,
      memo: line.memo ?? null
    }))
  };
}

describe('IdBusinessV2FinancePostingService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2FinanceJournal: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      findUniqueOrThrow: vi.fn()
    },
    idBusinessV2FinanceAccount: {
      update: vi.fn()
    },
    idBusinessV2FinanceIncomeReference: {
      findUnique: vi.fn(),
      create: vi.fn()
    }
  };
  const service = new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository());

  beforeEach(() => {
    vi.clearAllMocks();
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_finance_periods')) return [];
      return [{ id: financeAccountId, status: 'active', currentBalance: decimal('20') }];
    });
    tx.idBusinessV2FinanceAccount.update.mockResolvedValue({});
    tx.idBusinessV2FinanceIncomeReference.findUnique.mockResolvedValue(null);
    tx.idBusinessV2FinanceIncomeReference.create.mockResolvedValue({});
    tx.idBusinessV2FinanceJournal.updateMany.mockResolvedValue({ count: 1 });
    tx.idBusinessV2FinanceJournal.create.mockImplementation(async ({ data }) => ({
      id: data.id,
      ...data,
      lines: data.lines.create
    }));
  });

  it('posts a balanced journal and updates the row-locked cash account using strings', async () => {
    const result = await service.post(tx as never, postingInput());

    expect(result.lines).toHaveLength(2);
    expect(tx.idBusinessV2FinanceJournal.create).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2FinanceAccount.update).toHaveBeenCalledWith({
      where: { id: financeAccountId },
      data: {
        currentBalance: { increment: '100' },
        currentBalanceCny: { increment: '100' }
      }
    });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);

    const periodLockSql = Array.from(tx.$queryRaw.mock.calls[0]?.[0] as TemplateStringsArray).join(
      '?'
    );
    const accountLockSql = Array.from(tx.$queryRaw.mock.calls[1]?.[0] as TemplateStringsArray).join(
      '?'
    );
    expect(periodLockSql).toContain('FROM `id_business_v2_finance_periods`');
    expect(accountLockSql).toContain('FROM `id_business_v2_finance_accounts`');
    expect(accountLockSql).not.toContain('::uuid');
    expect(tx.$queryRaw.mock.calls[1]?.[1]).toBe(financeAccountId);
  });

  it('accepts database Decimal inputs and persisted account balances', async () => {
    const databaseInput = postingInput({
      lines: postingInput().lines.map((line) => ({
        ...line,
        amountOriginal: new MysqlPrisma.Decimal('100'),
        fxRateToCny: new MysqlPrisma.Decimal('1'),
        amountCny: new MysqlPrisma.Decimal('100')
      }))
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_finance_periods')) return [];
      return [
        {
          id: financeAccountId,
          status: 'active',
          currentBalance: new MysqlPrisma.Decimal('20')
        }
      ];
    });

    await expect(service.post(tx as never, databaseInput)).resolves.toBeDefined();
    expect(tx.idBusinessV2FinanceAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currentBalance: { increment: '100' } })
      })
    );
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
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns only a replay whose full header and lines match', async () => {
    const input = postingInput();
    const replay = replayFor(input);
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(replay);

    await expect(service.post(tx as never, input)).resolves.toEqual({
      ...replay,
      lines: replay.lines.map((line) => ({
        ...line,
        amountOriginal: line.amountOriginal.toString(),
        fxRateToCny: line.fxRateToCny.toString(),
        amountCny: line.amountCny.toString()
      }))
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2FinanceJournal.create).not.toHaveBeenCalled();
  });

  it('rejects an idempotency replay with different posting content', async () => {
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(
      replayFor({ ...postingInput(), summary: '另一笔订单' })
    );

    await expect(service.post(tx as never, postingInput())).rejects.toBeInstanceOf(
      ConflictException
    );
  });

  it('rejects posting into a row-locked closed Kuala Lumpur period', async () => {
    tx.$queryRaw.mockResolvedValueOnce([{ status: 'closed' }]);

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
          financeAccountId
        }
      ]
    });

    await expect(service.post(tx as never, input)).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2FinanceAccount.update).not.toHaveBeenCalled();
  });

  it('rejects a concurrent second reversal after the first request claimed the journal', async () => {
    const original = {
      ...replayFor(),
      journalNo: 'JV-20260827-001',
      status: 'posted',
      reversedBy: null
    };
    tx.idBusinessV2FinanceJournal.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(original);
    tx.idBusinessV2FinanceJournal.updateMany.mockResolvedValue({ count: 0 });

    await expect(
      service.reverse(tx as never, original.id, '并发更正测试', 'finance-reversal-concurrency-test')
    ).rejects.toThrow('已被其他操作冲销');
    expect(tx.idBusinessV2FinanceJournal.create).not.toHaveBeenCalled();
  });

  it('reserves order and platform references before order revenue is posted', async () => {
    await service.reserveOrderIncomeReferences(tx as never, {
      orderId: '11111111-1111-4111-8111-111111111111',
      references: ['ORDER-001', 'PLATFORM-001', 'order-001']
    });

    expect(tx.idBusinessV2FinanceIncomeReference.create).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2FinanceIncomeReference.create).toHaveBeenCalledWith({
      data: {
        normalizedReference: 'order-001',
        sourceType: 'order',
        orderId: '11111111-1111-4111-8111-111111111111'
      }
    });
  });

  it('rejects order revenue when a manual inflow already reserved the reference', async () => {
    tx.idBusinessV2FinanceIncomeReference.findUnique.mockResolvedValue({
      normalizedReference: 'platform-001',
      sourceType: 'inflow',
      firstInflowId: '22222222-2222-4222-8222-222222222222',
      orderId: null
    });

    await expect(
      service.reserveOrderIncomeReferences(tx as never, {
        orderId: '11111111-1111-4111-8111-111111111111',
        references: ['PLATFORM-001']
      })
    ).rejects.toThrow('不能重复确认收入');
    expect(tx.idBusinessV2FinanceIncomeReference.create).not.toHaveBeenCalled();
  });
});
