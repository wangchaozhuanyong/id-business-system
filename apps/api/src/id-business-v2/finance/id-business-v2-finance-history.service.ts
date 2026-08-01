import { ConflictException, Injectable } from '@nestjs/common';
import type { V2FinanceHistoryBackfillPreview } from '@apple-business/shared';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { toV2Decimal } from '../decimal-policy';
import { toKualaLumpurBusinessDate } from './id-business-v2-finance-input';
import {
  createHistoricalCnyLine,
  createHistoricalCnyPair,
  pushHistoricalCnyPair
} from './id-business-v2-finance-history-lines';
import { IdBusinessV2FinanceHistoryPreviewService } from './id-business-v2-finance-history-preview.service';
import {
  IdBusinessV2FinancePostingService,
  type FinancePostingLineInput
} from './id-business-v2-finance-posting.service';

const ZERO = new PrismaNamespace.Decimal(0);

@Injectable()
export class IdBusinessV2FinanceHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postingService: IdBusinessV2FinancePostingService,
    private readonly historyPreviewService: IdBusinessV2FinanceHistoryPreviewService
  ) {}

  async backfill(previewFingerprint: string, previewAsOf: Date, operator?: AuthenticatedUser) {
    const normalizedFingerprint = previewFingerprint?.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(normalizedFingerprint)) {
      throw new ConflictException('请先完成历史回填预览');
    }
    return this.prisma.$transaction(
      async (tx) => {
        const preview = await this.historyPreviewService.previewInTransaction(tx, previewAsOf);
        if (!preview.canBackfill) {
          throw new ConflictException('当前历史状态不允许执行回填');
        }
        if (preview.fingerprint !== normalizedFingerprint) {
          throw new ConflictException('历史数据已发生变化，请重新预览后再执行回填');
        }

        const settings = await tx.idBusinessV2FinanceSettings.upsert({
          where: { id: 1 },
          update: {},
          create: {
            id: 1,
            baseCurrency: 'CNY',
            timezone: 'Asia/Kuala_Lumpur',
            historyStatus: 'not_started'
          }
        });
        if (settings.historyStatus === 'completed') {
          throw new ConflictException('历史数据已经确认完成，不能再次回填');
        }

        const enabledAt = settings.enabledAt ?? preview.asOf;
        await tx.idBusinessV2FinanceSettings.update({
          where: { id: 1 },
          data: {
            enabledAt,
            historyStatus: 'in_progress',
            historyNote: '正在按人民币、汇率 1 回填历史业务',
            updatedByUserId: operator?.id
          }
        });

        const legacyRate = await this.ensureLegacyCnyRate(tx, enabledAt, operator);
        await Promise.all([
          tx.idBusinessV2Account.updateMany({
            where: {
              createdAt: { lte: enabledAt },
              purchaseCurrency: 'CNY',
              purchaseFxSnapshotId: null
            },
            data: { purchaseFxSnapshotId: legacyRate.id }
          }),
          tx.idBusinessV2GiftCard.updateMany({
            where: {
              createdAt: { lte: enabledAt },
              purchaseCurrency: 'CNY',
              purchaseFxSnapshotId: null
            },
            data: { purchaseFxSnapshotId: legacyRate.id }
          }),
          tx.idBusinessV2Order.updateMany({
            where: {
              createdAt: { lte: enabledAt },
              receivedCurrency: 'CNY',
              receivedFxSnapshotId: null
            },
            data: { receivedFxSnapshotId: legacyRate.id }
          })
        ]);

        const summary = {
          orders: 0,
          accountLosses: 0,
          redeemedGiftCards: 0,
          withdrawnGiftCards: 0,
          assetOpeningCreated: false,
          skippedExisting: 0
        };

        const orders = await tx.idBusinessV2Order.findMany({
          where: {
            createdAt: { lte: enabledAt },
            deletedAt: null,
            status: { in: ['completed', 'refunded'] }
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        for (const order of orders) {
          if (await this.hasPostedSource(tx, 'order', order.id)) {
            summary.skippedExisting += 1;
            continue;
          }
          const lines = this.buildHistoricalOrderLines(order, legacyRate.id);
          if (lines.length === 0) continue;
          await this.postingService.post(tx, {
            journalType: 'historical_backfill',
            sourceType: 'order',
            sourceId: order.id,
            sourceReference: order.orderNo,
            occurredAt: order.statusChangedAt ?? order.receivedAt ?? order.createdAt,
            summary: `历史订单回填：${order.orderNo}`,
            metadata: {
              assumption: 'legacy_assumed_cny',
              originalStatus: order.status
            },
            idempotencyKey: `legacy:order:${order.id}`,
            operator,
            lines
          });
          summary.orders += 1;
        }

        const accountLosses = await tx.idBusinessV2AccountLoss.findMany({
          where: { reportedAt: { lte: enabledAt } },
          orderBy: [{ reportedAt: 'asc' }, { id: 'asc' }]
        });
        for (const loss of accountLosses) {
          if (await this.hasPostedSource(tx, 'account_loss', loss.id)) {
            summary.skippedExisting += 1;
            continue;
          }
          const lines = this.buildLossLines(
            loss.lossCostAmount,
            loss.idPurchaseCostLossAmount,
            legacyRate.id
          );
          if (lines.length === 0) continue;
          await this.postingService.post(tx, {
            journalType: 'historical_backfill',
            sourceType: 'account_loss',
            sourceId: loss.id,
            sourceReference: loss.accountId,
            occurredAt: loss.reportedAt,
            summary: '历史 ID 报损回填',
            metadata: { assumption: 'legacy_assumed_cny' },
            idempotencyKey: `legacy:account_loss:${loss.id}`,
            operator,
            lines
          });
          summary.accountLosses += 1;
        }

        const giftCards = await tx.idBusinessV2GiftCard.findMany({
          where: {
            createdAt: { lte: enabledAt },
            status: { in: ['redeemed', 'withdrawn'] }
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
        });
        for (const card of giftCards) {
          if (await this.hasPostedSource(tx, 'gift_card', card.id)) {
            summary.skippedExisting += 1;
            continue;
          }
          if (card.status === 'redeemed') {
            if (card.costAmount.lte(0)) continue;
            await this.postingService.post(tx, {
              journalType: 'historical_backfill',
              sourceType: 'gift_card',
              sourceId: card.id,
              sourceReference: card.codeMasked,
              occurredAt: card.statusChangedAt,
              summary: `历史礼品卡赎回回填：${card.codeMasked}`,
              metadata: { assumption: 'legacy_assumed_cny', originalStatus: card.status },
              idempotencyKey: `legacy:gift_card_redeemed:${card.id}`,
              operator,
              lines: createHistoricalCnyPair(
                'gift_card_redemption_loss',
                'debit',
                'opening_equity',
                'credit',
                card.costAmount,
                legacyRate.id,
                '历史礼品卡赎回损失'
              )
            });
            summary.redeemedGiftCards += 1;
            continue;
          }

          if (card.costAmount.lte(0)) continue;
          await tx.idBusinessV2GiftCard.update({
            where: { id: card.id },
            data: {
              supplierRefundStatus: 'pending',
              supplierRefundAmount: card.costAmount,
              supplierRefundAmountCny: card.costAmount
            }
          });
          await this.postingService.post(tx, {
            journalType: 'historical_backfill',
            sourceType: 'gift_card',
            sourceId: card.id,
            sourceReference: card.codeMasked,
            occurredAt: card.statusChangedAt,
            summary: `历史礼品卡撤回待退款：${card.codeMasked}`,
            metadata: { assumption: 'legacy_assumed_cny', originalStatus: card.status },
            idempotencyKey: `legacy:gift_card_withdrawn:${card.id}`,
            operator,
            lines: createHistoricalCnyPair(
              'supplier_refund_receivable',
              'debit',
              'opening_equity',
              'credit',
              card.costAmount,
              legacyRate.id,
              '历史卡商退款应收'
            )
          });
          summary.withdrawnGiftCards += 1;
        }

        summary.assetOpeningCreated = await this.postAssetOpeningDifference(
          tx,
          enabledAt,
          legacyRate.id,
          preview.assetOpening,
          operator
        );

        const historyNote =
          '历史业务已按 CNY、汇率 1 自动回填；请补录并核对自有资金、卡商期初余额和系统外旧开支后再确认完整';
        await tx.idBusinessV2FinanceSettings.update({
          where: { id: 1 },
          data: {
            enabledAt,
            historyStatus: 'incomplete',
            historyNote,
            updatedByUserId: operator?.id
          }
        });
        await tx.auditLog.create({
          data: {
            userId: operator?.id,
            module: 'id_business_v2_finance',
            action: 'id_business_v2.finance.history_backfill',
            objectType: 'id_business_v2_finance_settings',
            objectId: null,
            afterData: {
              settingsId: 1,
              enabledAt: enabledAt.toISOString(),
              assumption: 'legacy_assumed_cny',
              ...summary
            },
            remark: historyNote
          }
        });

        return {
          enabledAt,
          historyStatus: 'incomplete' as const,
          historyNote,
          summary
        };
      },
      { timeout: 120_000 }
    );
  }

  private async ensureLegacyCnyRate(
    tx: Prisma.TransactionClient,
    enabledAt: Date,
    operator?: AuthenticatedUser
  ) {
    const existing = await tx.idBusinessV2FinanceFxRateSnapshot.findFirst({
      where: { currency: 'CNY', source: 'legacy_assumed_cny' },
      orderBy: { createdAt: 'asc' }
    });
    if (existing) return existing;
    return tx.idBusinessV2FinanceFxRateSnapshot.create({
      data: {
        id: randomUUID(),
        currency: 'CNY',
        rateToCny: 1,
        source: 'legacy_assumed_cny',
        sourceReference: 'finance-history-backfill-v1',
        sourceEvidence: {
          assumption: 'Historical amounts are treated as CNY at rate 1'
        },
        businessDate: toKualaLumpurBusinessDate(enabledAt).date,
        capturedAt: enabledAt,
        createdByUserId: operator?.id
      }
    });
  }

  private async hasPostedSource(
    tx: Prisma.TransactionClient,
    sourceType: 'order' | 'account_loss' | 'gift_card',
    sourceId: string
  ) {
    return Boolean(
      await tx.idBusinessV2FinanceJournal.findFirst({
        where: {
          sourceType,
          sourceId,
          journalType: { not: 'reversal' }
        },
        select: { id: true }
      })
    );
  }

  private buildHistoricalOrderLines(
    order: {
      status: string;
      receivedAmount: PrismaNamespace.Decimal;
      platformFeeAmount: PrismaNamespace.Decimal;
      balanceCostAmount: PrismaNamespace.Decimal;
      accountCostAmount: PrismaNamespace.Decimal;
      accountDisposition: string;
      refundCostAmount: PrismaNamespace.Decimal | null;
    },
    rateSnapshotId: string
  ) {
    const lines: FinancePostingLineInput[] = [];
    pushHistoricalCnyPair(
      lines,
      'cash',
      'debit',
      'sales_revenue',
      'credit',
      order.receivedAmount,
      rateSnapshotId,
      '历史订单收款'
    );
    if (order.status === 'refunded') {
      pushHistoricalCnyPair(
        lines,
        'sales_revenue',
        'debit',
        'cash',
        'credit',
        order.receivedAmount,
        rateSnapshotId,
        '历史订单退款'
      );
    }
    pushHistoricalCnyPair(
      lines,
      'platform_fee',
      'debit',
      'cash',
      'credit',
      order.platformFeeAmount,
      rateSnapshotId,
      '历史订单平台手续费'
    );
    pushHistoricalCnyPair(
      lines,
      'gift_card_cost',
      'debit',
      'opening_equity',
      'credit',
      order.balanceCostAmount,
      rateSnapshotId,
      '历史订单余额成本'
    );
    if (order.accountDisposition === 'sold') {
      pushHistoricalCnyPair(
        lines,
        'id_cost',
        'debit',
        'opening_equity',
        'credit',
        order.accountCostAmount,
        rateSnapshotId,
        '历史订单 ID 成本'
      );
    }
    if (order.status === 'refunded') {
      pushHistoricalCnyPair(
        lines,
        'refund_loss',
        'debit',
        'cash',
        'credit',
        order.refundCostAmount ?? ZERO,
        rateSnapshotId,
        '历史订单退款附加成本'
      );
    }
    return lines;
  }

  private buildLossLines(
    balanceLoss: PrismaNamespace.Decimal,
    purchaseLoss: PrismaNamespace.Decimal,
    rateSnapshotId: string
  ) {
    const lines: FinancePostingLineInput[] = [];
    pushHistoricalCnyPair(
      lines,
      'balance_loss',
      'debit',
      'opening_equity',
      'credit',
      balanceLoss,
      rateSnapshotId,
      '历史 ID 余额报损'
    );
    pushHistoricalCnyPair(
      lines,
      'id_purchase_loss',
      'debit',
      'opening_equity',
      'credit',
      purchaseLoss,
      rateSnapshotId,
      '历史未售 ID 成本报损'
    );
    return lines;
  }

  private async postAssetOpeningDifference(
    tx: Prisma.TransactionClient,
    enabledAt: Date,
    rateSnapshotId: string,
    assetOpening: V2FinanceHistoryBackfillPreview['assetOpening'],
    operator?: AuthenticatedUser
  ) {
    if (!assetOpening.willCreate || assetOpening.adjustments.length === 0) return false;
    const existing = await tx.idBusinessV2FinanceJournal.findUnique({
      where: { idempotencyKey: 'legacy:asset_opening:v1' },
      select: { id: true }
    });
    if (existing) return false;

    const lines: FinancePostingLineInput[] = [];
    for (const adjustment of assetOpening.adjustments) {
      const amount = toV2Decimal(adjustment.amountCny);
      lines.push(
        createHistoricalCnyLine(
          adjustment.accountCode,
          adjustment.direction,
          amount,
          rateSnapshotId,
          '历史资产期初差额'
        ),
        createHistoricalCnyLine(
          'opening_equity',
          adjustment.direction === 'debit' ? 'credit' : 'debit',
          amount,
          rateSnapshotId,
          '历史资产期初权益'
        )
      );
    }
    if (lines.length === 0) return false;
    await this.postingService.post(tx, {
      journalType: 'opening_balance',
      sourceType: 'opening_balance',
      sourceId: 'legacy-assets-v1',
      sourceReference: 'legacy-assets-v1',
      occurredAt: enabledAt,
      summary: '历史资产期初差额',
      metadata: { assumption: 'legacy_assumed_cny' },
      idempotencyKey: 'legacy:asset_opening:v1',
      operator,
      lines
    });
    return true;
  }
}
