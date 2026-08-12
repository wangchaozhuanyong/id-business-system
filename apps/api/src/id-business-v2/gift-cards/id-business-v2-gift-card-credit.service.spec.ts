import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2GiftCardCreditService } from './id-business-v2-gift-card-credit.service';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const accountId = '11111111-1111-4111-8111-111111111111';
const supplierOptionId = '22222222-2222-4222-8222-222222222222';
const cardNameOptionId = '77777777-7777-4777-8777-777777777777';
const countryOptionId = '66666666-6666-4666-8666-666666666666';
const operator = {
  id: '33333333-3333-4333-8333-333333333333',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.balance.topup']
};
const createdAt = new Date('2026-07-26T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeDto(overrides: Record<string, unknown> = {}) {
  return {
    code: 'X123-4567-89AB-CDEF',
    faceValue: '10',
    cardNameOptionId,
    countryOptionId,
    exchangeRate: '2.5',
    supplierOptionId,
    creditedAt: createdAt.toISOString(),
    idempotencyKey: 'request-12345678',
    remark: '人工核对通过',
    ...overrides
  };
}

function makeGiftCard(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    accountId,
    cardNameOptionId,
    cardNameSnapshot: '苹果礼品卡',
    supplierOptionId,
    countryOptionId,
    countryNameSnapshot: '美国',
    currencyCodeSnapshot: 'USD',
    sourceAttachmentId: null,
    codeEncrypted: 'v1:encrypted',
    codeHash: 'hashed-code',
    codeMasked: 'X123****CDEF',
    codeTail: 'CDEF',
    faceValue: decimal('10'),
    exchangeRate: decimal('2.5'),
    exchangeRateSource: 'manual_input',
    exchangeRateSnapshotId: null,
    exchangeRatePrefilledValue: null,
    exchangeRateWasOverridden: false,
    costAmount: decimal('25'),
    purchaseOriginalAmount: decimal('25'),
    purchaseCurrency: 'CNY',
    purchaseFxRateToCny: decimal('1'),
    purchaseFxSnapshotId: null,
    purchaseFinanceAccountId: null,
    purchaseSupplierAccountId: null,
    paidAt: null,
    creditedAmount: decimal('0'),
    redeemedAmount: decimal('0'),
    withdrawnAmount: decimal('0'),
    status: 'credited',
    statusChangedAt: createdAt,
    creditedAt: createdAt,
    remark: '人工核对通过',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt,
    updatedAt: createdAt,
    ...overrides
  };
}

function makeLedger(overrides: Record<string, unknown> = {}) {
  return {
    id: '55555555-5555-4555-8555-555555555555',
    accountId,
    giftCardId: '44444444-4444-4444-8444-444444444444',
    entryType: 'gift_card_credit',
    direction: 'credit',
    balanceAmount: decimal('10'),
    costAmount: decimal('25'),
    balanceBefore: decimal('20'),
    balanceAfter: decimal('30'),
    costBefore: decimal('50'),
    costAfter: decimal('75'),
    averageCostBefore: decimal('2.5'),
    averageCostAfter: decimal('2.5'),
    reversalOfEntryId: null,
    idempotencyKey: `gift_card_credit:${accountId}:request-12345678`,
    remark: '人工核对通过',
    createdByUserId: operator.id,
    createdAt,
    ...overrides
  };
}

describe('IdBusinessV2GiftCardCreditService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2BalanceLedger: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2GiftCard: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    },
    idBusinessV2Account: {
      update: vi.fn()
    },
    idBusinessV2FinanceAccount: {
      findUnique: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const fieldEncryptionService = {
    hash: vi.fn(),
    encrypt: vi.fn()
  };
  const exchangeRateQueryService = {
    validatePrefill: vi.fn()
  };
  const supplierFundsService = {
    debitGiftCard: vi.fn()
  };
  const financePostingService = {
    post: vi.fn()
  };
  const financeFxService = {
    resolve: vi.fn()
  };
  const service = new IdBusinessV2GiftCardCreditService(
    fieldEncryptionService as never,
    new IdBusinessV2BalanceCalculatorService(),
    exchangeRateQueryService as never,
    supplierFundsService as never,
    financePostingService as never,
    financeFxService as never,
    new IdBusinessV2GiftCardsRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
    financeFxService.resolve.mockResolvedValue({
      id: '99999999-9999-4999-8999-999999999999',
      rateToCny: decimal('1.7'),
      source: 'manual'
    });
    tx.idBusinessV2FinanceAccount.findUnique.mockResolvedValue({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      currency: 'MYR',
      status: 'active'
    });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.$queryRaw.mockResolvedValue([
      {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: decimal('20'),
        balanceCostAmount: decimal('50'),
        soldByOrderId: null,
        lossReportedAt: null,
        countryOptionId,
        countryName: '美国',
        currencyCode: 'USD'
      }
    ]);
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue(null);
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'country') return { id: countryOptionId };
      if (where.type === 'gift_card_name') {
        return { id: cardNameOptionId, name: '苹果礼品卡' };
      }
      return { id: supplierOptionId, name: '测试供应商' };
    });
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue(null);
    tx.idBusinessV2GiftCard.update.mockResolvedValue({});
    tx.idBusinessV2GiftCard.create.mockImplementation(async ({ data }) =>
      makeGiftCard({
        ...data,
        sourceAttachmentId: data.sourceAttachmentId ?? null,
        createdAt
      })
    );
    tx.idBusinessV2BalanceLedger.create.mockImplementation(async ({ data }) =>
      makeLedger({
        ...data,
        createdAt
      })
    );
    tx.idBusinessV2Account.update.mockImplementation(async ({ data }) => ({
      id: accountId,
      appleIdMasked: 'us***@example.com',
      currentBalance: data.currentBalance,
      balanceCostAmount: data.balanceCostAmount
    }));
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
    fieldEncryptionService.hash.mockReturnValue('hashed-code');
    fieldEncryptionService.encrypt.mockReturnValue('v1:encrypted');
    exchangeRateQueryService.validatePrefill.mockResolvedValue({
      exchangeRateSource: 'automatic_snapshot',
      exchangeRateSnapshotId: '66666666-6666-4666-8666-666666666666',
      exchangeRatePrefilledValue: decimal('2.5'),
      exchangeRateWasOverridden: true
    });
    supplierFundsService.debitGiftCard.mockResolvedValue({
      ledgerEntryId: '77777777-7777-4777-8777-777777777777',
      supplierAccountId: '88888888-8888-4888-8888-888888888888',
      supplierName: '测试供应商',
      amountCny: '25',
      balanceBeforeCny: '1000',
      balanceAfterCny: '975',
      isNegative: false,
      shortfallCny: '0',
      createdAt,
      idempotentReplay: false
    });
  });

  it('locks the account and atomically credits balance and moving average cost', async () => {
    const result = await service.confirmCredit(accountId, makeDto(), operator);

    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2GiftCard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId,
        cardNameOptionId,
        cardNameSnapshot: '苹果礼品卡',
        countryOptionId,
        supplierOptionId,
        codeEncrypted: 'v1:encrypted',
        codeHash: 'hashed-code',
        codeMasked: 'X123****CDEF',
        codeTail: 'CDEF',
        faceValue: '10',
        exchangeRate: '2.5',
        costAmount: '25',
        creditedAt: createdAt,
        status: 'credited'
      })
    });
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        accountId,
        entryType: 'gift_card_credit',
        direction: 'credit',
        balanceBefore: '20',
        balanceAfter: '30',
        costBefore: '50',
        costAfter: '75',
        averageCostBefore: '2.5',
        averageCostAfter: '2.5',
        idempotencyKey: `gift_card_credit:${accountId}:request-12345678`
      })
    });
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith({
      where: { id: accountId },
      data: {
        currentBalance: '30',
        balanceCostAmount: '75',
        updatedByUserId: operator.id
      },
      select: {
        id: true,
        appleIdMasked: true,
        currentBalance: true,
        balanceCostAmount: true
      }
    });
    expect(result).toMatchObject({
      giftCard: {
        cardNameOptionId,
        cardName: '苹果礼品卡',
        countryOptionId,
        codeMasked: 'X123****CDEF',
        faceValue: '10',
        exchangeRate: '2.5',
        costAmount: '25'
      },
      ledgerEntry: {
        balanceBefore: '20',
        balanceAfter: '30',
        costBefore: '50',
        costAfter: '75'
      },
      account: {
        currentBalance: '30',
        balanceCostAmount: '75'
      },
      idempotentReplay: false
    });
    expect(tx.auditLog.create).toHaveBeenCalledOnce();
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('X123456789ABCDEF');
  });

  it('uses the first active card name for a rolling-release request without the new field', async () => {
    await service.confirmCredit(
      accountId,
      makeDto({
        cardNameOptionId: undefined
      }),
      operator
    );

    const cardNameLookup = tx.idBusinessV2Option.findFirst.mock.calls.find(
      ([input]) => input.where.type === 'gift_card_name'
    )?.[0];
    expect(cardNameLookup).toMatchObject({
      where: {
        id: undefined,
        type: 'gift_card_name',
        status: 'active',
        deletedAt: null
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
    });
    expect(tx.idBusinessV2GiftCard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        cardNameOptionId,
        cardNameSnapshot: '苹果礼品卡'
      })
    });
  });

  it('rejects a missing card name and a non-positive card rate before any balance write', async () => {
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'country') return { id: countryOptionId };
      if (where.type === 'gift_card_name') return null;
      return { id: supplierOptionId, name: '测试供应商' };
    });

    await expect(service.confirmCredit(accountId, makeDto(), operator)).rejects.toThrow(
      '卡片名称不存在或已停用'
    );
    expect(tx.idBusinessV2GiftCard.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();

    await expect(
      service.confirmCredit(accountId, makeDto({ exchangeRate: '0' }), operator)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('locks MYR payment evidence and debits the selected finance account', async () => {
    const financeAccountId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const result = await service.confirmCredit(
      accountId,
      makeDto({
        faceValue: '20',
        exchangeRate: undefined,
        purchaseOriginalAmount: '100',
        purchaseCurrency: 'MYR',
        purchaseFxRateToCny: '1.7',
        purchaseFinanceAccountId: financeAccountId,
        purchaseManualRateReason: '银行成交回单',
        paidAt: createdAt.toISOString()
      }),
      operator
    );

    expect(financeFxService.resolve).toHaveBeenCalledOnce();
    const fxInput = financeFxService.resolve.mock.calls[0]?.[0];
    expect(fxInput).toMatchObject({
      currency: 'MYR',
      manualReason: '银行成交回单'
    });
    expect(fxInput?.manualRate.toString()).toBe('1.7');
    expect(supplierFundsService.debitGiftCard).not.toHaveBeenCalled();
    expect(financePostingService.post).toHaveBeenCalledOnce();
    const [postingTx, postingInput] = financePostingService.post.mock.calls[0] ?? [];
    expect(postingTx).toBe(tx);
    expect(postingInput).toMatchObject({
      journalType: 'gift_card_purchase',
      lines: [
        expect.objectContaining({
          accountCode: 'gift_card_inventory',
          currency: 'MYR'
        }),
        expect.objectContaining({
          accountCode: 'cash',
          financeAccountId,
          currency: 'MYR'
        })
      ]
    });
    expect(
      postingInput?.lines.map((line: { amountOriginal: unknown }) => String(line.amountOriginal))
    ).toEqual(['100', '100']);
    expect(
      postingInput?.lines.map((line: { amountCny: unknown }) => String(line.amountCny))
    ).toEqual(['170', '170']);
    expect(result.giftCard).toMatchObject({
      purchaseOriginalAmount: '100',
      purchaseCurrency: 'MYR',
      purchaseFxRateToCny: '1.7',
      purchaseFinanceAccountId: financeAccountId,
      costAmount: '170'
    });
    expect(result.supplierFunding).toBeNull();
  });

  it('credits an active sold ID and keeps the gift-card cost in balance inventory', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      {
        id: accountId,
        appleIdMasked: 'us***@example.com',
        currentBalance: decimal('20'),
        balanceCostAmount: decimal('50'),
        soldByOrderId: '99999999-9999-4999-8999-999999999999',
        lossReportedAt: null,
        countryOptionId,
        countryName: '美国',
        currencyCode: 'USD'
      }
    ]);

    const result = await service.confirmCredit(accountId, makeDto(), operator);

    expect(tx.idBusinessV2GiftCard.create).toHaveBeenCalledOnce();
    expect(tx.idBusinessV2BalanceLedger.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          accountId,
          entryType: 'gift_card_credit',
          balanceBefore: '20',
          costBefore: '50'
        })
      })
    );
    expect(tx.idBusinessV2Account.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          currentBalance: '30',
          balanceCostAmount: '75'
        })
      })
    );
    expect(financePostingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        journalType: 'gift_card_purchase',
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'gift_card_inventory',
            direction: 'debit'
          })
        ])
      })
    );
    expect(result.account.currentBalance).toBe('30');
  });

  it('records a renewal-workbench source context without logging the gift-card plaintext', async () => {
    await service.confirmCredit(accountId, makeDto(), operator, {
      source: 'renewal_workbench',
      activationId: '77777777-7777-4777-8777-777777777777',
      orderId: '88888888-8888-4888-8888-888888888888',
      orderNo: 'V220260726RENEW001'
    });

    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.gift_card.credit',
        afterData: expect.objectContaining({
          sourceContext: {
            source: 'renewal_workbench',
            activationId: '77777777-7777-4777-8777-777777777777',
            orderId: '88888888-8888-4888-8888-888888888888',
            orderNo: 'V220260726RENEW001'
          }
        }),
        remark: 'V2 续费工作台礼品卡确认入账：X123****CDEF'
      })
    });
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('X123456789ABCDEF');
  });

  it('persists a validated automatic-rate snapshot and whether the operator changed it', async () => {
    const snapshotId = '66666666-6666-4666-8666-666666666666';
    const result = await service.confirmCredit(
      accountId,
      makeDto({
        exchangeRate: '2.6',
        exchangeRateSnapshotId: snapshotId,
        exchangeRatePrefilledValue: '2.5'
      }),
      operator
    );

    expect(exchangeRateQueryService.validatePrefill).toHaveBeenCalledWith(snapshotId, '2.5', '2.6');
    expect(tx.idBusinessV2GiftCard.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        exchangeRate: '2.6',
        exchangeRateSource: 'automatic_snapshot',
        exchangeRateSnapshotId: snapshotId,
        exchangeRatePrefilledValue: '2.5',
        exchangeRateWasOverridden: true
      })
    });
    expect(result.giftCard).toMatchObject({
      exchangeRate: '2.6',
      exchangeRateSource: 'automatic_snapshot',
      exchangeRateSnapshotId: snapshotId,
      exchangeRatePrefilledValue: '2.5',
      exchangeRateWasOverridden: true
    });
  });

  it('rejects a partial automatic-rate source instead of writing ambiguous audit data', async () => {
    await expect(
      service.confirmCredit(
        accountId,
        makeDto({
          exchangeRateSnapshotId: '66666666-6666-4666-8666-666666666666'
        }),
        operator
      )
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns a matching idempotent replay without double-crediting', async () => {
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue({
      ...makeLedger(),
      giftCard: makeGiftCard()
    });

    const result = await service.confirmCredit(accountId, makeDto(), operator);

    expect(result.idempotentReplay).toBe(true);
    expect(tx.idBusinessV2Option.findFirst).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GiftCard.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects reusing an idempotency key for different credit content', async () => {
    tx.idBusinessV2BalanceLedger.findUnique.mockResolvedValue({
      ...makeLedger(),
      giftCard: makeGiftCard()
    });

    await expect(
      service.confirmCredit(accountId, makeDto({ faceValue: '20' }), operator)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2GiftCard.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('rejects a gift card code that has already been credited', async () => {
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue({
      id: 'existing-gift-card'
    });

    await expect(service.confirmCredit(accountId, makeDto(), operator)).rejects.toBeInstanceOf(
      ConflictException
    );
    expect(tx.idBusinessV2BalanceLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('rejects an inactive or non-topup supplier', async () => {
    tx.idBusinessV2Option.findFirst.mockImplementation(async ({ where }) => {
      if (where.type === 'country') return { id: countryOptionId };
      if (where.type === 'gift_card_name') {
        return { id: cardNameOptionId, name: '苹果礼品卡' };
      }
      return null;
    });

    await expect(service.confirmCredit(accountId, makeDto(), operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(tx.idBusinessV2GiftCard.findUnique).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });

  it('rejects a card country that no longer matches the locked target ID', async () => {
    await expect(
      service.confirmCredit(
        accountId,
        makeDto({ countryOptionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }),
        operator
      )
    ).rejects.toThrow('卡片国家必须与目标 ID 当前国家一致');
    expect(tx.idBusinessV2Option.findFirst).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GiftCard.create).not.toHaveBeenCalled();
  });

  it('rejects a missing or disabled target account before any write', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(service.confirmCredit(accountId, makeDto(), operator)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(tx.idBusinessV2BalanceLedger.findUnique).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GiftCard.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2Account.update).not.toHaveBeenCalled();
  });
});
