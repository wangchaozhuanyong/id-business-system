import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildIdBusinessV2GoogleSheetsReports } from './id-business-v2-google-sheets-report';

const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);

describe('Google Sheets business report mapping', () => {
  it('exports bank-recharge finance accounts using Chinese labels and exact decimals', () => {
    const accounts = [
      'bank_recharge_revenue',
      'bank_recharge_service_fee',
      'bank_recharge_cost',
      'bank_recharge_bank_fee'
    ] as const;
    const reports = buildIdBusinessV2GoogleSheetsReports({
      orders: [],
      giftCards: [],
      renewals: [],
      financeJournals: [
        {
          businessDate: new Date('2026-09-27T00:00:00Z'),
          lines: accounts.map((accountCode) => ({
            accountCode,
            direction: 'credit' as const,
            amountCny: decimal('0.1001')
          }))
        }
      ]
    });
    expect(
      reports[3]?.rows
        .slice(1)
        .map((row) => row[1])
        .sort()
    ).toEqual(['银充代付收入', '银充服务费收入', '银充代付成本', '银充银行手续费'].sort());
    for (const row of reports[3]!.rows.slice(1)) expect(row[3]).toBe('0.1001');
  });
  it('builds the four fixed reports without selecting sensitive account or card credentials', () => {
    const now = new Date('2026-09-05T08:00:00.000Z');
    const reports = buildIdBusinessV2GoogleSheetsReports({
      orders: [
        {
          id: 'order-id',
          orderNo: 'ORD-1001',
          customer: { name: '测试客户' },
          serviceOption: { name: '一年服务', parent: { name: '订阅' } },
          settlementPlatform: { name: '银行转账' },
          receivedAmount: decimal('100'),
          receivedOriginalAmount: decimal('100'),
          receivedCurrency: 'CNY',
          platformFeeAmount: decimal('2'),
          appliedAccountCostAmount: decimal('10'),
          appliedBalanceCostAmount: decimal('20'),
          refundCostAmount: null,
          profitAmount: decimal('68'),
          status: 'completed',
          accountSource: 'inventory',
          accountDisposition: 'sold',
          openedAt: now,
          dueAt: now,
          createdAt: now,
          updatedAt: now
        }
      ],
      giftCards: [
        {
          id: '12345678-sensitive-tail',
          cardNameSnapshot: '礼品卡',
          countryNameSnapshot: '美国',
          currencyCodeSnapshot: 'USD',
          supplierNameSnapshot: '供应商 A',
          faceValue: decimal('20'),
          exchangeRate: decimal('7.1'),
          costAmount: decimal('142'),
          purchaseOriginalAmount: decimal('20'),
          purchaseCurrency: 'USD',
          purchaseFxRateToCny: decimal('7.1'),
          supplierRefundStatus: 'none',
          supplierRefundAmountCny: decimal('0'),
          status: 'credited',
          creditedAt: now,
          updatedAt: now
        }
      ],
      renewals: [
        {
          id: 'activation-id',
          order: { orderNo: 'ORD-1001' },
          customer: { name: '测试客户' },
          serviceOption: { name: '一年服务', parent: { name: '订阅' } },
          openedAt: now,
          dueAt: now,
          status: 'active',
          autoRenewalStatus: 'disabled',
          renewedFromActivationId: null,
          updatedAt: now
        }
      ],
      financeJournals: [
        {
          businessDate: new Date('2026-09-05T00:00:00.000Z'),
          lines: [
            { accountCode: 'cash', amountCny: decimal('100'), direction: 'debit' },
            { accountCode: 'sales_revenue', amountCny: decimal('100'), direction: 'credit' }
          ]
        }
      ]
    });

    expect(reports.map((report) => report.name)).toEqual(['订单', '加卡', '续费', '财务汇总']);
    expect(reports[0]?.rows[1]).toContain('已完成');
    expect(reports[1]?.rows[1]?.[0]).toBe('12345678');
    expect(reports[3]?.rows.flat()).toContain('销售收入');
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toMatch(/password|securityInfo|phone|codeEncrypted|token/i);
    expect(serialized).not.toContain('sensitive-tail');
  });
});
