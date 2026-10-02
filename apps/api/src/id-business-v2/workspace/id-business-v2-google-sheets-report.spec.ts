import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import {
  buildIdBusinessV2GoogleSheetsReports,
  prepareIdBusinessV2GoogleSheetsReports
} from './id-business-v2-google-sheets-report';

const decimal = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value);
const emptyDetails = {
  chatgptAccounts: [],
  mailboxes: [],
  bankCards: [],
  customers: [],
  wallets: [],
  financeEntries: []
};

describe('Google Sheets business report mapping', () => {
  it('trims summary data rows in batches of 100 while retaining the header and retirement boundary', () => {
    const journals = Array.from({ length: 10_000 }, (_, index) => ({
      businessDate: new Date(Date.UTC(2000, 0, index + 1)),
      lines: [
        { accountCode: 'cash' as const, direction: 'debit' as const, amountCny: decimal('0.1001') }
      ]
    }));
    const source = {
      ...emptyDetails,
      orders: [],
      giftCards: [],
      renewals: [],
      financeJournals: journals
    };
    const first = prepareIdBusinessV2GoogleSheetsReports(source);
    expect(first.reports[3]!.rows).toHaveLength(9_901);
    expect(first.reports[3]!.rows[0]![0]).toBe('业务日期');
    expect(first.retention.financeSummaryAfter).toBe(
      `${journals[99]!.businessDate.toISOString().slice(0, 10)}:cash`
    );
    const unchanged = prepareIdBusinessV2GoogleSheetsReports(source, first.retention);
    expect(unchanged.reports[3]!.rows).toHaveLength(9_901);
    expect(unchanged.retention).toEqual(first.retention);
    for (let index = 10_000; index < 10_100; index += 1)
      journals.push({
        businessDate: new Date(Date.UTC(2000, 0, index + 1)),
        lines: [{ accountCode: 'cash', direction: 'debit', amountCny: decimal('0.1001') }]
      });
    const second = prepareIdBusinessV2GoogleSheetsReports(source, first.retention);
    expect(second.reports[3]!.rows).toHaveLength(9_901);
    expect(second.retention.financeSummaryAfter).toBe(
      `${journals[199]!.businessDate.toISOString().slice(0, 10)}:cash`
    );
    expect(second.reports[3]!.rows[1]![2]).toBe('0.1001');
  });
  it('exports bank-recharge finance accounts using Chinese labels and exact decimals', () => {
    const accounts = [
      'bank_recharge_revenue',
      'bank_recharge_service_fee',
      'bank_recharge_cost',
      'bank_recharge_bank_fee'
    ] as const;
    const reports = buildIdBusinessV2GoogleSheetsReports({
      ...emptyDetails,
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
  it('keeps existing reports and adds the requested detail tabs without account or card credentials', () => {
    const now = new Date('2026-09-05T08:00:00.000Z');
    const reports = buildIdBusinessV2GoogleSheetsReports({
      ...emptyDetails,
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
          id: 'gift-card-record-id',
          createdAt: now,
          account: { appleIdMasked: 'a***@example.test' },
          codeMasked: '****1234',
          purchaseFinanceAccount: { name: '付款钱包' },
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
          createdAt: now,
          account: { appleIdMasked: 'a***@example.test' },
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

    expect(reports.map((report) => report.name)).toEqual([
      '订单',
      '加卡',
      '续费',
      '财务汇总',
      'ChatGPT账号',
      '验证码邮箱',
      '银行卡',
      '客户',
      '开通',
      '钱包账户',
      '收支记账'
    ]);
    expect(reports[0]?.rows[1]).toContain('已完成');
    expect(reports[1]?.rows[1]?.[0]).toBe('gift-card-record-id');
    expect(reports[1]?.rows[1]).toContain('付款钱包');
    expect(reports[3]?.rows.flat()).toContain('销售收入');
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toMatch(/password|securityInfo|phone|codeEncrypted|token/i);
    expect(reports.find(({ name }) => name === '开通')?.rows[1]).toContain('首次开通');
    for (const report of reports) {
      expect(report.rows[0]!.length).toBeLessThanOrEqual(24);
      for (const row of report.rows) expect(row).toHaveLength(report.rows[0]!.length);
    }
  });
});
