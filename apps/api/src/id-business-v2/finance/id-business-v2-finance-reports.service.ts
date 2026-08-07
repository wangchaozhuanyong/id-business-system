import { Injectable } from '@nestjs/common';
import type { IdBusinessV2FinanceAccountCode, IdBusinessV2FinanceCurrency } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { Amount4, Rate8, V2CommandTransactionManager } from '../runtime/public-api';
import { normalizeFinanceDate } from './id-business-v2-finance-input';
import { getIdBusinessV2SettlementPlatformReport } from './id-business-v2-finance-settlement-platform-report';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';

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
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2FinanceReportRepository
  ) {}

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
    const grouped = await this.repository.groupProfitLoss(where);
    const amount = (code: IdBusinessV2FinanceAccountCode, natural: 'debit' | 'credit') => {
      const naturalTotal = grouped
        .filter((item) => item.accountCode === code && item.direction === natural)
        .reduce((sum, item) => sum.add(item.amountCny), Amount4.zero());
      const opposite = natural === 'debit' ? 'credit' : 'debit';
      const oppositeTotal = grouped
        .filter((item) => item.accountCode === code && item.direction === opposite)
        .reduce((sum, item) => sum.add(item.amountCny), Amount4.zero());
      return naturalTotal.sub(oppositeTotal);
    };
    const salesRevenue = amount('sales_revenue', 'credit');
    const values = new Map(EXPENSE_CODES.map((code) => [code, amount(code, 'debit')] as const));
    const realizedFx = amount('realized_fx_gain_loss', 'credit');
    const totalExpense = [...values.values()].reduce(
      (sum, value) => sum.add(value),
      Amount4.zero()
    );
    const estimated = await this.repository.estimatedPendingProfit(
      this.parseOccurredAt(query.dateFrom, query.dateTo)
    );
    return {
      salesRevenueCny: salesRevenue.toString(),
      platformFeeCny: (values.get('platform_fee') ?? Amount4.zero()).toString(),
      giftCardCostCny: (values.get('gift_card_cost') ?? Amount4.zero()).toString(),
      idCostCny: (values.get('id_cost') ?? Amount4.zero()).toString(),
      refundLossCny: (values.get('refund_loss') ?? Amount4.zero()).toString(),
      redemptionLossCny: (values.get('gift_card_redemption_loss') ?? Amount4.zero()).toString(),
      balanceLossCny: (values.get('balance_loss') ?? Amount4.zero()).toString(),
      idPurchaseLossCny: (values.get('id_purchase_loss') ?? Amount4.zero()).toString(),
      operatingExpenseCny: (values.get('operating_expense') ?? Amount4.zero()).toString(),
      realizedFxGainLossCny: realizedFx.toString(),
      netProfitCny: salesRevenue.sub(totalExpense).add(realizedFx).toString(),
      estimatedProfitCny: estimated.toString()
    };
  }

  async currencyBreakdown(query: FinanceReportQuery) {
    const grouped = await this.repository.groupCashFlow(this.buildLineWhere(query));
    const latestRates = await this.loadLatestRates();
    return (['CNY', 'MYR', 'USD', 'USDT'] as const).map((currency) => {
      const income = grouped
        .filter((item) => item.currency === currency && item.direction === 'debit')
        .reduce((sum, item) => sum.add(item.amountOriginal), Amount4.zero());
      const expense = grouped
        .filter((item) => item.currency === currency && item.direction === 'credit')
        .reduce((sum, item) => sum.add(item.amountOriginal), Amount4.zero());
      const net = income.sub(expense);
      const rate = latestRates.get(currency);
      return {
        currency,
        income: income.toString(),
        expense: expense.toString(),
        netCashFlow: net.toString(),
        latestRateToCny: rate?.toString() ?? null,
        netCashFlowCny: rate ? rate.apply(net).toString() : null
      };
    });
  }

  async settlementPlatformReport(query: FinanceReportQuery) {
    return getIdBusinessV2SettlementPlatformReport(this.repository, query);
  }
  async assets() {
    const [
      { financeAccounts, supplierWallets, giftCardInventory, pendingRefunds, unsoldIds },
      latestRates
    ] = await Promise.all([this.repository.loadAssets(), this.loadLatestRates()]);
    const cashBook = financeAccounts.reduce(
      (sum, item) => sum.add(item.currentBalanceCny),
      Amount4.zero()
    );
    const supplierBook = supplierWallets.reduce(
      (sum, item) => sum.add(item.currentBalanceCny),
      Amount4.zero()
    );
    const cashLatest = this.latestValuation(financeAccounts, latestRates);
    const supplierLatest = this.latestValuation(supplierWallets, latestRates);
    const idInventory = unsoldIds;
    const refundReceivable = pendingRefunds;
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
      cashCny: cashBook.toString(),
      supplierPrepaymentCny: supplierBook.toString(),
      giftCardInventoryCny: giftCardInventory.toString(),
      unsoldIdInventoryCny: idInventory.toString(),
      supplierRefundReceivableCny: refundReceivable.toString(),
      totalBookValueCny: totalBook.toString(),
      totalLatestValuationCny: latest ? latest.toString() : null,
      unrealizedFxChangeCny: latest ? latest.sub(totalBook).toString() : null
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
    const { completedOrders, missingPurchaseEvidence, pendingRefunds, wallets, orderLines } =
      await this.repository.loadReconciliation(this.parseOccurredAt(query.dateFrom, query.dateTo));
    for (const order of completedOrders) {
      const lines = orderLines.filter((line) => line.journal.sourceId === order.id);
      if (lines.length === 0) {
        issues.push({
          code: 'missing_finance_journal',
          severity: 'error',
          sourceType: 'order',
          sourceId: order.id,
          message: `订单 ${order.orderNo} 尚未生成财务日记`,
          amountCny: order.profitAmount?.toString() ?? null
        });
        continue;
      }
      const net = lines.reduce((total, line) => {
        const amountCny = line.amountCny;
        const naturalCredit =
          line.accountCode === 'sales_revenue' || line.accountCode === 'realized_fx_gain_loss';
        const positive =
          (naturalCredit && line.direction === 'credit') ||
          (!naturalCredit && line.direction === 'credit');
        if (line.accountCode === 'sales_revenue' || line.accountCode === 'realized_fx_gain_loss') {
          return positive ? total.add(amountCny) : total.sub(amountCny);
        }
        return line.direction === 'debit' ? total.sub(amountCny) : total.add(amountCny);
      }, Amount4.zero());
      const difference = net.sub(order.profitAmount ?? 0).abs();
      if (difference.gt('0.01')) {
        issues.push({
          code: 'order_profit_difference',
          severity: 'error',
          sourceType: 'order',
          sourceId: order.id,
          message: `订单 ${order.orderNo} 的逐单利润与财务分解不一致`,
          amountCny: difference.toString()
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
        amountCny: account.purchaseCost.toString()
      });
    }
    for (const card of pendingRefunds) {
      issues.push({
        code: 'open_supplier_refund',
        severity: 'warning',
        sourceType: 'gift_card',
        sourceId: card.id,
        message: `礼品卡 ${card.codeMasked} 的卡商退款尚未闭环`,
        amountCny: card.supplierRefundAmountCny.toString()
      });
    }
    for (const wallet of wallets) {
      const latest = wallet.ledgerEntries[0];
      if (latest && !latest.balanceAfter.equals(wallet.currentBalance)) {
        issues.push({
          code: 'supplier_balance_difference',
          severity: 'error',
          sourceType: 'supplier_wallet',
          sourceId: wallet.id,
          message: '供应商钱包余额与最后一条流水不一致',
          amountCny: wallet.currentBalanceCny.sub(latest.balanceAfterCny).abs().toString()
        });
      }
    }
    const latestRates = await this.loadLatestRateRows();
    for (const currency of ['MYR', 'USD', 'USDT'] as const) {
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
    const existing = await this.repository.findSettings();
    const settings =
      existing ??
      (await this.commandTransactions.execute((tx) => this.repository.ensureSettings(tx), {
        requestId: randomUUID()
      }));
    return {
      baseCurrency: settings.baseCurrency,
      timezone: settings.timezone,
      enabledAt: settings.enabledAt,
      historyStatus: settings.historyStatus,
      historyCompletedAt: settings.historyCompletedAt,
      historyNote: settings.historyNote
    };
  }

  private buildLineWhere(query: FinanceReportQuery) {
    return {
      currency: query.currency
        ? (query.currency.toUpperCase() as IdBusinessV2FinanceCurrency)
        : undefined,
      financeAccountId: query.financeAccountId || undefined,
      supplierOptionId: query.supplierOptionId || undefined,
      journalType: query.journalType || undefined,
      dateFrom: this.parseBusinessDate(query.dateFrom, query.dateTo)?.gte,
      dateTo: this.parseBusinessDate(query.dateFrom, query.dateTo)?.lte
    };
  }

  private parseBusinessDate(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return {
      gte: from ? normalizeFinanceDate(`${from}T00:00:00.000Z`, '开始日期') : undefined,
      lte: to ? normalizeFinanceDate(`${to}T00:00:00.000Z`, '结束日期') : undefined
    };
  }

  private parseOccurredAt(from?: string, to?: string) {
    if (!from && !to) return undefined;
    return {
      gte: from ? normalizeFinanceDate(`${from}T00:00:00+08:00`, '开始日期') : undefined,
      lte: to ? normalizeFinanceDate(`${to}T23:59:59.999+08:00`, '结束日期') : undefined
    };
  }

  private async loadLatestRates() {
    const rows = await this.loadLatestRateRows();
    const rates = new Map<IdBusinessV2FinanceCurrency, Rate8>([['CNY', Rate8.one()]]);
    for (const [currency, row] of rows) {
      rates.set(currency, row.rateToCny);
    }
    return rates;
  }

  private async loadLatestRateRows() {
    return this.repository.loadLatestRateRows();
  }

  private latestValuation(
    items: Array<{
      currency: IdBusinessV2FinanceCurrency;
      currentBalance: Amount4;
    }>,
    rates: Map<IdBusinessV2FinanceCurrency, Rate8>
  ) {
    return items.reduce((sum, item) => {
      const rate = rates.get(item.currency);
      return rate ? sum.add(rate.apply(item.currentBalance)) : sum;
    }, Amount4.zero());
  }
}
