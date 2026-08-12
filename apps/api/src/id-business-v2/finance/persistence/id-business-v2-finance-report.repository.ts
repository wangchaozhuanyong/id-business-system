import { Injectable } from '@nestjs/common';
import type {
  IdBusinessV2FinanceAccountCode,
  IdBusinessV2FinanceCurrency,
  Prisma
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Amount4, Rate8, type V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4, mapRate8 } from '../../runtime/public-api';

export interface FinanceReportPersistenceFilter {
  dateFrom?: Date;
  dateTo?: Date;
  currency?: IdBusinessV2FinanceCurrency;
  supplierOptionId?: string;
  journalType?: string;
  financeAccountId?: string;
}

@Injectable()
export class IdBusinessV2FinanceReportRepository {
  constructor(private readonly prisma: PrismaService) {}

  async groupProfitLoss(filter: FinanceReportPersistenceFilter) {
    const rows = await this.prisma.idBusinessV2FinanceJournalLine.groupBy({
      by: ['accountCode', 'direction'],
      where: buildLineWhere(filter),
      _sum: { amountCny: true }
    });
    return rows.map((row) => ({
      accountCode: row.accountCode,
      direction: row.direction,
      amountCny: mapAmount4(row._sum.amountCny ?? 0, 'finance_journal_lines.sum_amount_cny')
    }));
  }

  async estimatedPendingProfit(occurredAt?: { gte?: Date; lte?: Date }) {
    const row = await this.prisma.idBusinessV2Order.aggregate({
      where: {
        status: { in: ['pending', 'waiting_external', 'processing'] },
        deletedAt: null,
        openedAt: occurredAt
      },
      _sum: { profitAmount: true }
    });
    return mapAmount4(row._sum.profitAmount ?? 0, 'orders.sum_profit_amount');
  }

  async loadAfterSales(input: {
    businessDate?: { gte?: Date; lte?: Date };
    occurredAt?: { gte?: Date; lte?: Date };
  }) {
    const [orders, pendingOrders] = await Promise.all([
      this.prisma.idBusinessV2Order.findMany({
        where: { accountSource: 'customer_owned', deletedAt: null },
        select: { id: true }
      }),
      this.prisma.idBusinessV2Order.findMany({
        where: {
          accountSource: 'customer_owned',
          status: { in: ['pending', 'waiting_external', 'processing'] },
          deletedAt: null,
          openedAt: input.occurredAt
        },
        select: {
          receivedAmount: true,
          platformFeeAmount: true,
          balanceAmount: true,
          profitAmount: true,
          account: { select: { currentBalance: true, balanceCostAmount: true } }
        }
      })
    ]);
    const orderIds = orders.map((order) => order.id);
    const journals = orderIds.length
      ? await this.prisma.idBusinessV2FinanceJournal.findMany({
          where: {
            status: 'posted',
            businessDate: input.businessDate,
            OR: [
              { sourceType: 'order', sourceId: { in: orderIds } },
              {
                journalType: 'reversal',
                reversalOf: { is: { sourceType: 'order', sourceId: { in: orderIds } } }
              }
            ]
          },
          select: {
            id: true,
            sourceId: true,
            journalType: true,
            reversalOf: { select: { sourceId: true, journalType: true } },
            lines: {
              where: {
                accountCode: {
                  in: ['sales_revenue', 'platform_fee', 'gift_card_cost', 'id_cost', 'refund_loss']
                }
              },
              select: { accountCode: true, direction: true, amountCny: true }
            }
          }
        })
      : [];
    return {
      journals: journals.map((journal) => ({
        ...journal,
        lines: journal.lines.map((line) => ({
          ...line,
          amountCny: mapAmount4(line.amountCny, 'finance_journal_lines.amount_cny')
        }))
      })),
      pendingOrderCount: pendingOrders.length,
      pendingRevenue: pendingOrders.reduce(
        (sum, order) =>
          sum.add(mapAmount4(order.receivedAmount, 'after_sales_orders.received_amount')),
        Amount4.zero()
      ),
      pendingProfit: pendingOrders.reduce(
        (sum, order) => sum.add(estimatePendingAfterSalesProfit(order)),
        Amount4.zero()
      )
    };
  }

  async groupCashFlow(filter: FinanceReportPersistenceFilter) {
    const rows = await this.prisma.idBusinessV2FinanceJournalLine.groupBy({
      by: ['currency', 'direction'],
      where: { ...buildLineWhere(filter), accountCode: 'cash' },
      _sum: { amountOriginal: true }
    });
    return rows.map((row) => ({
      currency: row.currency,
      direction: row.direction,
      amountOriginal: mapAmount4(
        row._sum.amountOriginal ?? 0,
        'finance_journal_lines.sum_amount_original'
      )
    }));
  }

  async loadAssets() {
    const [financeAccounts, supplierWallets, accountAssets, pendingRefunds, unsoldIds] =
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
          _sum: { balanceCostAmount: true }
        }),
        this.prisma.idBusinessV2GiftCard.aggregate({
          where: { supplierRefundStatus: 'pending' },
          _sum: { supplierRefundAmountCny: true }
        }),
        this.prisma.idBusinessV2Account.aggregate({
          where: { deletedAt: null, lossReportedAt: null, soldByOrderId: null },
          _sum: { purchaseCost: true }
        })
      ]);
    const mapBalance = <
      T extends {
        currency: IdBusinessV2FinanceCurrency;
        currentBalance: unknown;
        currentBalanceCny: unknown;
      }
    >(
      row: T,
      source: string
    ) => ({
      currency: row.currency,
      currentBalance: mapAmount4(row.currentBalance, `${source}.current_balance`),
      currentBalanceCny: mapAmount4(row.currentBalanceCny, `${source}.current_balance_cny`)
    });
    return {
      financeAccounts: financeAccounts.map((row) => mapBalance(row, 'finance_accounts')),
      supplierWallets: supplierWallets.map((row) => mapBalance(row, 'supplier_accounts')),
      giftCardInventory: mapAmount4(
        accountAssets._sum.balanceCostAmount ?? 0,
        'accounts.sum_balance_cost_amount'
      ),
      pendingRefunds: mapAmount4(
        pendingRefunds._sum.supplierRefundAmountCny ?? 0,
        'gift_cards.sum_supplier_refund_amount_cny'
      ),
      unsoldIds: mapAmount4(unsoldIds._sum.purchaseCost ?? 0, 'accounts.sum_purchase_cost')
    };
  }

  async loadReconciliation(occurredAt?: { gte?: Date; lte?: Date }) {
    const [completedOrders, missingPurchaseEvidence, pendingRefunds, wallets] = await Promise.all([
      this.prisma.idBusinessV2Order.findMany({
        where: {
          status: 'completed',
          profitAmount: { not: null },
          deletedAt: null,
          openedAt: occurredAt
        },
        select: {
          id: true,
          orderNo: true,
          profitAmount: true,
          accountSource: true,
          appliedAccountCostAmount: true
        },
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
        select: {
          id: true,
          currentBalance: true,
          currentBalanceCny: true,
          ledgerEntries: {
            select: { balanceAfter: true, balanceAfterCny: true },
            orderBy: { createdAt: 'desc' },
            take: 1
          }
        }
      })
    ]);
    const orderIds = completedOrders.map((order) => order.id);
    const orderLines = orderIds.length
      ? await this.prisma.idBusinessV2FinanceJournalLine.findMany({
          where: {
            journal: { is: { sourceType: 'order', sourceId: { in: orderIds } } },
            accountCode: {
              in: [
                'sales_revenue',
                'platform_fee',
                'gift_card_cost',
                'id_cost',
                'refund_loss',
                'gift_card_redemption_loss',
                'balance_loss',
                'id_purchase_loss',
                'operating_expense',
                'realized_fx_gain_loss'
              ]
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
    return {
      completedOrders: completedOrders.map((row) => ({
        ...row,
        profitAmount: row.profitAmount
          ? mapAmount4(row.profitAmount, 'orders.profit_amount')
          : null,
        appliedAccountCostAmount: mapAmount4(
          row.appliedAccountCostAmount,
          'orders.applied_account_cost_amount'
        )
      })),
      missingPurchaseEvidence: missingPurchaseEvidence.map((row) => ({
        ...row,
        purchaseCost: mapAmount4(row.purchaseCost, 'accounts.purchase_cost')
      })),
      pendingRefunds: pendingRefunds.map((row) => ({
        ...row,
        supplierRefundAmountCny: mapAmount4(
          row.supplierRefundAmountCny,
          'gift_cards.supplier_refund_amount_cny'
        )
      })),
      wallets: wallets.map((row) => ({
        id: row.id,
        currentBalance: mapAmount4(row.currentBalance, 'supplier_accounts.current_balance'),
        currentBalanceCny: mapAmount4(
          row.currentBalanceCny,
          'supplier_accounts.current_balance_cny'
        ),
        ledgerEntries: row.ledgerEntries.map((entry) => ({
          balanceAfter: mapAmount4(entry.balanceAfter, 'supplier_ledgers.balance_after'),
          balanceAfterCny: mapAmount4(entry.balanceAfterCny, 'supplier_ledgers.balance_after_cny')
        }))
      })),
      orderLines: orderLines.map((row) => ({
        ...row,
        amountCny: mapAmount4(row.amountCny, 'finance_journal_lines.amount_cny')
      }))
    };
  }

  findSettings() {
    return this.prisma.idBusinessV2FinanceSettings.findUnique({ where: { id: 1 } });
  }

  ensureSettings(tx: V2CommandTransaction) {
    return tx.idBusinessV2FinanceSettings.upsert({
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
  }

  async loadLatestRateRows() {
    const rows = await this.prisma.idBusinessV2FinanceFxRateSnapshot.findMany({
      where: { currency: { in: ['MYR', 'USD', 'USDT'] } },
      orderBy: [{ capturedAt: 'desc' }, { id: 'desc' }]
    });
    const result = new Map<
      'MYR' | 'USD' | 'USDT',
      { id: string; rateToCny: Rate8; expiresAt: Date | null }
    >();
    for (const row of rows) {
      if (
        (row.currency === 'MYR' || row.currency === 'USD' || row.currency === 'USDT') &&
        !result.has(row.currency)
      ) {
        result.set(row.currency, {
          id: row.id,
          rateToCny: mapRate8(row.rateToCny, 'finance_exchange_rates.rate_to_cny'),
          expiresAt: row.expiresAt
        });
      }
    }
    return result;
  }

  async loadSettlementReport(input: {
    settlementPlatformOptionId?: string;
    currency?: IdBusinessV2FinanceCurrency;
    occurredAt?: { gte?: Date; lte?: Date };
  }) {
    const [options, rawOrders] = await Promise.all([
      this.prisma.idBusinessV2Option.findMany({
        where: { type: 'settlement_platform', status: 'active', deletedAt: null },
        select: { id: true, name: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.idBusinessV2Order.findMany({
        where: {
          settlementPlatformOptionId: input.settlementPlatformOptionId,
          receivedCurrency: input.currency,
          createdAt: input.occurredAt
        },
        select: {
          id: true,
          status: true,
          settlementPlatformOptionId: true,
          settlementPlatform: { select: { id: true, name: true } },
          receivedAmount: true,
          profitAmount: true
        }
      })
    ]);
    const orderIds = rawOrders.map((order) => order.id);
    const rawJournals = orderIds.length
      ? await this.prisma.idBusinessV2FinanceJournal.findMany({
          where: {
            OR: [
              {
                sourceType: 'order',
                sourceId: { in: orderIds },
                journalType: { in: ['order_completed', 'order_refund'] }
              },
              {
                journalType: 'reversal',
                reversalOf: {
                  is: {
                    sourceType: 'order',
                    sourceId: { in: orderIds },
                    journalType: { in: ['order_completed', 'order_refund'] }
                  }
                }
              }
            ]
          },
          include: {
            lines: true,
            reversalOf: { select: { sourceId: true, journalType: true } }
          }
        })
      : [];
    return {
      options,
      orders: rawOrders.map((row) => ({
        ...row,
        receivedAmount: mapAmount4(row.receivedAmount, 'orders.received_amount'),
        profitAmount: mapAmount4(row.profitAmount ?? 0, 'orders.profit_amount')
      })),
      journals: rawJournals.map((journal) => ({
        ...journal,
        lines: journal.lines.map((line) => ({
          ...line,
          amountOriginal: mapAmount4(line.amountOriginal, 'finance_journal_lines.amount_original'),
          amountCny: mapAmount4(line.amountCny, 'finance_journal_lines.amount_cny')
        }))
      }))
    };
  }
}

function estimatePendingAfterSalesProfit(order: {
  receivedAmount: unknown;
  platformFeeAmount: unknown;
  balanceAmount: unknown;
  profitAmount: unknown | null;
  account: { currentBalance: unknown; balanceCostAmount: unknown } | null;
}) {
  if (order.profitAmount !== null) {
    return mapAmount4(order.profitAmount, 'after_sales_orders.profit_amount');
  }
  const receivedAmount = mapAmount4(order.receivedAmount, 'after_sales_orders.received_amount');
  const platformFeeAmount = mapAmount4(
    order.platformFeeAmount,
    'after_sales_orders.platform_fee_amount'
  );
  const balanceAmount = mapAmount4(order.balanceAmount, 'after_sales_orders.balance_amount');
  if (!order.account || balanceAmount.isZero()) {
    return receivedAmount.sub(platformFeeAmount);
  }
  const currentBalance = mapAmount4(
    order.account.currentBalance,
    'after_sales_orders.account.current_balance'
  );
  const balanceCostAmount = mapAmount4(
    order.account.balanceCostAmount,
    'after_sales_orders.account.balance_cost_amount'
  );
  const estimatedBalanceCost =
    currentBalance.lte(0) || balanceCostAmount.isZero()
      ? Amount4.zero()
      : balanceAmount.gte(currentBalance)
        ? balanceCostAmount
        : balanceCostAmount.ratio(currentBalance).apply(balanceAmount);
  return receivedAmount.sub(platformFeeAmount).sub(estimatedBalanceCost);
}

function buildLineWhere(
  filter: FinanceReportPersistenceFilter
): Prisma.IdBusinessV2FinanceJournalLineWhereInput {
  return {
    currency: filter.currency,
    financeAccountId: filter.financeAccountId,
    supplierAccount: filter.supplierOptionId
      ? { is: { supplierOptionId: filter.supplierOptionId } }
      : undefined,
    journal: {
      is: {
        businessDate:
          filter.dateFrom || filter.dateTo
            ? { gte: filter.dateFrom, lte: filter.dateTo }
            : undefined,
        journalType: filter.journalType
          ? (filter.journalType as Prisma.EnumIdBusinessV2FinanceJournalTypeFilter)
          : undefined
      }
    }
  };
}

export type FinanceReportAccountCode = IdBusinessV2FinanceAccountCode;

export function netFinanceAmount(
  lines: Array<{ direction: 'debit' | 'credit'; amountCny: Amount4 }>,
  natural: 'debit' | 'credit'
) {
  return lines.reduce(
    (sum, line) => (line.direction === natural ? sum.add(line.amountCny) : sum.sub(line.amountCny)),
    Amount4.zero()
  );
}
