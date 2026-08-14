import { Prisma } from '@prisma/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2TopupSupplierFundsQueryService } from './id-business-v2-topup-supplier-funds-query.service';
import { IdBusinessV2TopupSupplierQueryRepository } from './persistence/id-business-v2-topup-supplier-query.repository';

const supplierOptionId = '11111111-1111-4111-8111-111111111111';
const supplierAccountId = '22222222-2222-4222-8222-222222222222';
const createdAt = new Date('2026-07-29T12:00:00.000Z');

function decimal(value: Prisma.Decimal.Value) {
  return new Prisma.Decimal(value);
}

describe('IdBusinessV2TopupSupplierFundsQueryService', () => {
  const prisma = {
    $transaction: vi.fn(),
    idBusinessV2TopupSupplierPayment: {
      findMany: vi.fn(),
      count: vi.fn(),
      aggregate: vi.fn()
    }
  };
  const service = new IdBusinessV2TopupSupplierFundsQueryService(
    new IdBusinessV2TopupSupplierQueryRepository(prisma as never),
    { decrypt: vi.fn() } as never,
    { resolveDisplayMode: vi.fn() } as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.$transaction.mockImplementation(async (promises) => Promise.all(promises));
    prisma.idBusinessV2TopupSupplierPayment.count.mockResolvedValue(2);
    prisma.idBusinessV2TopupSupplierPayment.aggregate.mockResolvedValue({
      _sum: {
        paidAmount: decimal('1000'),
        networkFeeAmount: decimal('1.5'),
        creditedCny: decimal('6800')
      }
    });
    const supplierAccount = {
      id: supplierAccountId,
      supplierOptionId,
      supplierOption: {
        id: supplierOptionId,
        code: 'supplier_a',
        name: '供应商 A'
      }
    };
    const common = {
      supplierAccount,
      supplierNameSnapshot: '供应商 A',
      paidCurrency: 'USDT',
      paidAmount: decimal('1000'),
      networkFeeAmount: decimal('1.5'),
      fxRateToCny: decimal('6.8'),
      creditedAmount: decimal('1000'),
      creditedCny: decimal('6800'),
      receivedUsdt: decimal('1000'),
      networkFeeUsdt: decimal('1.5'),
      settlementRateCnyUsdt: decimal('6.8'),
      network: 'TRC20',
      transactionHash: 'hash',
      paidAt: createdAt,
      createdAt,
      remark: null,
      createdBy: null
    };
    prisma.idBusinessV2TopupSupplierPayment.findMany.mockResolvedValue([
      {
        id: '33333333-3333-4333-8333-333333333333',
        ...common,
        ledgerEntries: [
          {
            id: '55555555-5555-4555-8555-555555555555',
            entryType: 'payment_credit',
            amountCny: decimal('6800'),
            balanceBeforeCny: decimal('0'),
            balanceAfterCny: decimal('6800'),
            reversedBy: null,
            reason: null,
            createdAt
          }
        ]
      },
      {
        id: '44444444-4444-4444-8444-444444444444',
        ...common,
        ledgerEntries: [
          {
            id: '66666666-6666-4666-8666-666666666666',
            entryType: 'payment_credit',
            amountCny: decimal('6800'),
            balanceBeforeCny: decimal('6800'),
            balanceAfterCny: decimal('13600'),
            reversedBy: {
              id: '77777777-7777-4777-8777-777777777777',
              reason: '付款录错',
              createdAt
            },
            reason: null,
            createdAt
          },
          {
            id: '77777777-7777-4777-8777-777777777777',
            entryType: 'payment_reversal',
            amountCny: decimal('6800'),
            balanceBeforeCny: decimal('13600'),
            balanceAfterCny: decimal('6800'),
            reversedBy: null,
            reason: '付款录错',
            createdAt
          }
        ]
      }
    ]);
  });

  it('reports active-payment totals and excludes reversed payments from the weighted average', async () => {
    const result = await service.listPaymentRecords({});

    expect(result.summary).toEqual({
      activeReceivedUsdt: '1000',
      activeNetworkFeeUsdt: '1.5',
      activeCreditedCny: '6800',
      weightedAverageRate: '6.80000000'
    });
    expect(result.items.map((item) => item.status)).toEqual(['active', 'reversed']);
    expect(prisma.idBusinessV2TopupSupplierPayment.aggregate).toHaveBeenCalledWith({
      where: expect.objectContaining({
        paidCurrency: 'USDT',
        ledgerEntries: {
          some: {
            entryType: 'payment_credit',
            reversedBy: null
          }
        }
      }),
      _sum: {
        paidAmount: true,
        creditedCny: true,
        networkFeeAmount: true
      }
    });
  });
});
