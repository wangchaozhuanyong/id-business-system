import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as MysqlPrisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Amount4, Rate8, V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';

const platformId = '11111111-1111-4111-8111-111111111111';
const orderId = '22222222-2222-4222-8222-222222222222';
const pendingOrderId = '33333333-3333-4333-8333-333333333333';
const historicalOrderId = '44444444-4444-4444-8444-444444444444';

function decimal(value: Prisma.Decimal.Value) {
  return new MysqlPrisma.Decimal(String(value));
}

function line(
  accountCode: string,
  direction: 'debit' | 'credit',
  amountCny: string,
  currency: 'CNY' | 'MYR' | 'USD' | 'USDT' = 'CNY',
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
  const service = createReportsService(prisma);

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
            lt: new Date('2026-07-31T16:00:00.000Z')
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
          { currency: 'USD', grossReceived: '0', refunded: '0' },
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
          { currency: 'USD', grossReceived: '0', refunded: '0' },
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

  it('keeps refunded cash history without counting the order as currently completed', async () => {
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      {
        id: orderId,
        status: 'refunded',
        settlementPlatformOptionId: platformId,
        settlementPlatform: {
          id: platformId,
          name: '微信转账'
        },
        receivedAmount: decimal('100'),
        profitAmount: decimal('-48')
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
      }
    ]);

    const result = await service.settlementPlatformReport({});

    expect(result.totals).toMatchObject({
      completedOrderCount: 0,
      grossReceivedCny: '100',
      refundedCny: '100',
      netSettlementCny: '-3'
    });
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

  it('normalizes MySQL Prisma decimals while calculating assets', async () => {
    const assetPrisma = {
      idBusinessV2FinanceAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            currency: 'CNY',
            currentBalance: decimal('100'),
            currentBalanceCny: decimal('100')
          }
        ])
      },
      idBusinessV2TopupSupplierAccount: {
        findMany: vi.fn().mockResolvedValue([
          {
            currency: 'MYR',
            currentBalance: decimal('10'),
            currentBalanceCny: decimal('20')
          }
        ])
      },
      idBusinessV2Account: {
        aggregate: vi
          .fn()
          .mockResolvedValueOnce({
            _sum: {
              balanceCostAmount: decimal('5'),
              purchaseCost: decimal('9')
            }
          })
          .mockResolvedValueOnce({
            _sum: {
              balanceCostAmount: decimal('11')
            }
          })
          .mockResolvedValueOnce({
            _sum: {
              purchaseCost: decimal('7')
            }
          })
      },
      idBusinessV2GiftCard: {
        aggregate: vi.fn().mockResolvedValue({
          _sum: {
            supplierRefundAmountCny: decimal('3')
          }
        })
      },
      idBusinessV2FinanceFxRateSnapshot: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: '55555555-5555-4555-8555-555555555555',
            currency: 'MYR',
            rateToCny: decimal('2'),
            capturedAt: new Date('2026-07-29T00:00:00.000Z'),
            expiresAt: null
          }
        ])
      }
    };
    const assetService = createReportsService(assetPrisma);

    await expect(assetService.assets()).resolves.toMatchObject({
      cashCny: '100',
      supplierPrepaymentCny: '20',
      giftCardInventoryCny: '5',
      customerOwnedBalanceCostCny: '11',
      unsoldIdInventoryCny: '7',
      supplierRefundReceivableCny: '3',
      totalBookValueCny: '135',
      totalLatestValuationCny: '135',
      unrealizedFxChangeCny: '0'
    });
  });

  it('uses posted ledger lines for the customer-owned after-sales report and keeps ID cost zero', async () => {
    const reportPrisma = {
      idBusinessV2Order: {
        findMany: vi
          .fn()
          .mockResolvedValueOnce([{ id: orderId }])
          .mockResolvedValueOnce([
            {
              receivedAmount: decimal('100'),
              platformFeeAmount: decimal('5'),
              balanceAmount: decimal('20'),
              profitAmount: null,
              account: {
                currentBalance: decimal('100'),
                balanceCostAmount: decimal('50')
              }
            },
            {
              receivedAmount: decimal('50'),
              platformFeeAmount: decimal('0'),
              balanceAmount: decimal('10'),
              profitAmount: decimal('-5'),
              account: {
                currentBalance: decimal('80'),
                balanceCostAmount: decimal('40')
              }
            }
          ])
      },
      idBusinessV2FinanceJournal: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'journal-completed',
            sourceId: orderId,
            journalType: 'order_completed',
            reversalOf: null,
            lines: [
              line('sales_revenue', 'credit', '100'),
              line('platform_fee', 'debit', '3'),
              line('gift_card_cost', 'debit', '40')
            ]
          },
          {
            id: 'journal-refund',
            sourceId: orderId,
            journalType: 'order_refund',
            reversalOf: null,
            lines: [line('sales_revenue', 'debit', '20'), line('refund_loss', 'debit', '5')]
          }
        ])
      }
    };

    await expect(createReportsService(reportPrisma).afterSales({})).resolves.toEqual({
      completedOrderCount: 1,
      grossRevenueCny: '100',
      refundedRevenueCny: '20',
      platformFeeCny: '3',
      balanceCostCny: '40',
      idCostCny: '0',
      refundLossCny: '5',
      netProfitCny: '32',
      pendingOrderCount: 2,
      pendingRevenueCny: '150',
      pendingProfitCny: '80'
    });
  });
});

describe('IdBusinessV2FinanceReportsService manual inflow reporting', () => {
  it('只将经营收入计入利润，股东投入和借入资金不进入损益', async () => {
    const repository = {
      groupProfitLoss: vi.fn().mockResolvedValue([
        { accountCode: 'sales_revenue', direction: 'credit', amountCny: Amount4.from('100') },
        {
          accountCode: 'other_operating_revenue',
          direction: 'credit',
          amountCny: Amount4.from('20')
        },
        { accountCode: 'operating_expense', direction: 'debit', amountCny: Amount4.from('30') },
        {
          accountCode: 'contributed_capital',
          direction: 'credit',
          amountCny: Amount4.from('500')
        },
        {
          accountCode: 'borrowed_funds_payable',
          direction: 'credit',
          amountCny: Amount4.from('200')
        }
      ]),
      estimatedPendingProfit: vi.fn().mockResolvedValue(Amount4.from('5'))
    };
    const service = new IdBusinessV2FinanceReportsService({} as never, repository as never);

    await expect(service.profitLoss({})).resolves.toMatchObject({
      salesRevenueCny: '100',
      otherOperatingRevenueCny: '20',
      totalOperatingRevenueCny: '120',
      operatingExpenseCny: '30',
      netProfitCny: '90',
      estimatedProfitCny: '5'
    });
  });

  it('按币种拆分经营收入、股东投入和借入资金，同时保留总现金流', async () => {
    const repository = {
      groupCashFlow: vi.fn().mockResolvedValue([
        { currency: 'CNY', direction: 'debit', amountOriginal: Amount4.from('180') },
        { currency: 'CNY', direction: 'credit', amountOriginal: Amount4.from('30') }
      ]),
      groupManualInflows: vi.fn().mockResolvedValue([
        {
          accountCode: 'other_operating_revenue',
          currency: 'CNY',
          direction: 'debit',
          amountOriginal: Amount4.from('50')
        },
        {
          accountCode: 'contributed_capital',
          currency: 'CNY',
          direction: 'debit',
          amountOriginal: Amount4.from('100')
        },
        {
          accountCode: 'borrowed_funds_payable',
          currency: 'CNY',
          direction: 'debit',
          amountOriginal: Amount4.from('30')
        }
      ]),
      loadLatestRateRows: vi
        .fn()
        .mockResolvedValue(
          new Map([['MYR', { id: 'myr-rate', rateToCny: Rate8.from('1.6'), expiresAt: null }]])
        )
    };
    const service = new IdBusinessV2FinanceReportsService({} as never, repository as never);

    const result = await service.currencyBreakdown({});

    expect(result[0]).toEqual({
      currency: 'CNY',
      income: '180',
      manualOperatingIncome: '50',
      capitalContribution: '100',
      borrowedFunds: '30',
      expense: '30',
      netCashFlow: '150',
      latestRateToCny: '1',
      netCashFlowCny: '150'
    });
  });
});

describe('IdBusinessV2FinanceReportRepository manual inflow mapping', () => {
  it('根据原凭证类型识别正常流入和冲销流出', async () => {
    const prisma = {
      idBusinessV2FinanceJournalLine: {
        findMany: vi.fn().mockResolvedValue([
          {
            currency: 'CNY',
            direction: 'debit',
            amountOriginal: decimal('100'),
            journal: { journalType: 'capital_contribution', reversalOf: null }
          },
          {
            currency: 'CNY',
            direction: 'credit',
            amountOriginal: decimal('100'),
            journal: {
              journalType: 'reversal',
              reversalOf: { journalType: 'capital_contribution' }
            }
          }
        ])
      }
    };
    const repository = new IdBusinessV2FinanceReportRepository(prisma as never);

    await expect(repository.groupManualInflows({})).resolves.toEqual([
      {
        accountCode: 'contributed_capital',
        currency: 'CNY',
        direction: 'debit',
        amountOriginal: Amount4.from('100')
      },
      {
        accountCode: 'contributed_capital',
        currency: 'CNY',
        direction: 'credit',
        amountOriginal: Amount4.from('100')
      }
    ]);
  });
});

function createReportsService(prisma: object) {
  return new IdBusinessV2FinanceReportsService(
    new V2CommandTransactionManager(prisma as never),
    new IdBusinessV2FinanceReportRepository(prisma as never)
  );
}
