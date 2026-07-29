import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2GiftCardReversalService } from './id-business-v2-gift-card-reversal.service';

const accountId = '11111111-1111-4111-8111-111111111111';
const giftCardId = '22222222-2222-4222-8222-222222222222';
const originalEntryId = '33333333-3333-4333-8333-333333333333';
const operator = {
  id: '44444444-4444-4444-8444-444444444444',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.balance.adjust']
};
const createdAt = new Date('2026-07-26T12:00:00.000Z');
const statusChangedAt = new Date('2026-07-26T13:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeDto(overrides: Record<string, unknown> = {}) {
  return {
    action: 'redeemed' as const,
    reason: '供应商确认卡片已被其他账号赎回',
    idempotencyKey: 'reversal-12345678',
    ...overrides
  };
}

function makeLockedGiftCard(overrides: Record<string, unknown> = {}) {
  return {
    id: giftCardId,
    accountId,
    supplierOptionId: null,
    sourceAttachmentId: null,
    codeMasked: 'X123****CDEF',
    codeTail: 'CDEF',
    faceValue: decimal('20'),
    exchangeRate: decimal('5.4'),
    costAmount: decimal('108'),
    status: 'credited',
    createdAt,
    ...overrides
  };
}

function makeLockedAccount(overrides: Record<string, unknown> = {}) {
  return {
    id: accountId,
    appleIdMasked: 'us***@example.com',
    currentBalance: decimal('150'),
    balanceCostAmount: decimal('840'),
    recordStatus: 'active',
    lossReportedAt: null,
    ...overrides
  };
}

function makeStoredGiftCard(overrides: Record<string, unknown> = {}) {
  return {
    ...makeLockedGiftCard(),
    codeEncrypted: 'v1:encrypted',
    codeHash: 'hashed-code',
    statusChangedAt,
    remark: null,
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    updatedAt: statusChangedAt,
    ...overrides
  };
}

function makeReversalLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    accountId,
    giftCardId,
    entryType: 'gift_card_redeemed',
    direction: 'debit',
    balanceAmount: decimal('20'),
    costAmount: decimal('112'),
    balanceBefore: decimal('150'),
    balanceAfter: decimal('130'),
    costBefore: decimal('840'),
    costAfter: decimal('728'),
    averageCostBefore: decimal('5.6'),
    averageCostAfter: decimal('5.6'),
    reversalOfEntryId: originalEntryId,
    idempotencyKey: `gift_card_reversal:${giftCardId}:reversal-12345678`,
    remark: '供应商确认卡片已被其他账号赎回',
    createdByUserId: operator.id,
    createdAt: statusChangedAt,
    ...overrides
  };
}

describe('IdBusinessV2GiftCardReversalService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2GiftCard: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    idBusinessV2AccountLoss: {
      findUnique: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2Account: {
      findFirst: vi.fn()
    },
    idBusinessV2GiftCard: {
      findMany: vi.fn()
    }
  };
  const accountLossesService = {
    reportLossInTransaction: vi.fn()
  };
  const service = new IdBusinessV2GiftCardReversalService(
    prisma as never,
    new IdBusinessV2BalanceCalculatorService(),
    accountLossesService as never
  );

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    prisma.idBusinessV2Account.findFirst.mockResolvedValue({
      id: accountId,
      appleIdMasked: 'us***@example.com'
    });
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([]);
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue({ accountId });
    tx.$queryRaw
      .mockResolvedValueOnce([makeLockedAccount()])
      .mockResolvedValueOnce([makeLockedGiftCard()]);
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue(null);
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      if (where.giftCardId_entryType) return { id: originalEntryId };
      return null;
    });
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) =>
      makeReversalLedger({
        ...data,
        createdAt: statusChangedAt
      })
    );
    tx.idBusinessV2GiftCard.update.mockImplementation(async ({ data }) =>
      makeStoredGiftCard({
        status: data.status,
        statusChangedAt: data.statusChangedAt
      })
    );
    tx.idBusinessV2Account.update.mockImplementation(async ({ data }) => ({
      id: accountId,
      appleIdMasked: 'us***@example.com',
      currentBalance: data.currentBalance,
      balanceCostAmount: data.balanceCostAmount
    }));
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    accountLossesService.reportLossInTransaction.mockResolvedValue({
      lossRecord: {
        id: '77777777-7777-4777-8777-777777777777',
        ledgerEntryId: '88888888-8888-4888-8888-888888888888'
      },
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        lossStatus: 'reported',
        lossReportedAt: statusChangedAt.toISOString(),
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      idempotentReplay: false
    });
  });

  it('lists only masked credited gift cards needed by the reversal workbench', async () => {
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([
      {
        id: giftCardId,
        codeMasked: 'X123****CDEF',
        codeTail: 'CDEF',
        faceValue: decimal('20'),
        exchangeRate: decimal('5.4'),
        costAmount: decimal('108'),
        status: 'credited',
        createdAt,
        supplierOption: {
          id: '66666666-6666-4666-8666-666666666666',
          name: '供应商 A'
        },
        ledgerEntries: [
          {
            id: originalEntryId,
            balanceBefore: decimal('130'),
            balanceAfter: decimal('150'),
            createdAt
          }
        ]
      }
    ]);

    const result = await service.listReversible(accountId);

    expect(result).toMatchObject({
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com'
      },
      total: 1,
      items: [
        {
          id: giftCardId,
          codeMasked: 'X123****CDEF',
          faceValue: '20',
          exchangeRate: '5.4',
          costAmount: '108',
          status: 'credited',
          supplier: {
            name: '供应商 A'
          },
          creditedLedger: {
            id: originalEntryId,
            balanceBefore: '130',
            balanceAfter: '150'
          }
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('codeEncrypted');
    expect(JSON.stringify(result)).not.toContain('codeHash');
  });

  it('marks a credited card as redeemed and writes one atomic debit ledger', async () => {
    const result = await service.reverse(giftCardId, makeDto(), operator);

    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId,
        giftCardId,
        entryType: 'gift_card_redeemed',
        direction: 'debit',
        balanceAmount: decimal('20'),
        costAmount: decimal('112'),
        balanceBefore: decimal('150'),
        balanceAfter: decimal('130'),
        costBefore: decimal('840'),
        costAfter: decimal('728'),
        averageCostBefore: decimal('5.6'),
        averageCostAfter: decimal('5.6'),
        reversalOfEntryId: originalEntryId,
        idempotencyKey: `gift_card_reversal:${giftCardId}:reversal-12345678`
      })
    });
    expect(tx.idBusinessV2GiftCard.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: giftCardId },
        data: expect.objectContaining({
          status: 'redeemed',
          updatedByUserId: operator.id
        })
      })
    );
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: decimal('130'),
        balanceCostAmount: decimal('728'),
        updatedByUserId: operator.id
      },
      select: {
        id: true,
        appleIdMasked: true,
        currentBalance: true,
        balanceCostAmount: true
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(result).toMatchObject({
      action: 'redeemed',
      giftCard: {
        status: 'redeemed'
      },
      ledgerEntry: {
        entryType: 'gift_card_redeemed',
        balanceAfter: '130',
        costAfter: '728',
        reversalOfEntryId: originalEntryId
      },
      account: {
        currentBalance: '130',
        balanceCostAmount: '728'
      },
      accountLoss: null,
      idempotentReplay: false
    });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('X123456789ABCDEF');
  });

  it('atomically reports the remaining ID balance as lost after marking the card redeemed', async () => {
    const result = await service.reverse(
      giftCardId,
      makeDto({ reportAccountLoss: true }),
      operator
    );

    expect(accountLossesService.reportLossInTransaction).toHaveBeenCalledWith(
      tx,
      accountId,
      expect.objectContaining({
        reason: '供应商确认卡片已被其他账号赎回',
        expectedCurrentBalance: '130',
        expectedBalanceCostAmount: '728',
        idempotencyKey: expect.stringMatching(/^gc-loss-[a-f0-9]{64}$/)
      }),
      operator,
      {
        source: 'gift_card_redeemed',
        giftCardId,
        giftCardMasked: 'X123****CDEF',
        reversalLedgerEntryId: '55555555-5555-4555-8555-555555555555'
      }
    );
    expect(result).toMatchObject({
      action: 'redeemed',
      account: {
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      accountLoss: {
        lossRecord: {
          id: '77777777-7777-4777-8777-777777777777'
        }
      }
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        afterData: expect.objectContaining({
          accountLossRecordId: '77777777-7777-4777-8777-777777777777',
          accountLossLedgerEntryId: '88888888-8888-4888-8888-888888888888'
        })
      })
    });
  });

  it('still reports a zero-value ID loss when the redeemed card uses the remaining balance', async () => {
    tx.$queryRaw.mockReset();
    tx.$queryRaw
      .mockResolvedValueOnce([
        makeLockedAccount({
          currentBalance: decimal('20'),
          balanceCostAmount: decimal('112')
        })
      ])
      .mockResolvedValueOnce([makeLockedGiftCard()]);

    await service.reverse(giftCardId, makeDto({ reportAccountLoss: true }), operator);

    expect(accountLossesService.reportLossInTransaction).toHaveBeenCalledWith(
      tx,
      accountId,
      expect.objectContaining({
        expectedCurrentBalance: '0',
        expectedBalanceCostAmount: '0'
      }),
      operator,
      expect.any(Object)
    );
  });

  it('rejects the whole transaction when the linked ID loss cannot be completed', async () => {
    accountLossesService.reportLossInTransaction.mockRejectedValue(
      new ConflictException('该 ID 有未释放的订单锁')
    );

    await expect(
      service.reverse(giftCardId, makeDto({ reportAccountLoss: true }), operator)
    ).rejects.toThrow('该 ID 有未释放的订单锁');

    expect(accountLossesService.reportLossInTransaction).toHaveBeenCalledWith(
      tx,
      accountId,
      expect.any(Object),
      operator,
      expect.any(Object)
    );
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('requires account update permission for the optional permanent ID loss', async () => {
    await expect(
      service.reverse(giftCardId, makeDto({ reportAccountLoss: true }), {
        ...operator,
        roles: [],
        permissions: ['apple.balance.adjust']
      })
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('rejects the account-loss option for withdrawal actions', async () => {
    await expect(
      service.reverse(
        giftCardId,
        makeDto({
          action: 'withdrawn',
          reason: '录入目标错误，需要撤回',
          reportAccountLoss: true
        }),
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('uses a distinct withdrawal status and ledger type', async () => {
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) =>
      makeReversalLedger({
        ...data,
        entryType: 'gift_card_withdrawal',
        remark: '录入目标错误，需要撤回',
        createdAt: statusChangedAt
      })
    );

    const result = await service.reverse(
      giftCardId,
      makeDto({
        action: 'withdrawn',
        reason: '录入目标错误，需要撤回'
      }),
      operator
    );

    expect(result.action).toBe('withdrawn');
    expect(result.giftCard.status).toBe('withdrawn');
    expect(result.ledgerEntry.entryType).toBe('gift_card_withdrawal');
  });

  it('returns a matching idempotent replay without a second debit', async () => {
    const replayEntry = {
      ...makeReversalLedger(),
      giftCard: makeStoredGiftCard({ status: 'redeemed' })
    };
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      if (where.idempotencyKey) return replayEntry;
      return null;
    });

    const result = await service.reverse(giftCardId, makeDto(), operator);

    expect(result.idempotentReplay).toBe(true);
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GiftCard.update).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('returns both linked results for an idempotent combined replay after the ID is frozen', async () => {
    const replayEntry = {
      ...makeReversalLedger(),
      giftCard: makeStoredGiftCard({ status: 'redeemed' })
    };
    tx.$queryRaw.mockReset();
    tx.$queryRaw.mockResolvedValueOnce([
      makeLockedAccount({
        currentBalance: decimal('0'),
        balanceCostAmount: decimal('0'),
        recordStatus: 'disabled',
        lossReportedAt: statusChangedAt
      })
    ]);
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      if (where.idempotencyKey) return replayEntry;
      return null;
    });
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777'
    });
    accountLossesService.reportLossInTransaction.mockResolvedValue({
      lossRecord: {
        id: '77777777-7777-4777-8777-777777777777',
        ledgerEntryId: '88888888-8888-4888-8888-888888888888'
      },
      account: {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        lossStatus: 'reported',
        lossReportedAt: statusChangedAt.toISOString(),
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      idempotentReplay: true
    });

    const result = await service.reverse(
      giftCardId,
      makeDto({ reportAccountLoss: true }),
      operator
    );

    expect(result.idempotentReplay).toBe(true);
    expect(result.accountLoss?.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects changing the account-loss option while reusing a reversal idempotency key', async () => {
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      if (where.idempotencyKey) {
        return {
          ...makeReversalLedger(),
          giftCard: makeStoredGiftCard({ status: 'redeemed' })
        };
      }
      return null;
    });
    tx.idBusinessV2AccountLoss.findUnique.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777'
    });

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects reusing an idempotency key for another action or reason', async () => {
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue({
      ...makeReversalLedger({
        entryType: 'gift_card_withdrawal',
        remark: '另一项处理'
      }),
      giftCard: makeStoredGiftCard({ status: 'withdrawn' })
    });

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects a gift card that is already redeemed or withdrawn', async () => {
    tx.$queryRaw.mockReset();
    tx.$queryRaw
      .mockResolvedValueOnce([makeLockedAccount()])
      .mockResolvedValueOnce([makeLockedGiftCard({ status: 'redeemed' })]);

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects an original credit ledger that already has a reversal', async () => {
    tx.idBusinessV2BalanceLedger.findUnique.mockImplementation(async ({ where }) => {
      if (where.giftCardId_entryType) return { id: originalEntryId };
      if (where.reversalOfEntryId) {
        return {
          id: 'existing-reversal',
          entryType: 'gift_card_redeemed'
        };
      }
      return null;
    });

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });

  it('rejects a full-card reversal when the account balance is insufficient', async () => {
    tx.$queryRaw.mockReset();
    tx.$queryRaw
      .mockResolvedValueOnce([
        makeLockedAccount({
          currentBalance: decimal('10'),
          balanceCostAmount: decimal('56')
        })
      ])
      .mockResolvedValueOnce([makeLockedGiftCard()]);

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('rejects a missing gift card before locking or writing an account', async () => {
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue(null);

    await expect(service.reverse(giftCardId, makeDto(), operator)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
  });
});
