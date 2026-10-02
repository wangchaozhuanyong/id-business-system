import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';
import { buildGoogleSheetsDetailReports } from './id-business-v2-google-sheets-detail-report';
import type { GoogleSheetsDetailSource } from './persistence/id-business-v2-google-sheets-detail.select';

const now = new Date('2026-10-02T01:02:03Z');
const decimal = (value: string) => new Prisma.Decimal(value);

function source(): GoogleSheetsDetailSource & { renewals: [] } {
  return {
    renewals: [],
    chatgptAccounts: [
      {
        id: 'account-id',
        emailMasked: 'a***@example.test',
        status: 'disabled',
        createdAt: now,
        updatedAt: now
      }
    ],
    mailboxes: [
      {
        id: 'mail-id',
        email: 'mailbox@example.test',
        label: '业务邮箱',
        provider: 'microsoft',
        status: 'auth_failed',
        queryCodeExpiresAt: now,
        lastVerifiedAt: null,
        createdAt: now,
        updatedAt: now
      }
    ],
    bankCards: [
      {
        id: 'bank-id',
        label: '业务银行卡',
        last4: '4321',
        currencyCode: 'USD',
        active: false,
        createdAt: now,
        updatedAt: now
      }
    ],
    customers: [
      {
        id: 'customer-id',
        name: '测试客户',
        phoneMasked: '138****1234',
        wechatMasked: 'w***t',
        qqMasked: null,
        whatsappMasked: null,
        sourceOption: { name: '客户介绍' },
        recordStatus: 'active',
        tags: [{ option: { name: '长期客户' } }],
        services: [{ option: { name: '月度订阅' }, activationCount: 2 }],
        createdAt: now,
        updatedAt: now
      }
    ],
    wallets: [
      {
        id: 'wallet-id',
        name: '测试钱包',
        accountType: 'usdt_wallet',
        currency: 'USDT',
        openingBalance: decimal('9007199254740.1234'),
        currentBalance: decimal('0.1001'),
        openingBalanceCny: decimal('0'),
        currentBalanceCny: decimal('0.7107'),
        status: 'active',
        createdAt: now,
        updatedAt: now
      }
    ],
    financeEntries: [
      {
        id: 'line-id',
        lineNo: 1,
        accountCode: 'other_operating_revenue',
        direction: 'credit',
        currency: 'USDT',
        amountOriginal: decimal('0.1001'),
        fxRateToCny: decimal('7.10000001'),
        amountCny: decimal('0.7107'),
        financeAccount: { name: '测试钱包' },
        supplierAccount: null,
        createdAt: now,
        journal: {
          journalNo: 'JRN-001',
          businessDate: now,
          occurredAt: now,
          journalType: 'manual_operating_income',
          status: 'reversed',
          reversalOfJournalId: 'original-journal',
          expense: null,
          inflow: { categoryNameSnapshot: '服务收入', nature: 'operating_income' },
          updatedAt: now
        }
      }
    ]
  };
}

describe('additional Google Sheets business reports', () => {
  it('exports mailbox addresses and only masked account, customer and bank identifiers', () => {
    const reports = buildGoogleSheetsDetailReports(source());
    const row = (name: string) => reports.find((report) => report.name === name)!.rows[1]!;
    expect(row('ChatGPT账号')).toContain('a***@example.test');
    expect(row('ChatGPT账号')).toContain('停用');
    expect(row('验证码邮箱')).toContain('mailbox@example.test');
    expect(row('验证码邮箱')).toContain('授权失效');
    expect(row('验证码邮箱')).toContain('微软邮箱');
    expect(row('银行卡')).toContain('**** 4321');
    expect(row('银行卡')).toContain('停用');
    expect(row('客户')).toContain('138****1234');
    expect(row('客户')).toContain('月度订阅：2次');
    const serialized = JSON.stringify(reports);
    expect(serialized).not.toMatch(/password|token|secret|Encrypted|queryCodeHint/i);
    for (const report of reports) {
      expect(report.rows[0]!.length).toBeLessThanOrEqual(24);
      for (const values of report.rows) expect(values).toHaveLength(report.rows[0]!.length);
    }
  });

  it('preserves exact wallet balances, exchange rates and reversed ledger entries', () => {
    const reports = buildGoogleSheetsDetailReports(source());
    const wallet = reports.find(({ name }) => name === '钱包账户')!.rows[1]!;
    expect(wallet).toContain('9007199254740.1234');
    expect(wallet).toContain('0.1001');
    const ledger = reports.find(({ name }) => name === '收支记账')!.rows[1]!;
    for (const expected of [
      '0.1001',
      '7.10000001',
      '0.7107',
      '贷方',
      '手工经营收入',
      '已冲销',
      '服务收入',
      '经营收入',
      'original-journal'
    ])
      expect(ledger).toContain(expected);
    expect(ledger).not.toContain('manual_operating_income');
    expect(ledger).not.toContain('other_operating_revenue');
  });
});
