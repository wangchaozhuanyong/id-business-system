import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinanceHistoryPreviewService } from './id-business-v2-finance-history-preview.service';

const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

describe('IdBusinessV2FinanceHistoryPreviewService', () => {
  const prisma = {
    idBusinessV2FinanceSettings: {
      findUnique: vi.fn()
    },
    idBusinessV2Order: {
      findMany: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2AccountLoss: {
      findMany: vi.fn()
    },
    idBusinessV2GiftCard: {
      findMany: vi.fn(),
      count: vi.fn()
    },
    idBusinessV2Account: {
      count: vi.fn()
    },
    idBusinessV2FinanceJournal: {
      findMany: vi.fn()
    }
  };
  const service = new IdBusinessV2FinanceHistoryPreviewService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2FinanceSettings.findUnique.mockResolvedValue({
      enabledAt: new Date('2026-07-30T00:00:00.000Z'),
      historyStatus: 'incomplete'
    });
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      order('order-create', '100'),
      order('order-existing', '80'),
      order('order-zero', '0')
    ]);
    prisma.idBusinessV2AccountLoss.findMany.mockResolvedValue([
      {
        id: 'loss-create',
        lossCostAmount: decimal('5'),
        idPurchaseCostLossAmount: decimal('0')
      }
    ]);
    prisma.idBusinessV2GiftCard.findMany.mockResolvedValue([
      { id: 'card-redeemed', status: 'redeemed', costAmount: decimal('20') },
      { id: 'card-withdrawn-existing', status: 'withdrawn', costAmount: decimal('30') },
      { id: 'card-withdrawn-zero', status: 'withdrawn', costAmount: decimal('0') }
    ]);
    prisma.idBusinessV2Account.count.mockResolvedValue(2);
    prisma.idBusinessV2GiftCard.count.mockResolvedValue(3);
    prisma.idBusinessV2Order.count.mockResolvedValue(4);
    prisma.idBusinessV2FinanceJournal.findMany.mockImplementation(({ where }) => {
      if (where.sourceType === 'order') {
        return Promise.resolve([{ sourceId: 'order-existing' }]);
      }
      if (where.sourceType === 'gift_card') {
        return Promise.resolve([{ sourceId: 'card-withdrawn-existing' }]);
      }
      return Promise.resolve([]);
    });
  });

  it('previews writes, existing sources, zero amounts and FX snapshot updates without mutation', async () => {
    const result = await service.preview();

    expect(result).toMatchObject({
      asOf: new Date('2026-07-30T00:00:00.000Z'),
      historyStatus: 'incomplete',
      canBackfill: true,
      assumption: 'legacy_assumed_cny',
      summary: {
        orders: {
          candidateCount: 3,
          willCreateCount: 1,
          skippedExistingCount: 1,
          skippedZeroAmountCount: 1
        },
        accountLosses: {
          candidateCount: 1,
          willCreateCount: 1,
          skippedExistingCount: 0,
          skippedZeroAmountCount: 0
        },
        redeemedGiftCards: {
          candidateCount: 1,
          willCreateCount: 1,
          skippedExistingCount: 0,
          skippedZeroAmountCount: 0
        },
        withdrawnGiftCards: {
          candidateCount: 2,
          willCreateCount: 0,
          skippedExistingCount: 1,
          skippedZeroAmountCount: 1
        }
      },
      fxSnapshotUpdates: {
        accounts: 2,
        giftCards: 3,
        orders: 4
      }
    });
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(prisma.idBusinessV2FinanceJournal.findMany).toHaveBeenCalledTimes(3);
  });

  it('marks completed history as unavailable for another backfill', async () => {
    prisma.idBusinessV2FinanceSettings.findUnique.mockResolvedValue({
      enabledAt: new Date('2026-07-30T00:00:00.000Z'),
      historyStatus: 'completed'
    });

    await expect(service.preview()).resolves.toMatchObject({
      historyStatus: 'completed',
      canBackfill: false
    });
  });

  it('reuses the requested cutoff when finance history has no fixed enabled time', async () => {
    const requestedAsOf = new Date('2026-07-30T02:30:00.000Z');
    prisma.idBusinessV2FinanceSettings.findUnique.mockResolvedValue({
      enabledAt: null,
      historyStatus: 'incomplete'
    });

    const result = await service.preview(requestedAsOf);

    expect(result.asOf).toEqual(requestedAsOf);
    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: { lte: requestedAsOf }
        })
      })
    );
  });
});

function order(id: string, receivedAmount: string) {
  return {
    id,
    status: 'completed',
    receivedAmount: decimal(receivedAmount),
    platformFeeAmount: decimal('0'),
    balanceCostAmount: decimal('0'),
    accountCostAmount: decimal('0'),
    accountDisposition: 'retained',
    refundCostAmount: null
  };
}
