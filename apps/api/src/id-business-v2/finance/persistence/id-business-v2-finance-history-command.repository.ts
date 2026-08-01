import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4 } from '../../runtime/public-api';
import { toKualaLumpurBusinessDate } from '../id-business-v2-finance-input';

@Injectable()
export class IdBusinessV2FinanceHistoryCommandRepository {
  ensureSettings(tx: V2CommandTransaction) {
    return tx.idBusinessV2FinanceSettings.upsert({
      where: { id: 1 },
      update: {},
      create: {
        id: 1,
        baseCurrency: 'CNY',
        timezone: 'Asia/Kuala_Lumpur',
        historyStatus: 'not_started'
      }
    });
  }

  markInProgress(
    tx: V2CommandTransaction,
    enabledAt: Date,
    historyNote: string,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2FinanceSettings.update({
      where: { id: 1 },
      data: { enabledAt, historyStatus: 'in_progress', historyNote, updatedByUserId }
    });
  }

  assignLegacyRate(tx: V2CommandTransaction, enabledAt: Date, rateId: string) {
    return Promise.all([
      tx.idBusinessV2Account.updateMany({
        where: {
          createdAt: { lte: enabledAt },
          purchaseCurrency: 'CNY',
          purchaseFxSnapshotId: null
        },
        data: { purchaseFxSnapshotId: rateId }
      }),
      tx.idBusinessV2GiftCard.updateMany({
        where: {
          createdAt: { lte: enabledAt },
          purchaseCurrency: 'CNY',
          purchaseFxSnapshotId: null
        },
        data: { purchaseFxSnapshotId: rateId }
      }),
      tx.idBusinessV2Order.updateMany({
        where: {
          createdAt: { lte: enabledAt },
          receivedCurrency: 'CNY',
          receivedFxSnapshotId: null
        },
        data: { receivedFxSnapshotId: rateId }
      })
    ]);
  }

  async listHistoricalOrders(tx: V2CommandTransaction, enabledAt: Date) {
    const rows = await tx.idBusinessV2Order.findMany({
      where: {
        createdAt: { lte: enabledAt },
        deletedAt: null,
        status: { in: ['completed', 'refunded'] }
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    return rows.map((row) => ({
      ...row,
      receivedAmount: mapAmount4(row.receivedAmount, 'orders.received_amount'),
      platformFeeAmount: mapAmount4(row.platformFeeAmount, 'orders.platform_fee_amount'),
      balanceCostAmount: mapAmount4(row.balanceCostAmount, 'orders.balance_cost_amount'),
      accountCostAmount: mapAmount4(row.accountCostAmount, 'orders.account_cost_amount'),
      refundCostAmount:
        row.refundCostAmount === null
          ? null
          : mapAmount4(row.refundCostAmount, 'orders.refund_cost_amount')
    }));
  }

  async listHistoricalAccountLosses(tx: V2CommandTransaction, enabledAt: Date) {
    const rows = await tx.idBusinessV2AccountLoss.findMany({
      where: { reportedAt: { lte: enabledAt } },
      orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }]
    });
    return rows.map((row) => ({
      ...row,
      lossCostAmount: mapAmount4(row.lossCostAmount, 'accounts.loss_cost_amount'),
      idPurchaseCostLossAmount: mapAmount4(
        row.idPurchaseCostLossAmount,
        'accounts.id_purchase_cost_loss_amount'
      )
    }));
  }

  async listHistoricalGiftCards(tx: V2CommandTransaction, enabledAt: Date) {
    const rows = await tx.idBusinessV2GiftCard.findMany({
      where: { createdAt: { lte: enabledAt }, status: { in: ['redeemed', 'withdrawn'] } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    return rows.map((row) => ({
      ...row,
      costAmount: mapAmount4(row.costAmount, 'history gift card costAmount')
    }));
  }

  markGiftCardRefundPending(tx: V2CommandTransaction, id: string, amount: string) {
    return tx.idBusinessV2GiftCard.update({
      where: { id },
      data: {
        supplierRefundStatus: 'pending',
        supplierRefundAmount: amount,
        supplierRefundAmountCny: amount
      }
    });
  }

  completeBackfill(
    tx: V2CommandTransaction,
    enabledAt: Date,
    historyNote: string,
    updatedByUserId?: string
  ) {
    return tx.idBusinessV2FinanceSettings.update({
      where: { id: 1 },
      data: {
        enabledAt,
        historyStatus: 'incomplete',
        historyNote,
        updatedByUserId
      }
    });
  }

  async ensureLegacyCnyRate(tx: V2CommandTransaction, enabledAt: Date, createdByUserId?: string) {
    const existing = await tx.idBusinessV2FinanceFxRateSnapshot.findFirst({
      where: { currency: 'CNY', source: 'legacy_assumed_cny' },
      orderBy: { createdAt: 'asc' }
    });
    if (existing) return existing;
    return tx.idBusinessV2FinanceFxRateSnapshot.create({
      data: {
        id: randomUUID(),
        currency: 'CNY',
        rateToCny: '1',
        source: 'legacy_assumed_cny',
        sourceReference: 'finance-history-backfill-v1',
        sourceEvidence: { assumption: 'Historical amounts are treated as CNY at rate 1' },
        businessDate: toKualaLumpurBusinessDate(enabledAt).date,
        capturedAt: enabledAt,
        createdByUserId
      }
    });
  }

  async hasPostedSource(
    tx: V2CommandTransaction,
    sourceType: 'order' | 'account_loss' | 'gift_card',
    sourceId: string
  ) {
    const row = await tx.idBusinessV2FinanceJournal.findFirst({
      where: { sourceType, sourceId, journalType: { not: 'reversal' } },
      select: { id: true }
    });
    return Boolean(row);
  }

  async hasAssetOpening(tx: V2CommandTransaction) {
    return Boolean(
      await tx.idBusinessV2FinanceJournal.findUnique({
        where: { idempotencyKey: 'legacy:asset_opening:v1' },
        select: { id: true }
      })
    );
  }
}
