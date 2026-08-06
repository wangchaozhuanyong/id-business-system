import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
import { ConflictException as NestConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2AccountLossCommandHandler } from './id-business-v2-account-loss.command-handler';
import { IdBusinessV2AccountLossPostingCoordinator } from './id-business-v2-account-loss-posting.coordinator';
import { IdBusinessV2AccountLossQueryService } from './id-business-v2-account-loss-query.service';
import { IdBusinessV2AccountLossRepository } from './id-business-v2-account-loss.repository';
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
    activeLossRecordId: null,
    statusOptionId: 'normal-status-id',
    statusName: '正常',
    recordStatus: 'active',
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
    reportedByName: operator.username,
    reportedAt,
    status: 'active' as const,
    previousStatusOptionId: 'normal-status-id',
    previousStatusName: '正常',
    previousRecordStatus: 'active' as const,
    financeJournalId: 'finance-journal-1',
    reversalFinanceJournalId: null,
    reversalReason: null,
    reversedAt: null,
    reversedByUserId: null,
    reversedByName: null,
    reportedBy: {
      id: operator.id,
      username: operator.username,
      displayName: operator.displayName
    },
    reversedBy: null,
    ...overrides
  };
}

describe('IdBusinessV2AccountLossesService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2AccountLoss: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
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
    idBusinessV2FinanceJournal: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    },
    idBusinessV2TopupSupplierAccount: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2TopupSupplierPayment: {
      create: vi.fn()
    },
    idBusinessV2TopupSupplierLedger: {
      create: vi.fn()
    }
  };
  const prisma = {
    ...tx,
    $transaction: vi.fn()
  };
  const financePostingService = {
    post: vi.fn(),
    reverse: vi.fn()
  };
  const transactionHarness = {
    commits: 0,
    rollbacks: 0
  };
  const balanceCalculator = new IdBusinessV2BalanceCalculatorService();
  const repository = new IdBusinessV2AccountLossRepository(prisma as never);
  const postingCoordinator = new IdBusinessV2AccountLossPostingCoordinator(
    repository,
    balanceCalculator,
    financePostingService as never
  );
  const commandHandler = new IdBusinessV2AccountLossCommandHandler(
    repository,
    postingCoordinator,
    financePostingService as never,
    new V2CommandTransactionManager(prisma as never),
    new V2TransactionalAuditService()
  );
  const service = new IdBusinessV2AccountLossesService(
    commandHandler,
    new IdBusinessV2AccountLossQueryService(repository)
  );

  beforeEach(() => {
    vi.resetAllMocks();
    transactionHarness.commits = 0;
    transactionHarness.rollbacks = 0;
    prisma.$transaction.mockImplementation(
      async (input: Array<Promise<unknown>> | ((client: typeof tx) => Promise<unknown>)) => {
        if (typeof input !== 'function') return Promise.all(input);
        try {
          const result = await input(tx);
          transactionHarness.commits += 1;
          return result;
        } catch (error) {
          transactionHarness.rollbacks += 1;
          throw error;
        }
      }
    );
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue(null);
    tx.idBusinessV2AccountLoss.findFirst.mockResolvedValue(null);
    tx.$queryRaw.mockResolvedValue([makeLockedAccount()]);
    tx.idBusinessV2AccountLock.count.mockResolvedValue(0);
    tx.idBusinessV2Option.findFirst.mockResolvedValue({
      id: '70000000-0000-4000-8000-000000000001'
    });
    tx.idBusinessV2BalanceLedger.create.mockResolvedValue({
      id: '60000000-0000-4000-8000-000000000001'
    });
    tx.idBusinessV2AccountLoss.create.mockImplementation(
      (input: { data?: Record<string, unknown> }) => Promise.resolve(makeLossRecord(input.data))
    );
    tx.idBusinessV2AccountLoss.update.mockImplementation(
      (input: { data?: Record<string, unknown> }) =>
        Promise.resolve(
          makeLossRecord({
            ...(tx.idBusinessV2AccountLoss.create.mock.calls.at(-1)?.[0]?.data ?? {}),
            ...(input.data ?? {}),
            financeJournalId: input.data?.financeJournalId ?? 'finance-journal-1',
            status: input.data?.status ?? 'active',
            reversalFinanceJournalId: input.data?.reversalFinanceJournalId ?? null,
            reversalReason: input.data?.reversalReason ?? null,
            reversedAt: input.data?.reversedAt ?? null,
            reversedByUserId: input.data?.reversedByUserId ?? null,
            reversedByName: input.data?.reversedByName ?? null,
            reversedBy: input.data?.reversedByUserId
              ? {
                  id: operator.id,
                  username: operator.username,
                  displayName: operator.displayName
                }
              : null
          })
        )
    );
    tx.idBusinessV2Account.update.mockResolvedValue({});
    tx.idBusinessV2Activation.updateMany.mockResolvedValue({ count: 1 });
    tx.idBusinessV2FinanceJournal.findUnique.mockResolvedValue(null);
    tx.idBusinessV2FinanceJournal.create.mockResolvedValue({
      id: 'finance-journal-1',
      lines: []
    });
    tx.auditLog.create.mockResolvedValue({});
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
    financePostingService.reverse.mockResolvedValue({ id: 'finance-reversal-1' });
  });

  it('atomically freezes the ID without clearing balance, writes loss ledger and marks activations abnormal', async () => {
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
          balanceAmount: '0',
          costAmount: '0',
          balanceBefore: '20',
          balanceAfter: '20',
          costBefore: '70',
          costAfter: '70'
        })
      })
    );
    const freezeInput = tx.idBusinessV2Account.update.mock.calls[0]?.[0];
    expect(freezeInput).toEqual(
      expect.objectContaining({
        data: expect.objectContaining({
          activeLossRecordId: '50000000-0000-4000-8000-000000000001',
          lossReportedAt: expect.any(Date),
          recordStatus: 'disabled'
        })
      })
    );
    expect(freezeInput.data).not.toHaveProperty('currentBalance');
    expect(freezeInput.data).not.toHaveProperty('balanceCostAmount');
    expect(tx.idBusinessV2Activation.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { accountId, status: 'active' },
        data: expect.objectContaining({ status: 'abnormal' })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2TopupSupplierAccount.findUnique).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierAccount.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierPayment.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
    expect(transactionHarness).toEqual({ commits: 1, rollbacks: 0 });
  });

  it('keeps the real account-loss finance posting isolated from supplier fund models', async () => {
    const financeCommandRepository = {
      findJournalReplay: vi.fn().mockResolvedValue(null),
      createJournal: vi.fn((client: typeof tx, data: Record<string, unknown>) =>
        client.idBusinessV2FinanceJournal.create({
          data,
          include: { lines: { orderBy: { lineNo: 'asc' } } }
        })
      ),
      incrementFinanceAccount: vi.fn()
    };
    const integratedCommandHandler = new IdBusinessV2AccountLossCommandHandler(
      repository,
      new IdBusinessV2AccountLossPostingCoordinator(
        repository,
        balanceCalculator,
        new IdBusinessV2FinancePostingService(financeCommandRepository as never)
      ),
      new IdBusinessV2FinancePostingService(financeCommandRepository as never),
      new V2CommandTransactionManager(prisma as never),
      new V2TransactionalAuditService()
    );

    await integratedCommandHandler.reportLoss(
      accountId,
      {
        reason: 'ID 已死亡无法登录',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-no-supplier-fund'
      },
      operator
    );

    const journalInput = tx.idBusinessV2FinanceJournal.create.mock.calls[0]?.[0];
    expect(journalInput.data.lines.create).toHaveLength(4);
    expect(
      journalInput.data.lines.create.every(
        (line: { supplierAccountId?: string | null }) => line.supplierAccountId == null
      )
    ).toBe(true);
    expect(tx.idBusinessV2TopupSupplierAccount.findUnique).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierAccount.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierPayment.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
    expect(transactionHarness).toEqual({ commits: 1, rollbacks: 0 });
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

  it('allows a zero-balance ID to create a zero-loss freeze record', async () => {
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
        reason: 'ID 已报损冻结',
        expectedCurrentBalance: '0',
        expectedBalanceCostAmount: '0',
        idempotencyKey: 'loss-request-zero'
      },
      operator
    );

    expect(result.lossRecord.lossBalance).toBe('0');
    expect(result.lossRecord.lossCostAmount).toBe('0');
  });

  it('accepts Cloudflare Decimal rows without cross-runtime Decimal calls', async () => {
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        purchaseCost: new CloudflarePrisma.Decimal('12.5'),
        currentBalance: new CloudflarePrisma.Decimal('20'),
        balanceCostAmount: new CloudflarePrisma.Decimal('70')
      })
    ]);
    tx.idBusinessV2AccountLoss.create.mockResolvedValue(
      makeLossRecord({
        lossBalance: new CloudflarePrisma.Decimal('20'),
        lossCostAmount: new CloudflarePrisma.Decimal('70'),
        idPurchaseCostLossAmount: new CloudflarePrisma.Decimal('12.5')
      })
    );

    const result = await service.reportLoss(
      accountId,
      {
        reason: 'Cloudflare 环境报损回归',
        expectedCurrentBalance: '20',
        expectedBalanceCostAmount: '70',
        idempotencyKey: 'loss-cloudflare-0001'
      },
      operator
    );

    expect(result.lossRecord).toMatchObject({
      lossBalance: '20',
      lossCostAmount: '70',
      idPurchaseCostLossAmount: '12.5'
    });
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ balanceBefore: '20', costBefore: '70' })
      })
    );
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
    expect(transactionHarness).toEqual({ commits: 0, rollbacks: 1 });
  });

  it('does not freeze, mark activations or audit when finance posting fails', async () => {
    financePostingService.post.mockRejectedValueOnce(new Error('simulated finance failure'));

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-finance-rollback'
        },
        operator
      )
    ).rejects.toThrow('simulated finance failure');

    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Activation.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierAccount.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierPayment.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
    expect(transactionHarness).toEqual({ commits: 0, rollbacks: 1 });
  });

  it('rolls back the complete command when transactional audit fails', async () => {
    tx.auditLog.create.mockRejectedValueOnce(new Error('simulated audit failure'));

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-audit-rollback'
        },
        operator
      )
    ).rejects.toThrow('simulated audit failure');

    expect(financePostingService.post).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2Activation.updateMany).toHaveBeenCalledOnce();
    expect(transactionHarness).toEqual({ commits: 0, rollbacks: 1 });
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
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValueOnce(null);
    tx.idBusinessV2AccountLoss.findFirst.mockResolvedValueOnce(makeLossRecord());
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

  it('verifies and returns the committed replay in a new transaction after P2002', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementationOnce(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
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
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns 409 when a raced P2002 replay has the same key but different parameters', async () => {
    prisma.$transaction
      .mockRejectedValueOnce({ code: 'P2002' })
      .mockImplementationOnce(async (work: (client: typeof tx) => Promise<unknown>) => work(tx));
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue(
      makeLossRecord({ reason: '另一份报损内容' })
    );

    await expect(
      service.reportLoss(
        accountId,
        {
          reason: 'ID 已死亡无法登录',
          expectedCurrentBalance: '20',
          expectedBalanceCostAmount: '70',
          idempotencyKey: 'loss-request-0001'
        },
        operator
      )
    ).rejects.toBeInstanceOf(NestConflictException);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
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

  it('unfreezes an active loss, restores the account status and creates a finance reversal', async () => {
    tx.$queryRaw.mockResolvedValue([
      makeLockedAccount({
        lossReportedAt: reportedAt,
        activeLossRecordId: '50000000-0000-4000-8000-000000000001',
        statusOptionId: 'frozen-status-id',
        statusName: '冻结',
        recordStatus: 'disabled'
      })
    ]);
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValueOnce(makeLossRecord());

    const result = await service.unfreezeLoss(
      accountId,
      {
        expectedLossId: '50000000-0000-4000-8000-000000000001',
        reason: '确认 ID 可继续使用',
        idempotencyKey: 'unfreeze-request-0001'
      },
      operator
    );

    expect(financePostingService.reverse).toHaveBeenCalledWith(
      tx,
      'finance-journal-1',
      '确认 ID 可继续使用',
      `account_loss_unfreeze:${accountId}:50000000-0000-4000-8000-000000000001:unfreeze-request-0001`,
      operator
    );
    expect(tx.idBusinessV2AccountLoss.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: '50000000-0000-4000-8000-000000000001' },
        data: expect.objectContaining({
          status: 'reversed',
          reversalFinanceJournalId: 'finance-reversal-1',
          reversalReason: '确认 ID 可继续使用'
        })
      })
    );
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: accountId },
        data: expect.objectContaining({
          statusOptionId: 'normal-status-id',
          lossReportedAt: null,
          activeLossRecordId: null,
          recordStatus: 'active'
        })
      })
    );
    expect(tx.idBusinessV2Activation.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result.account).toMatchObject({
      lossStatus: 'active',
      lossReportedAt: null,
      activeLossId: null,
      currentBalance: '20',
      balanceCostAmount: '70'
    });
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
      reportedByName: operator.username
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
