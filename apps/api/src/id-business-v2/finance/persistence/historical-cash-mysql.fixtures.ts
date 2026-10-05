import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { IdBusinessV2FinanceAccount, IdBusinessV2FinanceCurrency } from '@prisma/client';
import type { AuthenticatedUser } from '../../../auth/auth.types';
import type { PrismaService } from '../../../common/prisma/prisma.service';
import { Amount4 } from '../../runtime/public-api';

const key = () => randomUUID();

// Synthetic fixtures used only after the calling spec has validated its disposable MySQL URL.
export class HistoricalCashMysqlFixtures {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operatorId: string,
    private readonly customerId: string,
    private readonly serviceOptionId: string,
    private readonly expenseOptionId: string,
    private readonly accountIds: string[],
    private readonly orderIds: string[]
  ) {}

  async account(
    currency: IdBusinessV2FinanceCurrency = 'CNY',
    original = '3000',
    cny = original,
    openingOriginal = original,
    openingCny = cny
  ) {
    const row = await this.prisma.idBusinessV2FinanceAccount.create({
      data: {
        name: `合成核账资金 ${key()}`,
        accountType: 'bank',
        currency,
        openingBalance: openingOriginal,
        currentBalance: original,
        openingBalanceCny: openingCny,
        currentBalanceCny: cny,
        createdByUserId: this.operatorId
      }
    });
    this.accountIds.push(row.id);
    return row;
  }

  async source(amount = '10', direction: 'debit' | 'credit' = 'debit', orderId?: string) {
    return this.prisma.idBusinessV2FinanceJournal.create({
      data: {
        journalNo: `HIST-${key().slice(0, 28)}`,
        journalType: orderId
          ? direction === 'debit'
            ? 'order_completed'
            : 'order_refund'
          : 'manual_operating_income',
        sourceType: orderId ? 'order' : 'manual',
        sourceId: orderId ?? key(),
        businessDate: new Date('2026-08-27T00:00:00Z'),
        periodMonth: '2026-08',
        occurredAt: new Date('2026-08-27T09:00:00Z'),
        summary: '合成旧账原凭证',
        idempotencyKey: `synthetic-historical-source:${key()}`,
        createdByUserId: this.operatorId,
        lines: {
          create: [
            {
              lineNo: 1,
              accountCode: 'cash',
              direction,
              currency: 'CNY',
              amountOriginal: amount,
              amountCny: amount,
              fxRateToCny: '1'
            },
            {
              lineNo: 2,
              accountCode: direction === 'debit' ? 'sales_revenue' : 'refund_loss',
              direction: direction === 'debit' ? 'credit' : 'debit',
              currency: 'CNY',
              amountOriginal: amount,
              amountCny: amount,
              fxRateToCny: '1'
            }
          ]
        }
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
    });
  }

  async order(status: 'completed' | 'refunded', receivedAmount: string) {
    const row = await this.prisma.idBusinessV2Order.create({
      data: {
        orderNo: `HIST-${key().slice(0, 28)}`,
        customerId: this.customerId,
        serviceOptionId: this.serviceOptionId,
        receivedAmount,
        receivedOriginalAmount: receivedAmount,
        receivedCurrency: 'CNY',
        receivedFxRateToCny: '1',
        status,
        idempotencyKey: `synthetic-historical-order:${key()}`
      }
    });
    this.orderIds.push(row.id);
    return row;
  }

  async expenseSource(target: IdBusinessV2FinanceAccount, quantity: string, oldCost: string) {
    const rate = Amount4.from(oldCost).ratio(quantity).toString();
    const row = await this.prisma.idBusinessV2FinanceJournal.create({
      data: {
        journalNo: `HIST-${key().slice(0, 28)}`,
        journalType: 'expense',
        sourceType: 'expense',
        sourceId: key(),
        businessDate: new Date('2026-08-28'),
        periodMonth: '2026-08',
        occurredAt: new Date('2026-08-28T08:00:00Z'),
        summary: '合成旧外币开支',
        idempotencyKey: `synthetic-historical-expense:${key()}`,
        createdByUserId: this.operatorId,
        lines: {
          create: [
            {
              lineNo: 1,
              accountCode: 'cash',
              direction: 'credit',
              currency: target.currency,
              amountOriginal: quantity,
              amountCny: oldCost,
              fxRateToCny: rate,
              financeAccountId: target.id
            },
            {
              lineNo: 2,
              accountCode: 'operating_expense',
              direction: 'debit',
              currency: target.currency,
              amountOriginal: quantity,
              amountCny: oldCost,
              fxRateToCny: rate
            }
          ]
        }
      },
      include: { lines: { orderBy: { lineNo: 'asc' } }, reversedBy: true }
    });
    await this.prisma.idBusinessV2FinanceExpense.create({
      data: {
        id: row.sourceId!,
        journalId: row.id,
        categoryOptionId: this.expenseOptionId,
        categoryNameSnapshot: '合成开支',
        financeAccountId: target.id,
        financeAccountNameSnapshot: target.name,
        currency: target.currency,
        amountOriginal: quantity,
        fxRateToCny: rate,
        amountCny: oldCost,
        occurredAt: row.occurredAt,
        idempotencyKey: key(),
        createdByUserId: this.operatorId
      }
    });
    return row;
  }

  async cashTotal(original = false) {
    const rows = await this.prisma.idBusinessV2FinanceJournalLine.findMany({
      where: { accountCode: 'cash', journal: { createdByUserId: this.operatorId } }
    });
    if (original) {
      const byCurrency = new Map<string, Amount4>();
      for (const row of rows) {
        const signed = Amount4.from(row.amountOriginal).mul(row.direction === 'debit' ? '1' : '-1');
        byCurrency.set(row.currency, (byCurrency.get(row.currency) ?? Amount4.zero()).add(signed));
      }
      return JSON.stringify(
        [...byCurrency]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([currency, amount]) => [currency, amount.toString()])
      );
    }
    return rows
      .reduce(
        (sum, row) =>
          sum.add(Amount4.from(row.amountCny).mul(row.direction === 'debit' ? '1' : '-1')),
        Amount4.zero()
      )
      .toString();
  }

  async existingReversal(row: Awaited<ReturnType<HistoricalCashMysqlFixtures['source']>>) {
    await this.prisma.idBusinessV2FinanceJournal.create({
      data: {
        journalNo: `HIST-${key().slice(0, 28)}`,
        journalType: 'reversal',
        sourceType: 'manual',
        sourceId: row.sourceId,
        businessDate: row.businessDate,
        periodMonth: row.periodMonth,
        occurredAt: row.occurredAt,
        summary: '合成已存在冲销的旧账',
        reversalOfJournalId: row.id,
        idempotencyKey: `synthetic-historical-reversal:${key()}`,
        createdByUserId: this.operatorId,
        lines: {
          create: row.lines.map((line) => ({
            lineNo: line.lineNo,
            accountCode: line.accountCode,
            direction: line.direction === 'debit' ? 'credit' : 'debit',
            currency: line.currency,
            amountOriginal: line.amountOriginal,
            amountCny: line.amountCny,
            fxRateToCny: line.fxRateToCny
          }))
        }
      }
    });
  }

  async state() {
    return {
      accounts: await this.prisma.idBusinessV2FinanceAccount.findMany({
        where: { id: { in: this.accountIds } },
        orderBy: { id: 'asc' }
      }),
      orders: await this.prisma.idBusinessV2Order.findMany({
        where: { id: { in: this.orderIds } },
        orderBy: { id: 'asc' }
      }),
      journals: await this.prisma.idBusinessV2FinanceJournal.findMany({
        where: { createdByUserId: this.operatorId },
        include: { lines: { orderBy: { lineNo: 'asc' } } },
        orderBy: { id: 'asc' }
      }),
      audits: await this.prisma.auditLog.findMany({
        where: { userId: this.operatorId },
        orderBy: { id: 'asc' }
      })
    };
  }
  async cashAudit(journalIds: readonly string[]) {
    const libraryUrl = pathToFileURL(
      resolve(process.cwd(), '../../scripts/lib/v2-data-integrity-audit.mjs')
    ).href;
    const library = (await import(/* @vite-ignore */ libraryUrl)) as {
      V2_DATA_INTEGRITY_CHECKS: Array<{ code: string; sql: string }>;
    };
    const lines = await this.prisma.idBusinessV2FinanceJournalLine.findMany({
      where: { journalId: { in: [...journalIds] } }
    });
    const entities = new Set([
      ...journalIds,
      ...lines.map((line) => line.id),
      ...lines.flatMap((line) => (line.financeAccountId ? [line.financeAccountId] : [])),
      ...lines.map((line) => `${line.journalId}:${line.financeAccountId ?? 'unassigned'}`)
    ]);
    const result: Record<
      'cashSource' | 'historicalCost' | 'compensation' | 'accountBalance',
      string[]
    > = {
      cashSource: [],
      historicalCost: [],
      compensation: [],
      accountBalance: []
    };
    for (const [name, code] of [
      ['cashSource', 'finance_cash_source_currency_mismatch'],
      ['historicalCost', 'cash_historical_cost_evidence_mismatch'],
      ['compensation', 'historical_cash_adjustment_integrity_mismatch'],
      ['accountBalance', 'finance_account_balance_mismatch']
    ] as const) {
      const rule = library.V2_DATA_INTEGRITY_CHECKS.find((item) => item.code === code);
      if (!rule) throw new Error(`实际历史巡检规则不存在：${code}`);
      // SQL comes from the same checked-in rules executed by the production auditor.
      const rows = await this.prisma.$queryRawUnsafe<Array<{ entity_id: string }>>(rule.sql);
      result[name] = rows
        .map((row) => row.entity_id)
        .filter((id) => entities.has(id))
        .sort();
    }
    return result;
  }
}

export async function createHistoricalCashMysqlFixtures(
  prisma: PrismaService,
  accountIds: string[],
  orderIds: string[]
) {
  const user = await prisma.user.create({
    data: {
      username: `historical-cash-${key()}`,
      displayName: '历史现金隔离验收',
      passwordHash: 'synthetic-only'
    }
  });
  const operator: AuthenticatedUser = { ...user, roles: ['admin'], permissions: [] };
  const adminRoleId = (
    await prisma.role.upsert({
      where: { code: 'admin' },
      create: { code: 'admin', name: '隔离管理员' },
      update: {}
    })
  ).id;
  await prisma.userRole.create({ data: { userId: operator.id, roleId: adminRoleId } });
  await prisma.v2AuthIdentity.create({
    data: {
      userId: operator.id,
      authUserId: key(),
      usernameNormalized: user.username,
      authEmail: `${key()}@synthetic.invalid`,
      enabled: true,
      mustResetPassword: false
    }
  });
  await prisma.idBusinessV2FinanceSettings.upsert({
    where: { id: 1 },
    create: { id: 1, enabledAt: new Date(), historyStatus: 'completed' },
    update: {}
  });
  const customerId = (await prisma.idBusinessV2Customer.create({ data: { name: '合成核账客户' } }))
    .id;
  const option = (type: 'service' | 'expense_category') =>
    prisma.idBusinessV2Option.create({
      data: { type, code: key(), uniqueKey: key(), name: '合成核账选项' }
    });
  const serviceOptionId = (await option('service')).id;
  const expenseOptionId = (await option('expense_category')).id;
  const fixtures = new HistoricalCashMysqlFixtures(
    prisma,
    operator.id,
    customerId,
    serviceOptionId,
    expenseOptionId,
    accountIds,
    orderIds
  );
  return { fixtures, operator, adminRoleId };
}
