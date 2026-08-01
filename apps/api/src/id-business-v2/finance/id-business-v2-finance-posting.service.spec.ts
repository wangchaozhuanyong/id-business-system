import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
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
      findUniqueOrThrow: vi.fn()
    },
    idBusinessV2FinanceAccount: {
      update: vi.fn()
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
  });

  it('accepts Cloudflare Decimal inputs and persisted account balances', async () => {
    const cloudflareInput = postingInput({
      lines: postingInput().lines.map((line) => ({
        ...line,
        amountOriginal: new CloudflarePrisma.Decimal('100'),
        fxRateToCny: new CloudflarePrisma.Decimal('1'),
        amountCny: new CloudflarePrisma.Decimal('100')
      }))
    });
    tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
      const sql = Array.from(strings).join('');
      if (sql.includes('id_business_v2_finance_periods')) return [];
      return [
        {
          id: financeAccountId,
          status: 'active',
          currentBalance: new CloudflarePrisma.Decimal('20')
        }
      ];
    });

    await expect(service.post(tx as never, cloudflareInput)).resolves.toBeDefined();
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
});
