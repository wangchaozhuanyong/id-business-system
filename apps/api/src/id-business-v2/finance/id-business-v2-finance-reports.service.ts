import { Injectable } from '@nestjs/common';
import {
  IdBusinessV2FinanceAccountCode,
  IdBusinessV2FinanceCurrency,
  Prisma as PrismaNamespace
} from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2Decimal, toV2DecimalString } from '../decimal-policy';
import { normalizeFinanceDate } from './id-business-v2-finance-input';
import { getIdBusinessV2SettlementPlatformReport } from './id-business-v2-finance-settlement-platform-report';

interface FinanceReportQuery {
  dateFrom?: string;
  dateTo?: string;
  currency?: string;
  supplierOptionId?: string;
  journalType?: string;
  financeAccountId?: string;
  settlementPlatformOptionId?: string;
}

const EXPENSE_CODES = [
  'platform_fee',
  'gift_card_cost',
  'id_cost',
  'refund_loss',
  'gift_card_redemption_loss',
  'balance_loss',
  'id_purchase_loss',
  'operating_expense'
] as const;
@Injectable()
export class IdBusinessV2FinanceReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(query: FinanceReportQuery) {
    const [
      settings,
      profitLoss,
      currencyBreakdown,
      assets,
      reconciliation,
      settlementPlatformReport
    ] = await Promise.all([
      this.getSettings(),
      this.profitLoss(query),
      this.currencyBreakdown(query),
      this.assets(),
      this.reconciliation(query),
      this.settlementPlatformReport(query)
    ]);
    return {
      settings,
      profitLoss,
      currencyBreakdown,
      assets,
      reconciliation,
      settlementPlatformReport
    };
  }

  async profitLoss(query: FinanceReportQuery) {
    const where = this.buildLineWhere(query);
    const grouped = await this.prisma.idBusinessV2FinanceJournalLine.groupBy({
      by: ['accountCode', 'direction'],
      where,
      _sum: { amountCny: true }
    });
    const amount = (code: IdBusinessV2FinanceAccountCode, natural: 'debit' | 'credit') => {
      const naturalTotal = grouped
        .filter((item) => item.accountCode === code && item.direction === natural)
        .reduce(
          (sum, item) => sum.add(toV2Decimal(item._sum.amountCny ?? 0)),
          new PrismaNamespace.Decimal(0)
        );
      const opposite = natural === 'debit' ? 'credit' : 'debit';
      const oppositeTotal = grouped
        .filter((item) => item.accountCode === code && item.direction === opposite)
        .reduce(
          (sum, item) => sum.add(toV2Decimal(item._sum.amountCny ?? 0)),
          new PrismaNamespace.Decimal(0)
        );
      return roundV2Decimal(naturalTotal.sub(oppositeTotal));
    };
    const salesRevenue = amount('sales_revenue', 'credit');
    const values = new Map(EXPENSE_CODES.map((code) => [code, amount(code, 'debit')] as const));
    const realizedFx = amount('realized_fx_gain_loss', 'credit');
    const totalExpense = [...values.values()].reduce(
      (sum, value) => sum.add(value),
      new PrismaNamespace.Decimal(0)
    );
    const estimated = await this.prisma.idBusinessV2Order.aggregate({
      where: {
        status: { in: ['pending', 'waiting_external', 'processing'] },
        deletedAt: null,
        openedAt: this.parseOccurredAt(query.dateFrom, query.dateTo)
      },
      _sum: { profitAmount: true }
    });
    return {
      salesRevenueCny: toV2DecimalString(salesRevenue),
      platformFeeCny: toV2DecimalString(values.get('platform_fee') ?? 0),
      giftCardCostCny: toV2DecimalString(values.get('gift_card_cost') ?? 0),
      idCostCny: toV2DecimalString(values.get('id_cost') ?? 0),
      refundLossCny: toV2DecimalString(values.get('refund_loss') ?? 0),
      redemptionLossCny: toV2DecimalString(values.get('gift_card_redemption_loss') ?? 0),
      balanceLossCny: toV2DecimalString(values.get('balance_loss') ?? 0),
      idPurchaseLossCny: toV2DecimalString(values.get('id_purchase_loss') ?? 0),
      operatingExpenseCny: toV2DecimalString(values.get('operating_expense') ?? 0),
      realizedFxGainLossCny: toV2DecimalString(realizedFx),
      netProfitCny: toV2DecimalString(salesRevenue.sub(totalExpense).add(realizedFx)),
      estimatedProfitCny: toV2DecimalString(estimated._sum.profitAmount ?? 0)
    };
  }

  async currencyBreakdown(query: FinanceReportQuery) {
    const where: Prisma.IdBusinessV2FinanceJournalLineWhereInput = {
      ...this.buildLineWhere(query),
      accountCode: 'cash'
    };
    const grouped = await this.prisma.idBusinessV2FinanceJournalLine.groupBy({
      by: ['currency', 'direction'],
      where,
      _sum: { amountOriginal: true }
    });
    const latestRates = await this.loadLatestRates();
    return (['CNY', 'MYR', 'USDT'] as const).map((currency) => {
      const income = grouped
        .filter((item) => item.currency === currency && item.direction === 'debit')
        .reduce(
          (sum, item) => sum.add(toV2Decimal(item._sum.amountOriginal ?? 0)),
          new PrismaNamespace.Decimal(0)
        );
      const expense = grouped
        .filter((item) => item.currency === currency && item.direction === 'credit')
        .reduce(
          (sum, item) => sum.add(toV2Decimal(item._sum.amountOriginal ?? 0)),
          new PrismaNamespace.Decimal(0)
        );
      const net = income.sub(expense);
      const rate = latestRates.get(currency);
      return {
        currency,
        income: toV2DecimalString(income),
        expense: toV2DecimalString(expense),
        netCashFlow: toV2DecimalString(net),
        latestRateToCny: rate?.toString() ?? null,
        netCashFlowCny: rate ? toV2DecimalString(net.mul(rate)) : null
      };
    });
  }

  async settlementPlatformReport(query: FinanceReportQuery) {
    return getIdBusinessV2SettlementPlatformReport(this.prisma, query);
  }
  async assets() {
    const [financeAccounts, supplierWallets, accountAssets, pendingRefunds, latestRates] =
      await Promise.all([
        this.prisma.idBusinessV2FinanceAccount.findMany({
          where: { status: 'active' },
          select: { currency: true, currentBalance: true, currentBalanceCny: true }
        }),
        this.prisma.idBusinessV2TopupSupplierAccount.findMany({
          where: { status: 'active' },
          select: { currency: true, currentBalance: true, currentBalanceCny: true }
        }),
        this.prisma.idBusinessV2Account.aggregate({
          where: { deletedAt: null, lossReportedAt: null },
          _sum: { balanceCostAmount: true, purchaseCost: true }
        }),
        this.prisma.idBusinessV2GiftCard.aggregate({
          where: { supplierRefundStatus: 'pending' },
          _sum: { supplierRefundAmountCny: true }
        }),
        this.loadLatestRates()
      ]);
    const unsoldId = await this.prisma.idBusinessV2Account.aggregate({
      where: { deletedAt: null, lossReportedAt: null, soldByOrderId: null },
      _sum: { purchaseCost: true }
    });
    const cashBook = financeAccounts.reduce(
      (sum, item) => sum.add(toV2Decimal(item.currentBalanceCny)),
      new PrismaNamespace.Decimal(0)
    );
    const supplierBook = supplierWallets.reduce(
      (sum, item) => sum.add(toV2Decimal(item.currentBalanceCny)),
      new PrismaNamespace.Decimal(0)
    );
    const cashLatest = this.latestValuation(financeAccounts, latestRates);
    const supplierLatest = this.latestValuation(supplierWallets, latestRates);
    const giftCardInventory = toV2Decimal(accountAssets._sum.balanceCostAmount ?? 0);
    const idInventory = toV2Decimal(unsoldId._sum.purchaseCost ?? 0);
    const refundReceivable = toV2Decimal(pendingRefunds._sum.supplierRefundAmountCny ?? 0);
    const totalBook = cashBook
      .add(supplierBook)
      .add(giftCardInventory)
      .add(idInventory)
      .add(refundReceivable);
    const hasAllRates = [...financeAccounts, ...supplierWallets].every((item) =>
      latestRates.has(item.currency)
    );
    const latest = hasAllRates
      ? cashLatest.add(supplierLatest).add(giftCardInventory).add(idInventory).add(refundReceivable)
      : null;
    return {
      cashCny: toV2DecimalString(cashBook),
      supplierPrepaymentCny: toV2DecimalString(supplierBook),
      giftCardInventoryCny: toV2DecimalString(giftCardInventory),
      unsoldIdInventoryCny: toV2DecimalString(idInventory),
      supplierRefundReceivableCny: toV2DecimalString(refundReceivable),
      totalBookValueCny: toV2DecimalString(totalBook),
      totalLatestValuationCny: latest ? toV2DecimalString(latest) : null,
      unrealizedFxChangeCny: latest ? toV2DecimalString(latest.sub(totalBook)) : null
    };
  }

  async reconciliation(query: FinanceReportQuery) {
    const settings = await this.getSettings();
    const issues: Array<{
      code: string;
      severity: 'info' | 'warning' | 'error';
      sourceType: string | null;
      sourceId: string | null;
      message: string;
      amountCny: string | null;
    }> = [];
    if (settings.historyStatus !== 'completed') {
      issues.push({
        code: 'history_incomplete',
        severity: 'warning',
        sourceType: null,
        sourceId: null,
        message: settings.historyNote ?? '历史期初余额和旧开支尚未确认',
        amountCny: null
      });
    }
    const [completedOrders, missingPurchaseEvidence, pendingRefunds, wallets] = await Promise.all([
      this.prisma.idBusinessV2Order.findMany({
        where: {
          status: 'completed',
          profitAmount: { not: null },
          deletedAt: null,
          openedAt: this.parseOccurredAt(query.dateFrom, query.dateTo)
        },
        select: { id: true, orderNo: true, profitAmount: true },
        orderBy: [{ statusChangedAt: 'desc' }, { id: 'desc' }],
        take: 50
      }),
      this.prisma.idBusinessV2Account.findMany({
        where: {
          purchaseCurrency: { not: 'CNY' },
          purchaseCost: { gt: 0 },
          purchaseFxSnapshotId: null,
          deletedAt: null
        },
        select: { id: true, appleIdMasked: true, purchaseCost: true },
        take: 50
      }),
      this.prisma.idBusinessV2GiftCard.findMany({
        where: { supplierRefundStatus: 'pending' },
        select: { id: true, codeMasked: true, supplierRefundAmountCny: true },
        take: 50
      }),
      this.prisma.idBusinessV2TopupSupplierAccount.findMany({
        include: {
          ledgerEntries: { orderBy: { createdAt: 'desc' }, take: 1 }
        }
      })
    ]);
    const orderLines = completedOrders.length
      ? await this.prisma.idBusinessV2FinanceJournalLine.findMany({
          where: {
            journal: {
              is: {
                sourceType: 'order',
                sourceId: { in: completedOrders.map((order) => order.id) }
              }
            },
            accountCode: {
              in: ['sales_revenue', ...EXPENSE_CODES, 'realized_fx_gain_loss']
            }
          },
          select: {
            accountCode: true,
            direction: true,
            amountCny: true,
            journal: { select: { sourceId: true } }
          }
        })
      : [];
    for (const order of completedOrders) {
      const lines = orderLines.filter((line) => line.journal.sourceId === order.id);
      if (lines.length === 0) {
        issues.push({
          code: 'missing_finance_journal',
          severity: 'error',
          sourceType: 'order',
          sourceId: order.id,
          message: `订单 ${order.orderNo} 尚未生成财务日记`,
          amountCny: order.profitAmount ? toV2DecimalString(order.profitAmount) : null
        });
        continue;
      }
      const net = lines.reduce((total, line) => {
        const amountCny = toV2Decimal(line.amountCny);
        const naturalCredit =
          line.accountCode === 'sales_revenue' || line.accountCode === 'realized_fx_gain_loss';
        const positive =
          (naturalCredit && line.direction === 'credit') ||
          (!naturalCredit && line.direction === 'credit');
        if (line.accountCode === 'sales_revenue' || line.accountCode === 'realized_fx_gain_loss') {
          return positive ? total.add(amountCny) : total.sub(amountCny);
        }
        return line.direction === 'debit' ? total.sub(amountCny) : total.add(amountCny);
      }, new PrismaNamespace.Decimal(0));
      const difference = net.sub(toV2Decimal(order.profitAmount ?? 0)).abs();
      if (difference.gt('0.01')) {
        issues.push({
          code: 'order_profit_difference',
          severity: 'error',
          sourceType: 'order',
          sourceId: order.id,
          message: `订单 ${order.orderNo} 的逐单利润与财务分解不一致`,
          amountCny: toV2DecimalString(difference)
        });
      }
    }
    for (const account of missingPurchaseEvidence) {
      issues.push({
        code: 'missing_fx_rate',
        severity: 'error',
        sourceType: 'account',
        sourceId: account.id,
        message: `${account.appleIdMasked} 缺少采购汇率快照`,
        amountCny: toV2DecimalString(account.purchaseCost)
      });
    }
    for (const card of pendingRefunds) {
      issues.push({
        code: 'open_supplier_refund',
        severity: 'warning',
        sourceType: 'gift_card',
        sourceId: card.id,
        message: `礼品卡 ${card.codeMasked} 的卡商退款尚未闭环`,
        amountCny: toV2DecimalString(card.supplierRefundAmountCny)
      });
    }
    for (const wallet of wallets) {
      const latest = wallet.ledgerEntries[0];
      if (latest && !toV2Decimal(latest.balanceAfter).equals(toV2Decimal(wallet.currentBalance))) {
        issues.push({
          code: 'supplier_balance_difference',
          severity: 'error',
          sourceType: 'supplier_wallet',
          sourceId: wallet.id,
          message: '供应商钱包余额与最后一条流水不一致',
          amountCny: toV2DecimalString(
            toV2Decimal(wallet.currentBalanceCny).sub(toV2Decimal(latest.balanceAfterCny)).abs()
          )
        });
      }
    }
    const latestRates = await this.loadLatestRateRows();
    for (const currency of ['MYR', 'USDT'] as const) {
      const latest = latestRates.get(currency);
      if (!latest) {
        issues.push({
          code: 'missing_fx_rate',
          severity: 'error',
          sourceType: 'fx_rate',
          sourceId: null,
          message: `缺少 ${currency}/CNY 最新汇率`,
          amountCny: null
        });
      } else if (latest.expiresAt && latest.expiresAt.getTime() < Date.now()) {
        issues.push({
          code: 'stale_fx_rate',
          severity: 'warning',
          sourceType: 'fx_rate',
          sourceId: latest.id,
          message: `${currency}/CNY 最新汇率已过期`,
          amountCny: null
        });
      }
    }
    return {
      isComplete:
        issues.every((issue) => issue.severity !== 'error') &&
        settings.historyStatus === 'completed',
      issueCount: issues.length,
      issues
    };
  }

  async getSettings() {
    const settings = await this.prisma.idBusinessV2FinanceSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        baseCurrency: 'CNY',
        timezone: 'Asia/Kuala_Lumpur',
        historyStatus: 'incomplete',
        historyNote: '等待确认期初余额和系统外历史开支'
      }
    });
    return {
      baseCurrency: settings.baseCurrency,
      timezone: settings.timezone,
      enabledAt: settings.enabledAt,
      historyStatus: settings.historyStatus,
      historyCompletedAt: settings.historyCompletedAt,
      historyNote: settings.historyNote
    };
  }

  private buildLineWhere(
    query: FinanceReportQuery
  ): Prisma.IdBusinessV2FinanceJournalLineWhereInput {
    return {
      currency: query.currency
        ? (query.currency.toUpperCase() as IdBusinessV2FinanceCurrency)
        : undefined,
      financeAccountId: query.financeAccountId || undefined,
      supplierAccount: query.supplierOptionId
        ? { is: { supplierOptionId: query.supplierOptionId } }
        : undefined,
      journal: {
        is: {
          businessDate: this.parseBusinessDate(query.dateFrom, query.dateTo),
          journalType: query.journalType
            ? (query.journalType as Prisma.EnumIdBusinessV2FinanceJournalTypeFilter)
            : undefined
        }
      }
    };
  }

  private parseBusinessDate(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return {
      gte: from ? normalizeFinanceDate(`${from}T00:00:00.000Z`, '开始日期') : undefined,
      lte: to ? normalizeFinanceDate(`${to}T00:00:00.000Z`, '结束日期') : undefined
    };
  }

  private parseOccurredAt(from?: string, to?: string): Prisma.DateTimeFilter | undefined {
    if (!from && !to) return undefined;
    return {
      gte: from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined,
      lte: to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined
    };
  }

  private async loadLatestRates() {
    const rows = await this.loadLatestRateRows();
    const rates = new Map<IdBusinessV2FinanceCurrency, PrismaNamespace.Decimal>([
      ['CNY', new PrismaNamespace.Decimal(1)]
    ]);
    for (const [currency, row] of rows) rates.set(currency, toV2Decimal(row.rateToCny));
    return rates;
  }

  private async loadLatestRateRows() {
    const rows = await this.prisma.idBusinessV2FinanceFxRateSnapshot.findMany({
      where: { currency: { in: ['MYR', 'USDT'] } },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
    });
    const map = new Map<'MYR' | 'USDT', (typeof rows)[number]>();
    for (const row of rows) {
      if ((row.currency === 'MYR' || row.currency === 'USDT') && !map.has(row.currency)) {
        map.set(row.currency, row);
      }
    }
    return map;
  }

  private latestValuation(
    items: Array<{
      currency: IdBusinessV2FinanceCurrency;
      currentBalance: PrismaNamespace.Decimal;
    }>,
    rates: Map<IdBusinessV2FinanceCurrency, PrismaNamespace.Decimal>
  ) {
    return items.reduce((sum, item) => {
      const rate = rates.get(item.currency);
      return rate ? sum.add(toV2Decimal(item.currentBalance).mul(rate)) : sum;
    }, new PrismaNamespace.Decimal(0));
  }
}
