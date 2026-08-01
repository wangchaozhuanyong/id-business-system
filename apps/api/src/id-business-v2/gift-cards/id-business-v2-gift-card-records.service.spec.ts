import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2GiftCardRecordsService } from './id-business-v2-gift-card-records.service';
import { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const accountId = '11111111-1111-4111-8111-111111111111';
const giftCardId = '22222222-2222-4222-8222-222222222222';
const supplierOptionId = '33333333-3333-4333-8333-333333333333';
const ledgerEntryId = '44444444-4444-4444-8444-444444444444';
const cardNameOptionId = '77777777-7777-4777-8777-777777777777';
const operator = {
  id: '55555555-5555-4555-8555-555555555555',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.balance.adjust']
};
const country = {
  id: '66666666-6666-4666-8666-666666666666',
  code: 'US',
  name: '美国'
};
const cardName = {
  id: cardNameOptionId,
  code: 'apple_gift_card',
  name: '苹果礼品卡'
};
const createdAt = new Date('2026-07-26T12:00:00.000Z');
const reversedAt = new Date('2026-07-26T13:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function makeGiftCardRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: giftCardId,
    accountId,
    cardNameOptionId,
    cardNameSnapshot: cardName.name,
    supplierOptionId,
    sourceAttachmentId: '88888888-8888-4888-8888-888888888888',
    codeEncrypted: 'v1:must-not-leak',
    codeHash: 'must-not-leak',
    codeMasked: 'X123****CDEF',
    codeTail: 'CDEF',
    faceValue: decimal('20'),
    exchangeRate: decimal('5.4'),
    exchangeRateSource: 'manual',
    exchangeRateSnapshotId: null,
    exchangeRatePrefilledValue: null,
    exchangeRateWasOverridden: false,
    costAmount: decimal('108'),
    purchaseOriginalAmount: decimal('108'),
    purchaseCurrency: 'CNY',
    purchaseFxRateToCny: decimal('1'),
    purchaseFxSnapshotId: null,
    purchaseFinanceAccountId: null,
    purchaseSupplierAccountId: null,
    paidAt: null,
    supplierRefundStatus: 'none',
    supplierRefundAmount: decimal('0'),
    supplierRefundAmountCny: decimal('0'),
    supplierRefundClosedAt: null,
    countryOptionId: country.id,
    countryNameSnapshot: country.name,
    currencyCodeSnapshot: 'USD',
    supplierNameSnapshot: '供应商 A',
    status: 'credited',
    statusChangedAt: createdAt,
    creditedAt: createdAt,
    remark: '首批加卡',
    createdByUserId: operator.id,
    updatedByUserId: operator.id,
    createdAt,
    updatedAt: createdAt,
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      lossReportedAt: null,
      countryOption: country
    },
    supplierOption: {
      id: supplierOptionId,
      code: 'topup_supplier_a',
      name: '供应商 A'
    },
    cardNameOption: cardName,
    countryOption: {
      ...country,
      currencyCode: 'USD'
    },
    createdBy: operator,
    updatedBy: operator,
    ledgerEntries: [
      {
        id: ledgerEntryId,
        balanceBefore: decimal('130'),
        balanceAfter: decimal('150'),
        costBefore: decimal('702'),
        costAfter: decimal('810'),
        averageCostBefore: decimal('5.4'),
        averageCostAfter: decimal('5.4'),
        createdAt,
        reversedByEntry: null
      }
    ],
    supplierFundEntries: [],
    ...overrides
  };
}

function makeLedgerRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: ledgerEntryId,
    accountId,
    giftCardId,
    entryType: 'gift_card_credit',
    direction: 'credit',
    balanceAmount: decimal('20'),
    costAmount: decimal('108'),
    balanceBefore: decimal('130'),
    balanceAfter: decimal('150'),
    costBefore: decimal('702'),
    costAfter: decimal('810'),
    averageCostBefore: decimal('5.4'),
    averageCostAfter: decimal('5.4'),
    reversalOfEntryId: null,
    idempotencyKey: 'must-not-leak',
    remark: '加卡入账',
    createdByUserId: operator.id,
    createdAt,
    account: {
      id: accountId,
      appleIdMasked: 'us***@example.com',
      countryOption: country
    },
    giftCard: {
      id: giftCardId,
      codeEncrypted: 'v1:must-not-leak',
      codeMasked: 'X123****CDEF',
      codeTail: 'CDEF',
      faceValue: decimal('20'),
      status: 'credited',
      supplierOption: {
        id: supplierOptionId,
        code: 'topup_supplier_a',
        name: '供应商 A'
      }
    },
    reversalOfEntry: null,
    reversedByEntry: null,
    createdBy: operator,
    ...overrides
  };
}

describe('IdBusinessV2GiftCardRecordsService', () => {
  const tx = {
    idBusinessV2GiftCard: {
      findUnique: vi.fn(),
      update: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2GiftCard: {
      findMany: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2BalanceLedger: {
      findMany: vi.fn(),
      count: vi.fn()
    }
  };
  const optionsService = {
    requireActiveOption: vi.fn()
  };
  const fieldEncryptionService = {
    decrypt: vi.fn()
  };
  const service = new IdBusinessV2GiftCardRecordsService(
    new IdBusinessV2GiftCardsRepository(prisma as never),
    optionsService as never,
    fieldEncryptionService as never,
    new V2CommandTransactionManager(prisma as never)
  );

  beforeEach(() => {
    vi.resetAllMocks();
    prisma.$transaction.mockImplementation(async (input) =>
      typeof input === 'function' ? input(tx) : Promise.all(input)
    );
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([makeGiftCardRecord()]);
    prisma.idBusinessV2GiftCard.count.mockResolvedValue(1);
    prisma.idBusinessV2BalanceLedger.findMany.mockResolvedValue([makeLedgerRecord()]);
    prisma.idBusinessV2BalanceLedger.count.mockResolvedValue(1);
    fieldEncryptionService.decrypt.mockReturnValue('X123456789ABCDEF');
    optionsService.requireActiveOption.mockResolvedValue({
      id: supplierOptionId,
      type: 'topup_supplier',
      code: 'topup_supplier_a',
      name: '供应商 A',
      parentId: null
    });
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue({
      id: giftCardId,
      codeMasked: 'X123****CDEF',
      supplierOptionId: null,
      remark: null,
      account: {
        lossReportedAt: null
      }
    });
    tx.idBusinessV2GiftCard.update.mockResolvedValue(makeGiftCardRecord());
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('returns paginated gift card records with full codes and ID balance snapshots', async () => {
    const result = await service.listGiftCards({ page: '2', pageSize: '20' });

    expect(prisma.idBusinessV2GiftCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        orderBy: [{ creditedAt: 'desc' }, { id: 'desc' }]
      })
    );
    expect(result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 20,
      items: [
        {
          id: giftCardId,
          code: 'X123456789ABCDEF',
          codeMasked: 'X123****CDEF',
          faceValue: '20',
          exchangeRate: '5.4',
          costAmount: '108',
          status: 'credited',
          cardNameOptionId,
          cardName,
          creditedAt: createdAt,
          hasSupplierFunding: false,
          creditedLedger: {
            balanceBefore: '130',
            balanceAfter: '150',
            costBefore: '702',
            costAfter: '810'
          },
          account: {
            appleIdMasked: 'us***@example.com',
            lossStatus: 'active',
            lossReportedAt: null
          }
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('codeEncrypted');
    expect(JSON.stringify(result)).not.toContain('codeHash');
    expect(JSON.stringify(result)).not.toContain('balanceBeforeCny');
    expect(JSON.stringify(result)).not.toContain('balanceAfterCny');
    expect(fieldEncryptionService.decrypt).toHaveBeenCalledWith('v1:must-not-leak');
  });

  it('exposes only supplier-funding existence without leaking supplier balance snapshots', async () => {
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([
      makeGiftCardRecord({
        supplierFundEntries: [{ id: '99999999-9999-4999-8999-999999999999' }]
      })
    ]);

    const result = await service.listGiftCards({});

    expect(result.items[0]?.hasSupplierFunding).toBe(true);
    expect(JSON.stringify(result)).not.toContain('supplierFunding');
    expect(JSON.stringify(result)).not.toContain('balanceBeforeCny');
    expect(JSON.stringify(result)).not.toContain('balanceAfterCny');
  });

  it('marks gift-card records whose ID has been permanently reported lost', async () => {
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([
      makeGiftCardRecord({
        account: {
          id: accountId,
          appleIdMasked: 'us***@example.com',
          lossReportedAt: reversedAt,
          countryOption: country
        }
      })
    ]);

    const result = await service.listGiftCards({});

    expect(result.items[0]?.account).toMatchObject({
      lossStatus: 'reported',
      lossReportedAt: reversedAt
    });
  });

  it('exposes reversal evidence without replacing the original credit record', async () => {
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([
      makeGiftCardRecord({
        status: 'redeemed',
        ledgerEntries: [
          {
            ...makeGiftCardRecord().ledgerEntries[0],
            reversedByEntry: {
              id: '77777777-7777-4777-8777-777777777777',
              entryType: 'gift_card_redeemed',
              balanceAmount: decimal('20'),
              costAmount: decimal('108'),
              remark: '供应商确认已被其他账号兑换',
              createdAt: reversedAt
            }
          }
        ]
      })
    ]);

    const result = await service.listGiftCards({});

    expect(result.items[0]).toMatchObject({
      status: 'redeemed',
      creditedLedger: {
        id: ledgerEntryId
      },
      reversal: {
        entryType: 'gift_card_redeemed',
        balanceAmount: '20',
        reason: '供应商确认已被其他账号兑换'
      }
    });
  });

  it('applies record filters, inclusive date range and whitelisted sorting', async () => {
    await service.listGiftCards({
      keyword: 'CDEF',
      accountId,
      cardNameOptionId,
      countryOptionId: country.id,
      supplierOptionId,
      status: 'credited',
      dateFrom: '2026-07-25',
      dateTo: '2026-07-26',
      sortBy: 'faceValue',
      sortOrder: 'asc'
    });

    expect(prisma.idBusinessV2GiftCard.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          accountId,
          cardNameOptionId,
          supplierOptionId,
          status: 'credited',
          countryOptionId: country.id,
          creditedAt: {
            gte: new Date('2026-07-25T00:00:00.000Z'),
            lte: new Date('2026-07-26T23:59:59.999Z')
          },
          OR: expect.any(Array)
        }),
        orderBy: [{ faceValue: 'asc' }, { id: 'desc' }]
      })
    );
  });

  it('returns complete ledger snapshots and hides internal idempotency keys', async () => {
    const result = await service.listBalanceLedger({});

    expect(result.items[0]).toMatchObject({
      id: ledgerEntryId,
      entryType: 'gift_card_credit',
      direction: 'credit',
      balanceAmount: '20',
      costAmount: '108',
      balanceBefore: '130',
      balanceAfter: '150',
      costBefore: '702',
      costAfter: '810',
      averageCostBefore: '5.4',
      averageCostAfter: '5.4',
      giftCard: {
        code: 'X123456789ABCDEF',
        codeMasked: 'X123****CDEF'
      },
      operator: {
        displayName: '管理员'
      }
    });
    expect(JSON.stringify(result)).not.toContain('idempotencyKey');
  });

  it('validates statuses, entry types, UUID filters and dates before querying', async () => {
    await expect(service.listGiftCards({ status: 'normal' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.listBalanceLedger({ entryType: 'manual_success' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await service.listBalanceLedger({ entryType: 'account_loss' });
    expect(prisma.idBusinessV2BalanceLedger.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ entryType: 'account_loss' })
      })
    );
    await expect(service.listGiftCards({ accountId: 'not-an-id' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(
      service.listGiftCards({ dateFrom: '2026-07-27', dateTo: '2026-07-26' })
    ).rejects.toThrow('开始日期不能晚于结束日期');
    expect(prisma.idBusinessV2GiftCard.findMany).not.toHaveBeenCalled();
  });

  it('updates only remark metadata and writes the audit in one transaction', async () => {
    const result = await service.updateMetadata(
      giftCardId,
      {
        remark: '供应商复核完成'
      },
      operator
    );

    expect(optionsService.requireActiveOption).not.toHaveBeenCalled();
    expect(tx.idBusinessV2GiftCard.update).toHaveBeenCalledWith({
      where: { id: giftCardId },
      data: {
        remark: '供应商复核完成',
        updatedByUserId: operator.id
      },
      include: expect.any(Object)
    });
    const updateData = tx.idBusinessV2GiftCard.update.mock.calls[0][0].data;
    expect(updateData).not.toHaveProperty('faceValue');
    expect(updateData).not.toHaveProperty('exchangeRate');
    expect(updateData).not.toHaveProperty('costAmount');
    expect(updateData).not.toHaveProperty('status');
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'id_business_v2.gift_card.metadata_update',
        objectId: giftCardId,
        afterData: expect.objectContaining({
          financialFieldsChanged: false
        })
      })
    });
    expect(result.codeMasked).toBe('X123****CDEF');
    expect(result.code).toBe('X123456789ABCDEF');
    expect(JSON.stringify(tx.auditLog.create.mock.calls)).not.toContain('X123456789ABCDEF');
  });

  it('rejects supplier changes through ordinary metadata updates', async () => {
    await expect(
      service.updateMetadata(
        giftCardId,
        {
          supplierOptionId,
          remark: '不能绕过资金更正'
        },
        operator
      )
    ).rejects.toThrow('供应商不能作为普通信息修改');
    expect(tx.idBusinessV2GiftCard.update).not.toHaveBeenCalled();
  });

  it('rejects empty metadata updates and missing records', async () => {
    await expect(service.updateMetadata(giftCardId, {}, operator)).rejects.toThrow(
      '至少提交一个可修改字段'
    );

    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue(null);
    await expect(
      service.updateMetadata(giftCardId, { remark: '需要复核' }, operator)
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.idBusinessV2GiftCard.update).not.toHaveBeenCalled();
    expect(tx.auditLog.create).not.toHaveBeenCalled();
  });

  it('rejects metadata changes after the related ID is permanently reported lost', async () => {
    tx.idBusinessV2GiftCard.findUnique.mockResolvedValue({
      id: giftCardId,
      codeMasked: 'X123****CDEF',
      supplierOptionId: null,
      remark: null,
      account: {
        lossReportedAt: reversedAt
      }
    });

    await expect(
      service.updateMetadata(giftCardId, { remark: '报损后不得修改' }, operator)
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2GiftCard.update).not.toHaveBeenCalled();
  });
});
