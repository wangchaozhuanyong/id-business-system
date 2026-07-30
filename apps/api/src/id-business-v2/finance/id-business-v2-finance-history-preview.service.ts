import { Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2DecimalString } from '../decimal-policy';
import { calculateFinanceHistoryAssetOpening } from './id-business-v2-finance-history-opening';

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
export class IdBusinessV2FinanceHistoryPreviewService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(requestedAsOf?: Date) {
    return this.previewWithClient(this.prisma, requestedAsOf);
  }

  async previewInTransaction(tx: Prisma.TransactionClient, requestedAsOf?: Date) {
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
        where: {
          createdAt: { lte: asOf },
          purchaseCurrency: 'CNY',
          purchaseFxSnapshotId: null
        }
      }),
      client.idBusinessV2GiftCard.count({
        where: {
          createdAt: { lte: asOf },
          purchaseCurrency: 'CNY',
          purchaseFxSnapshotId: null
        }
      }),
      client.idBusinessV2Order.count({
        where: {
          createdAt: { lte: asOf },
          receivedCurrency: 'CNY',
          receivedFxSnapshotId: null
        }
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
      adjustmentTotalCny: toV2DecimalString(assetOpeningCalculation.adjustmentTotalCny),
      journalLineCount: assetOpeningCalculation.journalLineCount,
      adjustments: assetOpeningCalculation.adjustments.map((item) => ({
        accountCode: item.accountCode,
        direction: item.direction,
        amountCny: toV2DecimalString(item.amountCny)
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
      const rows = await client.idBusinessV2Order.findMany({
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
      const rows = await client.idBusinessV2AccountLoss.findMany({
        where: { reportedAt: { lte: asOf } },
        select: {
          id: true,
          lossCostAmount: true,
          idPurchaseCostLossAmount: true
        },
        orderBy: { id: 'asc' },
        take: SOURCE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
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
    const summary = {
      redeemed: emptyCategory(),
      withdrawn: emptyCategory()
    };
    let cursor: string | undefined;
    while (true) {
      const rows = await client.idBusinessV2GiftCard.findMany({
        where: {
          createdAt: { lte: asOf },
          status: { in: ['redeemed', 'withdrawn'] }
        },
        select: { id: true, status: true, costAmount: true },
        orderBy: { id: 'asc' },
        take: SOURCE_BATCH_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {})
      });
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
      for (const row of rows) {
        if (row.sourceId) existing.add(row.sourceId);
      }
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
): void {
  for (const candidate of candidates) {
    summarizeCandidate(summary, candidate, existingSourceIds, hasAmount);
  }
}

function summarizeCandidate<TCandidate extends HistoryCandidate>(
  summary: HistoryPreviewCategory,
  candidate: TCandidate,
  existingSourceIds: Set<string>,
  hasAmount: (candidate: TCandidate) => boolean
): void {
  summary.candidateCount += 1;
  if (existingSourceIds.has(candidate.id)) {
    summary.skippedExistingCount += 1;
  } else if (hasAmount(candidate)) {
    summary.willCreateCount += 1;
  } else {
    summary.skippedZeroAmountCount += 1;
  }
}

function hasHistoricalOrderAmount(order: {
  status: string;
  receivedAmount: PrismaNamespace.Decimal;
  platformFeeAmount: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  accountCostAmount: PrismaNamespace.Decimal;
  accountDisposition: string;
  refundCostAmount: PrismaNamespace.Decimal | null;
}) {
  return (
    order.receivedAmount.gt(0) ||
    order.platformFeeAmount.gt(0) ||
    order.balanceCostAmount.gt(0) ||
    (order.accountDisposition === 'sold' && order.accountCostAmount.gt(0)) ||
    (order.status === 'refunded' && Boolean(order.refundCostAmount?.gt(0)))
  );
}
