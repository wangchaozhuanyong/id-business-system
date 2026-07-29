import { ConflictException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  IdBusinessV2OtcAverageError,
  type IdBusinessV2OtcPlatformAverage,
  type IdBusinessV2OtcSideAverage
} from './id-business-v2-otc-average.service';
import {
  IdBusinessV2OtcMidRateService,
  type IdBusinessV2OtcMidRateResult
} from './id-business-v2-otc-mid-rate.service';
import type { IdBusinessV2OtcProviderName, IdBusinessV2OtcSide } from './id-business-v2-otc.types';

export type IdBusinessV2ExchangeRateTrigger = 'manual' | 'scheduled' | 'system';

interface NormalizedFailure {
  code: string;
  message: string;
  provider: 'binance' | 'okx' | 'multiple' | 'system';
  side: IdBusinessV2OtcSide | null;
  retryable: boolean;
  details: Prisma.InputJsonObject;
}

export class IdBusinessV2ExchangeRateRunError extends Error {
  constructor(
    readonly runId: string,
    readonly code: string,
    message: string,
    readonly provider: 'binance' | 'okx' | 'multiple' | 'system',
    readonly side: IdBusinessV2OtcSide | null,
    readonly retryable: boolean
  ) {
    super(message);
    this.name = 'IdBusinessV2ExchangeRateRunError';
  }
}

@Injectable()
export class IdBusinessV2ExchangeRatePersistenceService {
  private readonly logger = new Logger(IdBusinessV2ExchangeRatePersistenceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly midRateService: IdBusinessV2OtcMidRateService
  ) {}

  async collectAndPersist(input: {
    triggerType: IdBusinessV2ExchangeRateTrigger;
    targetAmountRmb: Prisma.Decimal;
    triggeredByUserId?: string;
  }) {
    const startedAt = new Date();
    let run: { id: string };
    try {
      run = await this.prisma.idBusinessV2ExchangeRateRun.create({
        data: {
          status: 'running',
          triggerType: input.triggerType,
          asset: 'USDT',
          fiat: 'CNY',
          targetAmountRmb: input.targetAmountRmb,
          startedAt,
          triggeredByUserId: input.triggerType === 'manual' ? input.triggeredByUserId : null
        },
        select: { id: true }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException('已有汇率采集正在运行，请稍后再试');
      }
      throw error;
    }

    try {
      const result = await this.midRateService.collectAndCalculate(input.targetAmountRmb);
      return await this.persistSuccess(run.id, input, startedAt, result);
    } catch (error) {
      const failure = this.normalizeFailure(error);
      try {
        await this.persistFailure(run.id, input, startedAt, failure);
      } catch {
        this.logger.error(`汇率批次 ${run.id} 无法保存失败状态`);
      }
      throw new IdBusinessV2ExchangeRateRunError(
        run.id,
        failure.code,
        failure.message,
        failure.provider,
        failure.side,
        failure.retryable
      );
    }
  }

  private async persistSuccess(
    runId: string,
    input: {
      triggerType: IdBusinessV2ExchangeRateTrigger;
      targetAmountRmb: Prisma.Decimal;
      triggeredByUserId?: string;
    },
    startedAt: Date,
    result: IdBusinessV2OtcMidRateResult
  ) {
    const finishedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const snapshot = await tx.idBusinessV2ExchangeRateSnapshot.create({
        data: {
          runId,
          asset: result.asset,
          fiat: result.fiat,
          averagedAt: result.averagedAt,
          combinedMerchantBuyAverageRateToRmb: result.combinedMerchantBuyAverageRateToRmb,
          combinedMerchantSellAverageRateToRmb: result.combinedMerchantSellAverageRateToRmb,
          midRateToRmb: result.midRateToRmb
        },
        select: { id: true }
      });

      let validSampleCount = 0;
      for (const platform of result.platforms) {
        validSampleCount += await this.persistPlatform(tx, snapshot.id, platform);
      }

      await tx.idBusinessV2ExchangeRateRun.update({
        where: { id: runId },
        data: {
          status: 'success',
          finishedAt,
          policyMinCompletedOrderCount: result.policy.minCompletedOrderCount,
          policyMinCompletionRate: result.policy.minCompletionRate,
          policyMaxPriceDeviationRate: result.policy.maxPriceDeviationRate,
          policyMinValidAdsPerSide: result.policy.minValidAdsPerSide,
          policyDecimalPlaces: result.policy.decimalPlaces
        }
      });
      await tx.auditLog.create({
        data: {
          userId: input.triggeredByUserId,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.collect.success',
          objectType: 'id_business_v2_exchange_rate_run',
          objectId: runId,
          afterData: {
            status: 'success',
            triggerType: input.triggerType,
            targetAmountRmb: input.targetAmountRmb.toString(),
            snapshotId: snapshot.id,
            midRateToRmb: result.midRateToRmb.toString(),
            providerSnapshotCount: 4,
            validSampleCount,
            finishedAt
          },
          remark: 'V2 Binance 与 OKX 四方向汇率采集成功'
        }
      });

      return {
        runId,
        snapshotId: snapshot.id,
        status: 'success' as const,
        triggerType: input.triggerType,
        targetAmountRmb: input.targetAmountRmb.toString(),
        startedAt,
        finishedAt,
        averagedAt: result.averagedAt,
        combinedMerchantBuyAverageRateToRmb: result.combinedMerchantBuyAverageRateToRmb.toString(),
        combinedMerchantSellAverageRateToRmb:
          result.combinedMerchantSellAverageRateToRmb.toString(),
        midRateToRmb: result.midRateToRmb.toString(),
        providerSnapshotCount: 4,
        validSampleCount
      };
    });
  }

  private async persistPlatform(
    tx: Prisma.TransactionClient,
    snapshotId: string,
    platform: IdBusinessV2OtcPlatformAverage
  ) {
    let count = 0;
    for (const side of [platform.merchantBuy, platform.merchantSell]) {
      const providerSnapshot = await tx.idBusinessV2ExchangeRateProviderSnapshot.create({
        data: {
          snapshotId,
          provider: this.providerValue(platform.provider),
          side: side.side,
          sourceContract: platform.sourceContract,
          sourceUrl: side.sourceUrl,
          collectedAt: platform.collectedAt,
          receivedAdCount: side.receivedAdCount,
          collectorAcceptedAdCount: side.collectorAcceptedAdCount,
          collectorRejectedAdCount: side.collectorRejectedAdCount,
          validAdCount: side.validAdCount,
          filteredAdCount: side.filteredAdCount,
          excludedMissingTradableAmount: side.excludedByReason.missing_tradable_amount,
          excludedNonPositiveTradable: side.excludedByReason.non_positive_tradable_amount,
          excludedMissingOrderCount: side.excludedByReason.missing_order_count,
          excludedLowOrderCount: side.excludedByReason.low_order_count,
          excludedMissingCompletionRate: side.excludedByReason.missing_completion_rate,
          excludedLowCompletionRate: side.excludedByReason.low_completion_rate,
          excludedPriceOutlier: side.excludedByReason.price_outlier,
          medianRateToRmb: side.medianRateToRmb,
          lowestValidRateToRmb: side.lowestValidRateToRmb,
          highestValidRateToRmb: side.highestValidRateToRmb,
          averageRateToRmb: side.averageRateToRmb
        },
        select: { id: true }
      });
      await this.persistSamples(tx, providerSnapshot.id, side);
      count += side.validSamples.length;
    }
    return count;
  }

  private async persistSamples(
    tx: Prisma.TransactionClient,
    providerSnapshotId: string,
    side: IdBusinessV2OtcSideAverage
  ) {
    await tx.idBusinessV2ExchangeRateQuoteSample.createMany({
      data: side.validSamples.map((sample) => ({
        providerSnapshotId,
        sourceAdId: sample.sourceAdId,
        priceToRmb: sample.priceToRmb,
        minAmountRmb: sample.minAmountRmb,
        maxAmountRmb: sample.maxAmountRmb,
        tradableAmountUsdt: sample.tradableAmountUsdt,
        paymentMethods: sample.paymentMethods,
        merchantType: sample.merchantType,
        completedOrderCount: sample.completedOrderCount,
        completionRate: sample.completionRate,
        positiveReviewRate: sample.positiveReviewRate
      }))
    });
  }

  private async persistFailure(
    runId: string,
    input: {
      triggerType: IdBusinessV2ExchangeRateTrigger;
      triggeredByUserId?: string;
    },
    startedAt: Date,
    failure: NormalizedFailure
  ) {
    const finishedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.idBusinessV2ExchangeRateRun.update({
        where: { id: runId },
        data: {
          status: 'failed',
          finishedAt,
          errorCode: failure.code,
          errorMessage: failure.message,
          errorProvider: failure.provider,
          errorSide: failure.side,
          errorRetryable: failure.retryable,
          errorDetails: failure.details
        }
      });
      await tx.auditLog.create({
        data: {
          userId: input.triggeredByUserId,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.collect.failed',
          objectType: 'id_business_v2_exchange_rate_run',
          objectId: runId,
          afterData: {
            status: 'failed',
            triggerType: input.triggerType,
            errorCode: failure.code,
            errorProvider: failure.provider,
            errorSide: failure.side,
            startedAt,
            finishedAt
          },
          remark: failure.message
        }
      });
    });
  }

  private normalizeFailure(error: unknown): NormalizedFailure {
    if (error instanceof IdBusinessV2OtcAverageError) {
      return {
        code: error.code.slice(0, 120),
        message: error.message.trim().slice(0, 1000),
        provider:
          error.provider === 'Binance'
            ? 'binance'
            : error.provider === 'OKX'
              ? 'okx'
              : error.provider === 'multiple'
                ? 'multiple'
                : 'system',
        side: error.side,
        retryable: error.retryable,
        details: {
          source: 'otc_average',
          failures: error.failures.map((failure) => ({
            provider: this.providerValue(failure.provider),
            causeCode: failure.causeCode,
            side: failure.side,
            retryable: failure.retryable
          })),
          ...(error.validAdCount === null ? {} : { validAdCount: error.validAdCount }),
          ...(error.requiredValidAdCount === null
            ? {}
            : { requiredValidAdCount: error.requiredValidAdCount })
        }
      };
    }
    return {
      code: 'exchange_rate_unexpected_failure',
      message: '汇率采集、计算或快照保存发生未分类错误',
      provider: 'system',
      side: null,
      retryable: true,
      details: {
        source: 'unexpected'
      }
    };
  }

  private providerValue(provider: IdBusinessV2OtcProviderName) {
    return provider === 'Binance' ? ('binance' as const) : ('okx' as const);
  }
}
