import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Amount4, type V2CommandTransaction } from '../../runtime/public-api';
import { mapAmount4 } from '../../runtime/public-api';
import { calculateFinanceHistoryAssetOpening } from './id-business-v2-finance-history-opening.repository';

const SOURCE_BATCH_SIZE = 500;

type HistorySourceType = 'order' | 'account_loss' | 'gift_card';
type HistoryPreviewClient = Pick<
  Prisma.TransactionClient,
  | 'idBusinessV2FinanceSettings'
  | 'idBusinessV2Order'
  | 'idBusinessV2AccountLoss'
  | 'idBusinessV2GiftCard'
  | 'idBusinessV2Account'
  | 'idBusinessV2TopupSupplierAccount'
  | 'idBusinessV2FinanceJournal'
  | 'idBusinessV2FinanceJournalLine'
>;

interface HistoryCandidate {
  id: string;
}

export interface HistoryPreviewCategory {
  candidateCount: number;
  willCreateCount: number;
  skippedExistingCount: number;
  skippedZeroAmountCount: number;
}

@Injectable()
export class IdBusinessV2FinanceHistoryPreviewRepository {
  constructor(private readonly prisma: PrismaService) {}

  preview(requestedAsOf?: Date) {
    return this.prisma.$transaction((tx) => this.previewWithClient(tx, requestedAsOf), {
      isolationLevel: 'RepeatableRead'
    });
  }

  previewInTransaction(tx: V2CommandTransaction, requestedAsOf?: Date) {
    return this.previewWithClient(tx, requestedAsOf);
  }

  private async previewWithClient(client: HistoryPreviewClient, requestedAsOf?: Date) {
    const previewedAt = new Date();
    const settings = await client.idBusinessV2FinanceSettings.findUnique({
      where: { id: 1 },
      select: { enabledAt: true, historyStatus: true }
    });
    const asOf = settings?.enabledAt ?? requestedAsOf ?? previewedAt;
    const historyStatus = settings?.historyStatus ?? 'not_started';

    const [
      orders,
      accountLosses,
      giftCards,
      accountsMissingFxSnapshot,
      giftCardsMissingFxSnapshot,
      ordersMissingFxSnapshot,
      assetOpeningCalculation
    ] = await Promise.all([
      this.previewOrders(client, asOf),
      this.previewAccountLosses(client, asOf),
      this.previewGiftCards(client, asOf),
      client.idBusinessV2Account.count({
        where: { createdAt: { lte: asOf }, purchaseCurrency: 'CNY', purchaseFxSnapshotId: null }
      }),
      client.idBusinessV2GiftCard.count({
        where: { createdAt: { lte: asOf }, purchaseCurrency: 'CNY', purchaseFxSnapshotId: null }
      }),
      client.idBusinessV2Order.count({
        where: { createdAt: { lte: asOf }, receivedCurrency: 'CNY', receivedFxSnapshotId: null }
      }),
      calculateFinanceHistoryAssetOpening(client)
    ]);

    const summary = {
      orders,
      accountLosses,
      redeemedGiftCards: giftCards.redeemed,
      withdrawnGiftCards: giftCards.withdrawn
    };
    const fxSnapshotUpdates = {
      accounts: accountsMissingFxSnapshot,
      giftCards: giftCardsMissingFxSnapshot,
      orders: ordersMissingFxSnapshot
    };
    const assetOpening = {
      willCreate: assetOpeningCalculation.willCreate,
      adjustmentTotalCny: assetOpeningCalculation.adjustmentTotalCny.toString(),
      journalLineCount: assetOpeningCalculation.journalLineCount,
      adjustments: assetOpeningCalculation.adjustments.map((item) => ({
        accountCode: item.accountCode,
        direction: item.direction,
        amountCny: item.amountCny.toString()
      }))
    };
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          asOf: asOf.toISOString(),
          historyStatus,
          assumption: 'legacy_assumed_cny',
          summary,
          fxSnapshotUpdates,
          assetOpening
        })
      )
      .digest('hex');

    return {
      previewedAt,
      asOf,
      historyStatus,
      canBackfill: historyStatus !== 'completed' && historyStatus !== 'in_progress',
      assumption: 'legacy_assumed_cny' as const,
      fingerprint,
      summary,
      fxSnapshotUpdates,
      assetOpening
    };
  }

  private async previewOrders(client: HistoryPreviewClient, asOf: Date) {
    const summary = emptyCategory();
    let cursor: string | undefined;
    while (true) {
      const rawRows = await client.idBusinessV2Order.findMany({
        where: {
          createdAt: { lte: asOf },
          deletedAt: null,
          status: { in: ['completed', 'refunded'] }
        },
        select: {
          id: true,
          status: true,
          receivedAmount: true,
          platformFeeAmount: true,
          balanceCostAmount: true,
          accountCostAmount: true,
          accountDisposition: true,
          refundCostAmount: true
        },
        orderBy: { id: 'asc' },
        take: SOURCE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const rows = rawRows.map((row) => ({
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
      const existing = await this.findExistingSourceIds(
        client,
        'order',
        rows.map((item) => item.id)
      );
      summarizeCandidates(summary, rows, existing, hasHistoricalOrderAmount);
      if (rows.length < SOURCE_BATCH_SIZE) return summary;
      cursor = rows.at(-1)!.id;
    }
  }

  private async previewAccountLosses(client: HistoryPreviewClient, asOf: Date) {
    const summary = emptyCategory();
    let cursor: string | undefined;
    while (true) {
      const rawRows = await client.idBusinessV2AccountLoss.findMany({
        where: { reportedAt: { lte: asOf } },
        select: { id: true, lossCostAmount: true, idPurchaseCostLossAmount: true },
        orderBy: { id: 'asc' },
        take: SOURCE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const rows = rawRows.map((row) => ({
        ...row,
        lossCostAmount: mapAmount4(row.lossCostAmount, 'accounts.loss_cost_amount'),
        idPurchaseCostLossAmount: mapAmount4(
          row.idPurchaseCostLossAmount,
          'accounts.id_purchase_cost_loss_amount'
        )
      }));
      const existing = await this.findExistingSourceIds(
        client,
        'account_loss',
        rows.map((item) => item.id)
      );
      summarizeCandidates(
        summary,
        rows,
        existing,
        (item) => item.lossCostAmount.gt(0) || item.idPurchaseCostLossAmount.gt(0)
      );
      if (rows.length < SOURCE_BATCH_SIZE) return summary;
      cursor = rows.at(-1)!.id;
    }
  }

  private async previewGiftCards(client: HistoryPreviewClient, asOf: Date) {
    const summary = { redeemed: emptyCategory(), withdrawn: emptyCategory() };
    let cursor: string | undefined;
    while (true) {
      const rawRows = await client.idBusinessV2GiftCard.findMany({
        where: { createdAt: { lte: asOf }, status: { in: ['redeemed', 'withdrawn'] } },
        select: { id: true, status: true, costAmount: true },
        orderBy: { id: 'asc' },
        take: SOURCE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
      const rows = rawRows.map((row) => ({
        ...row,
        costAmount: mapAmount4(row.costAmount, 'gift_cards.cost_amount')
      }));
      const existing = await this.findExistingSourceIds(
        client,
        'gift_card',
        rows.map((item) => item.id)
      );
      for (const item of rows) {
        summarizeCandidate(
          item.status === 'redeemed' ? summary.redeemed : summary.withdrawn,
          item,
          existing,
          (candidate) => candidate.costAmount.gt(0)
        );
      }
      if (rows.length < SOURCE_BATCH_SIZE) return summary;
      cursor = rows.at(-1)!.id;
    }
  }

  private async findExistingSourceIds(
    client: HistoryPreviewClient,
    sourceType: HistorySourceType,
    sourceIds: string[]
  ) {
    const existing = new Set<string>();
    for (let offset = 0; offset < sourceIds.length; offset += SOURCE_BATCH_SIZE) {
      const rows = await client.idBusinessV2FinanceJournal.findMany({
        where: {
          sourceType,
          sourceId: { in: sourceIds.slice(offset, offset + SOURCE_BATCH_SIZE) },
          journalType: { not: 'reversal' }
        },
        select: { sourceId: true }
      });
      for (const row of rows) if (row.sourceId) existing.add(row.sourceId);
    }
    return existing;
  }
}

function emptyCategory(): HistoryPreviewCategory {
  return {
    candidateCount: 0,
    willCreateCount: 0,
    skippedExistingCount: 0,
    skippedZeroAmountCount: 0
  };
}

function summarizeCandidates<TCandidate extends HistoryCandidate>(
  summary: HistoryPreviewCategory,
  candidates: TCandidate[],
  existingSourceIds: Set<string>,
  hasAmount: (candidate: TCandidate) => boolean
) {
  for (const candidate of candidates) {
    summarizeCandidate(summary, candidate, existingSourceIds, hasAmount);
  }
}

function summarizeCandidate<TCandidate extends HistoryCandidate>(
  summary: HistoryPreviewCategory,
  candidate: TCandidate,
  existingSourceIds: Set<string>,
  hasAmount: (candidate: TCandidate) => boolean
) {
  summary.candidateCount += 1;
  if (existingSourceIds.has(candidate.id)) summary.skippedExistingCount += 1;
  else if (hasAmount(candidate)) summary.willCreateCount += 1;
  else summary.skippedZeroAmountCount += 1;
}

function hasHistoricalOrderAmount(order: {
  status: string;
  receivedAmount: Amount4;
  platformFeeAmount: Amount4;
  balanceCostAmount: Amount4;
  accountCostAmount: Amount4;
  accountDisposition: string;
  refundCostAmount: Amount4 | null;
}) {
  return (
    order.receivedAmount.gt(0) ||
    order.platformFeeAmount.gt(0) ||
    order.balanceCostAmount.gt(0) ||
    (order.accountDisposition === 'sold' && order.accountCostAmount.gt(0)) ||
    (order.status === 'refunded' && order.refundCostAmount !== null && order.refundCostAmount.gt(0))
  );
}
