import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';

const platformId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const pendingOrderId = '33333333-3333-4333-8333-333333333333';
const historicalOrderId = '44444444-4444-4444-8444-444444444444';

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

function line(
  accountCode: string,
  direction: 'debit' | 'credit',
  amountCny: string,
  currency: 'CNY' | 'MYR' | 'USDT' = 'CNY',
  amountOriginal = amountCny
) {
  return {
    accountCode,
    direction,
    currency,
    amountOriginal: decimal(amountOriginal),
    amountCny: decimal(amountCny)
  };
}

describe('IdBusinessV2FinanceReportsService settlement platform report', () => {
  const prisma = {
    idBusinessV2Option: {
      findMany: vi.fn()
    },
    idBusinessV2Order: {
      findMany: vi.fn()
    },
    idBusinessV2FinanceJournal: {
      findMany: vi.fn()
    }
  };
  const service = new IdBusinessV2FinanceReportsService(prisma as never);

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.idBusinessV2Option.findMany.mockResolvedValue([
      {
        id: platformId,
        name: '微信转账'
      }
    ]);
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      {
        id: orderId,
        status: 'completed',
        settlementPlatformOptionId: platformId,
        settlementPlatform: {
          id: platformId,
          name: '微信转账'
        },
        receivedAmount: decimal('100'),
        profitAmount: decimal('57')
      },
      {
        id: pendingOrderId,
        status: 'processing',
        settlementPlatformOptionId: platformId,
        settlementPlatform: {
          id: platformId,
          name: '微信转账'
        },
        receivedAmount: decimal('120'),
        profitAmount: decimal('25')
      },
      {
        id: historicalOrderId,
        status: 'completed',
        settlementPlatformOptionId: null,
        settlementPlatform: null,
        receivedAmount: decimal('50'),
        profitAmount: decimal('30')
      }
    ]);
    prisma.idBusinessV2FinanceJournal.findMany.mockResolvedValue([
      {
        journalType: 'order_completed',
        sourceId: orderId,
        reversalOf: null,
        lines: [
          line('sales_revenue', 'credit', '100'),
          line('platform_fee', 'debit', '3'),
          line('gift_card_cost', 'debit', '40')
        ]
      },
      {
        journalType: 'order_refund',
        sourceId: orderId,
        reversalOf: null,
        lines: [line('sales_revenue', 'debit', '100'), line('refund_loss', 'debit', '5')]
      },
      {
        journalType: 'reversal',
        sourceId: orderId,
        reversalOf: {
          sourceId: orderId,
          journalType: 'order_refund'
        },
        lines: [line('sales_revenue', 'credit', '100'), line('refund_loss', 'credit', '5')]
      },
      {
        journalType: 'order_completed',
        sourceId: historicalOrderId,
        reversalOf: null,
        lines: [
          line('sales_revenue', 'credit', '50', 'MYR', '20'),
          line('gift_card_cost', 'debit', '20')
        ]
      }
    ]);
  });

  it('aggregates posted completions, refunds, reversals and pending estimates by platform', async () => {
    const result = await service.settlementPlatformReport({
      dateFrom: '2026-07-01',
      dateTo: '2026-07-31'
    });

    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-06-30T16:00:00.000Z'),
            lte: new Date('2026-07-31T15:59:59.999Z')
          }
        })
      })
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        settlementPlatform: {
          id: platformId,
          name: '微信转账'
        },
        completedOrderCount: 1,
        grossReceivedCny: '100',
        refundedCny: '0',
        platformFeeCny: '3',
        netSettlementCny: '97',
        realizedProfitCny: '57',
        realizedProfitRate: '57',
        pendingOrderCount: 1,
        pendingReceivedCny: '120',
        pendingProfitCny: '25',
        originalAmounts: [
          { currency: 'CNY', grossReceived: '100', refunded: '0' },
          { currency: 'MYR', grossReceived: '0', refunded: '0' },
          { currency: 'USDT', grossReceived: '0', refunded: '0' }
        ]
      }),
      expect.objectContaining({
        settlementPlatform: null,
        completedOrderCount: 1,
        grossReceivedCny: '50',
        realizedProfitCny: '30',
        originalAmounts: [
          { currency: 'CNY', grossReceived: '0', refunded: '0' },
          { currency: 'MYR', grossReceived: '20', refunded: '0' },
          { currency: 'USDT', grossReceived: '0', refunded: '0' }
        ]
      })
    ]);
    expect(result.totals).toMatchObject({
      completedOrderCount: 2,
      grossReceivedCny: '150',
      refundedCny: '0',
      platformFeeCny: '3',
      netSettlementCny: '147',
      realizedProfitCny: '87',
      realizedProfitRate: '58',
      pendingOrderCount: 1,
      pendingReceivedCny: '120',
      pendingProfitCny: '25'
    });
    expect(result.hasHistoricalUnspecified).toBe(true);
    expect(result.historicalUnspecifiedAmountCny).toBe('50');
  });

  it('applies the platform filter only to the settlement-platform order query', async () => {
    prisma.idBusinessV2Order.findMany.mockResolvedValue([]);

    await service.settlementPlatformReport({
      settlementPlatformOptionId: platformId
    });

    expect(prisma.idBusinessV2Order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          settlementPlatformOptionId: platformId
        })
      })
    );
    expect(prisma.idBusinessV2FinanceJournal.findMany).not.toHaveBeenCalled();
  });

  it('rejects malformed settlement platform filters', async () => {
    await expect(
      service.settlementPlatformReport({
        settlementPlatformOptionId: 'not-a-uuid'
      })
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
