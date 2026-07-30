import { Prisma } from '@prisma/client';
import { ConflictException as NestConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2AccountLossesService } from './id-business-v2-account-losses.service';

const accountId = '10000000-0000-4000-8000-000000000001';
const operator = {
  id: '20000000-0000-4000-8000-000000000001',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: []
};
const reportedAt = new Date('2026-07-29T12:00:00.000Z');

function makeLockedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    appleIdMasked: 'us***@example.com',
    countryOptionId: '30000000-0000-4000-8000-000000000001',
    countryName: '美国',
    currencyCode: 'USD',
    supplierOptionId: '40000000-0000-4000-8000-000000000001',
    supplierName: '供应商 A',
    purchaseCost: new Prisma.Decimal(0),
    currentBalance: new Prisma.Decimal('20'),
    balanceCostAmount: new Prisma.Decimal('70'),
    soldByOrderId: null,
    soldOrderNo: null,
    lossReportedAt: null,
    ...overrides
  };
}

function makeLossRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: '50000000-0000-4000-8000-000000000001',
    accountId,
    ledgerEntryId: '60000000-0000-4000-8000-000000000001',
    appleIdMasked: 'us***@example.com',
    countryOptionId: '30000000-0000-4000-8000-000000000001',
    countryName: '美国',
    currencyCode: 'USD',
    supplierOptionId: '40000000-0000-4000-8000-000000000001',
    supplierName: '供应商 A',
    saleState: 'available' as const,
    soldOrderId: null,
    soldOrderNo: null,
    lossBalance: new Prisma.Decimal('20'),
    lossCostAmount: new Prisma.Decimal('70'),
    idPurchaseCostLossAmount: new Prisma.Decimal('0'),
    reason: 'ID 已死亡无法登录',
    idempotencyKey: `account_loss:${accountId}:loss-request-0001`,
    reportedByUserId: operator.id,
    reportedByName: operator.displayName,
    reportedAt,
    reportedBy: {
      id: operator.id,
      username: operator.username,
      displayName: operator.displayName
    },
    ...overrides
  };
}

describe('IdBusinessV2AccountLossesService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2AccountLoss: {
      findUnique: vi.fn(),
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2AccountLock: {
      count: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      create: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    idBusinessV2Activation: {
      updateMany: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn()
  };
  const financePostingService = {
    post: vi.fn()
  };
  const service = new IdBusinessV2AccountLossesService(
    prisma as never,
    new IdBusinessV2BalanceCalculatorService(),
    financePostingService as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(
      async (input: Array<Promise<unknown>> | ((client: typeof tx) => Promise<unknown>)) =>
        typeof input === 'function' ? input(tx) : Promise.all(input)
    );
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([makeLockedAccount()]);
    tx.idBusinessV2AccountLock.count.mockResolvedValue(0);
    tx.idBusinessV2Option.findFirst.mockResolvedValue({
      id: '70000000-0000-4000-8000-000000000001'
    });
    tx.idBusinessV2BalanceLedger.create.mockResolvedValue({
      id: '60000000-0000-4000-8000-000000000001'
    });
    tx.idBusinessV2AccountLoss.create.mockResolvedValue(makeLossRecord());
    tx.idBusinessV2Account.update.mockResolvedValue({});
    tx.idBusinessV2Activation.updateMany.mockResolvedValue({ count: 1 });
    tx.auditLog.create.mockResolvedValue({});
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
  });

  it('atomically freezes the ID, clears balance, writes loss ledger and marks activations abnormal', async () => {
    const result = await service.reportLoss(
      accountId,
      {
        reason: 'ID 已死亡无法登录',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-request-0001'
      },
      operator
    );

    expect(result.lossRecord.lossBalance).toBe('20');
    expect(result.lossRecord.lossCostAmount).toBe('70');
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entryType: 'account_loss',
          direction: 'debit',
          balanceBefore: expect.objectContaining({ toString: expect.any(Function) }),
          balanceAfter: '0',
          costBefore: expect.objectContaining({ toString: expect.any(Function) }),
          costAfter: '0'
        })
      })
    );
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentBalance: '0',
          balanceCostAmount: '0',
          lossReportedAt: expect.any(Date),
          recordStatus: 'disabled'
        })
      })
    );
    expect(tx.idBusinessV2Activation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId, status: 'active' },
        data: expect.objectContaining({ status: 'abnormal' })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
  });

  it('reuses the same transaction and links the gift-card reversal in the loss audit', async () => {
    await service.reportLossInTransaction(
      tx as never,
      accountId,
      {
        reason: 'ID 已死亡无法登录',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'gift-loss-0001'
      },
      operator,
      {
        source: 'gift_card_redeemed',
        giftCardId: '90000000-0000-4000-8000-000000000001',
        giftCardMasked: 'X123****CDEF',
        reversalLedgerEntryId: '90000000-0000-4000-8000-000000000002'
      }
    );

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterData: expect.objectContaining({
          source: 'gift_card_redeemed',
          sourceGiftCardId: '90000000-0000-4000-8000-000000000001',
          sourceGiftCardMasked: 'X123****CDEF',
          sourceReversalLedgerEntryId: '90000000-0000-4000-8000-000000000002'
        })
      })
    });
  });

  it('allows a zero-balance ID to create a permanent zero-loss record', async () => {
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        currentBalance: new Prisma.Decimal(0),
        balanceCostAmount: new Prisma.Decimal(0)
      })
    ]);
    tx.idBusinessV2AccountLoss.create.mockResolvedValue(
      makeLossRecord({
        lossBalance: new Prisma.Decimal(0),
        lossCostAmount: new Prisma.Decimal(0)
      })
    );

    const result = await service.reportLoss(
      accountId,
      {
        reason: 'ID 已永久冻结',
        expectedCurrentBalance: '0',
        expectedBalanceCostAmount: '0',
        idempotencyKey: 'loss-request-zero'
      },
      operator
    );

    expect(result.lossRecord.lossBalance).toBe('0');
    expect(result.lossRecord.lossCostAmount).toBe('0');
  });

  it('preserves the sold-order snapshot when reporting a sold ID', async () => {
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        soldByOrderId: '80000000-0000-4000-8000-000000000001',
        soldOrderNo: 'V220260729SOLD001'
      })
    ]);
    tx.idBusinessV2AccountLoss.create.mockResolvedValue(
      makeLossRecord({
        saleState: 'sold',
        soldOrderId: '80000000-0000-4000-8000-000000000001',
        soldOrderNo: 'V220260729SOLD001'
      })
    );

    const result = await service.reportLoss(
      accountId,
      {
        reason: '售后确认 ID 死亡',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-request-sold'
      },
      operator
    );

    expect(result.lossRecord.saleState).toBe('sold');
    expect(result.lossRecord.soldOrderId).toBe('80000000-0000-4000-8000-000000000001');
    expect(result.lossRecord.soldOrderNo).toBe('V220260729SOLD001');
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith(
      expect.not.objectContaining({
        data: expect.objectContaining({ soldByOrderId: null })
      })
    );
  });

  it('rejects reporting while the ID has an active order lock', async () => {
    tx.idBusinessV2AccountLock.count.mockResolvedValue(1);

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-request-lock'
        },
        operator
      )
    ).rejects.toBeInstanceOf(NestConflictException);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects a stale balance snapshot before writing any loss entry', async () => {
    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '19',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-request-stale'
        },
        operator
      )
    ).rejects.toThrow('ID 余额已发生变化');
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('does not report success when a later write in the transaction fails', async () => {
    tx.idBusinessV2Activation.updateMany.mockRejectedValueOnce(
      new Error('simulated transaction failure')
    );

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-request-rollback'
        },
        operator
      )
    ).rejects.toThrow('simulated transaction failure');

    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns the original record for an identical idempotent replay', async () => {
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue(makeLossRecord());

    const result = await service.reportLoss(
      accountId,
      {
        reason: 'ID 已死亡无法登录',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-request-0001'
      },
      operator
    );

    expect(result.idempotentReplay).toBe(true);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('returns the committed result when identical requests race on the account lock', async () => {
    tx.idBusinessV2AccountLoss.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(makeLossRecord());
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        currentBalance: new Prisma.Decimal(0),
        balanceCostAmount: new Prisma.Decimal(0),
        lossReportedAt: reportedAt
      })
    ]);

    const result = await service.reportLoss(
      accountId,
      {
        reason: 'ID 已死亡无法登录',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-request-0001'
      },
      operator
    );

    expect(result.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects a second report with a different idempotency key', async () => {
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        lossReportedAt: reportedAt
      })
    ]);

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: '重复报损',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-request-other'
        },
        operator
      )
    ).rejects.toThrow('该 ID 已报损');
  });

  it('filters and sorts the immutable loss-record list', async () => {
    tx.idBusinessV2AccountLoss.findMany.mockResolvedValue([makeLossRecord()]);
    tx.idBusinessV2AccountLoss.count.mockResolvedValue(1);

    const result = await service.list({
      page: '1',
      pageSize: '20',
      keyword: '管理员',
      countryOptionId: '30000000-0000-4000-8000-000000000001',
      saleState: 'sold',
      reportedFrom: '2026-07-01',
      reportedTo: '2026-07-29',
      sortBy: 'lossCostAmount',
      sortOrder: 'desc'
    });

    expect(result.items[0]).toMatchObject({
      rowNumber: 1,
      reportedByName: operator.displayName
    });
    expect(tx.idBusinessV2AccountLoss.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          countryOptionId: '30000000-0000-4000-8000-000000000001',
          saleState: 'sold',
          reportedAt: {
            gte: new Date('2026-07-01T00:00:00.000Z'),
            lt: new Date('2026-07-30T00:00:00.000Z')
          },
          OR: expect.arrayContaining([
            { reportedByName: { contains: '管理员', mode: 'insensitive' } }
          ])
        }),
        orderBy: [{ lossCostAmount: 'desc' }, { reportedAt: 'desc' }, { id: 'desc' }]
      })
    );
  });
});
