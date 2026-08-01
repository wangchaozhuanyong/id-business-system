import { Injectable } from '@nestjs/common';
import type { V2FinanceHistoryConfirmationPreview } from '@apple-business/shared';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4 } from '../../runtime/public-api';

type HistoryConfirmationClient = Pick<
  Prisma.TransactionClient,
  | 'idBusinessV2FinanceSettings'
  | 'idBusinessV2FinanceAccount'
  | 'idBusinessV2TopupSupplierAccount'
  | 'idBusinessV2FinanceExpense'
>;

export interface HistoryConfirmationSettings {
  enabledAt: Date | null;
  historyStatus: V2FinanceHistoryConfirmationPreview['historyStatus'];
}

@Injectable()
export class IdBusinessV2FinanceHistoryConfirmationRepository {
  constructor(private readonly prisma: PrismaService) {}

  loadPreviewData() {
    return this.prisma.$transaction((tx) => this.loadPreviewDataWithClient(tx), {
      isolationLevel: 'RepeatableRead'
    });
  }

  loadPreviewDataInTransaction(tx: V2CommandTransaction, settings?: HistoryConfirmationSettings) {
    return this.loadPreviewDataWithClient(tx, settings);
  }

  findSettings(tx: V2CommandTransaction) {
    return tx.idBusinessV2FinanceSettings.findUnique({ where: { id: 1 } });
  }

  confirm(
    tx: V2CommandTransaction,
    completedAt: Date,
    note: string | null,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2FinanceSettings.update({
      where: { id: 1 },
      data: {
        historyStatus: 'completed',
        historyCompletedAt: completedAt,
        historyNote: note,
        updatedByUserId
      }
    });
  }

  reopen(tx: V2CommandTransaction, historyNote: string, updatedByUserId?: string) {
    return tx.idBusinessV2FinanceSettings.update({
      where: { id: 1 },
      data: {
        historyStatus: 'incomplete',
        historyCompletedAt: null,
        historyNote,
        updatedByUserId
      }
    });
  }

  private async loadPreviewDataWithClient(
    client: HistoryConfirmationClient,
    settingsValue?: HistoryConfirmationSettings
  ) {
    const settings =
      settingsValue ??
      (await client.idBusinessV2FinanceSettings.findUnique({
        where: { id: 1 },
        select: { enabledAt: true, historyStatus: true }
      }));
    if (!settings?.enabledAt) return { settings, aggregates: null };

    const [financeAccountAggregate, supplierWalletAggregate, historicalExpenseAggregate] =
      await Promise.all([
        client.idBusinessV2FinanceAccount.aggregate({
          _count: { _all: true },
          _sum: { openingBalanceCny: true, currentBalanceCny: true }
        }),
        client.idBusinessV2TopupSupplierAccount.aggregate({
          _count: { _all: true },
          _sum: { openingBalanceCny: true, currentBalanceCny: true }
        }),
        client.idBusinessV2FinanceExpense.aggregate({
          where: { occurredAt: { lte: settings.enabledAt } },
          _count: { _all: true },
          _sum: { amountCny: true }
        })
      ]);
    return {
      settings,
      aggregates: {
        financeAccounts: {
          count: financeAccountAggregate._count._all,
          openingBalanceCny: mapAmount4(
            financeAccountAggregate._sum.openingBalanceCny ?? 0,
            'finance_accounts.sum_opening_balance_cny'
          ).toString(),
          currentBalanceCny: mapAmount4(
            financeAccountAggregate._sum.currentBalanceCny ?? 0,
            'finance_accounts.sum_current_balance_cny'
          ).toString()
        },
        supplierWallets: {
          count: supplierWalletAggregate._count._all,
          openingBalanceCny: mapAmount4(
            supplierWalletAggregate._sum.openingBalanceCny ?? 0,
            'supplier_accounts.sum_opening_balance_cny'
          ).toString(),
          currentBalanceCny: mapAmount4(
            supplierWalletAggregate._sum.currentBalanceCny ?? 0,
            'supplier_accounts.sum_current_balance_cny'
          ).toString()
        },
        historicalExpenses: {
          count: historicalExpenseAggregate._count._all,
          amountCny: mapAmount4(
            historicalExpenseAggregate._sum.amountCny ?? 0,
            'historical_expenses.sum_amount_cny'
          ).toString()
        }
      }
    };
  }
}
