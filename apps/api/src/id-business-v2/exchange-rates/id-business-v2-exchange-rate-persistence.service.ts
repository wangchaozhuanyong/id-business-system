import { Injectable } from '@nestjs/common';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction,
  type V2JsonDocument
} from '../runtime/public-api';
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
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

export type IdBusinessV2ExchangeRateTrigger = 'manual' | 'scheduled' | 'system';

interface NormalizedFailure {
  code: string;
  message: string;
  provider: 'binance' | 'okx' | 'multiple' | 'system';
  side: IdBusinessV2OtcSide | null;
  retryable: boolean;
  details: V2JsonDocument;
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
  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly midRateService: IdBusinessV2OtcMidRateService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async collectAndPersist(input: {
    triggerType: IdBusinessV2ExchangeRateTrigger;
    targetAmountRmb: Amount4;
    triggeredByUserId?: string;
    requestId?: string;
  }) {
    const startedAt = new Date();
    const run = await this.transactionManager.execute(
      async (tx) => {
        const created = await this.repository.createRun(tx, {
          triggerType: input.triggerType,
          targetAmountRmb: input.targetAmountRmb.toString(),
          startedAt,
          triggeredByUserId: input.triggeredByUserId
        });
        await this.audit.append(tx, {
          userId: input.triggeredByUserId,
          module: 'id_business_v2',
          action: 'id_business_v2.exchange_rate.collect.started',
          objectType: 'id_business_v2_exchange_rate_run',
          objectId: created.id,
          afterData: {
            status: 'running',
            triggerType: input.triggerType,
            targetAmountRmb: input.targetAmountRmb.toString(),
            startedAt: startedAt.toISOString()
          },
          remark: 'V2 汇率采集批次已开始'
        });
        return created;
      },
      {
        requestId: input.requestId ?? `exchange-rate-run-start-${input.triggerType}`,
        retryMode: 'none',
        uniqueConflictMessage: '已有汇率采集正在运行，请稍后再试'
      }
    );

    let result: IdBusinessV2OtcMidRateResult;
    try {
      result = await this.midRateService.collectAndCalculate(input.targetAmountRmb);
    } catch (error) {
      const failure = this.normalizeFailure(error);
      await this.persistFailure(run.id, input, startedAt, failure);
      throw new IdBusinessV2ExchangeRateRunError(
        run.id,
        failure.code,
        failure.message,
        failure.provider,
        failure.side,
        failure.retryable
      );
    }
    return this.persistSuccess(run.id, input, startedAt, result);
  }

  private async persistSuccess(
    runId: string,
    input: {
      triggerType: IdBusinessV2ExchangeRateTrigger;
      targetAmountRmb: Amount4;
      triggeredByUserId?: string;
      requestId?: string;
    },
    startedAt: Date,
    result: IdBusinessV2OtcMidRateResult
  ) {
    const finishedAt = new Date();
    return this.transactionManager.execute(
      async (tx) => {
        const snapshot = await this.repository.createSnapshot(tx, {
          runId,
          asset: result.asset,
          fiat: result.fiat,
          averagedAt: result.averagedAt,
          combinedMerchantBuyAverageRateToRmb:
            result.combinedMerchantBuyAverageRateToRmb.toString(),
          combinedMerchantSellAverageRateToRmb:
            result.combinedMerchantSellAverageRateToRmb.toString(),
          midRateToRmb: result.midRateToRmb.toString()
        });

        let validSampleCount = 0;
        for (const platform of result.platforms) {
          validSampleCount += await this.persistPlatform(tx, snapshot.id, platform);
        }

        await this.repository.updateRunSuccess(tx, runId, {
          finishedAt,
          policyMinCompletedOrderCount: result.policy.minCompletedOrderCount,
          policyMinCompletionRate: result.policy.minCompletionRate.toString(),
          policyMaxPriceDeviationRate: result.policy.maxPriceDeviationRate.toString(),
          policyMinValidAdsPerSide: result.policy.minValidAdsPerSide,
          policyDecimalPlaces: result.policy.decimalPlaces
        });
        await this.audit.append(tx, {
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
            finishedAt: finishedAt.toISOString()
          },
          remark: 'V2 Binance 与 OKX 四方向汇率采集成功'
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
          combinedMerchantBuyAverageRateToRmb:
            result.combinedMerchantBuyAverageRateToRmb.toString(),
          combinedMerchantSellAverageRateToRmb:
            result.combinedMerchantSellAverageRateToRmb.toString(),
          midRateToRmb: result.midRateToRmb.toString(),
          providerSnapshotCount: 4,
          validSampleCount
        };
      },
      { requestId: input.requestId ?? `exchange-rate-run-success-${runId}`, retryMode: 'none' }
    );
  }

  private async persistPlatform(
    tx: V2CommandTransaction,
    snapshotId: string,
    platform: IdBusinessV2OtcPlatformAverage
  ) {
    let count = 0;
    for (const side of [platform.merchantBuy, platform.merchantSell]) {
      const providerSnapshot = await this.repository.createProviderSnapshot(tx, {
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
        medianRateToRmb: side.medianRateToRmb.toString(),
        lowestValidRateToRmb: side.lowestValidRateToRmb.toString(),
        highestValidRateToRmb: side.highestValidRateToRmb.toString(),
        averageRateToRmb: side.averageRateToRmb.toString()
      });
      await this.persistSamples(tx, providerSnapshot.id, side);
      count += side.validSamples.length;
    }
    return count;
  }

  private async persistSamples(
    tx: V2CommandTransaction,
    providerSnapshotId: string,
    side: IdBusinessV2OtcSideAverage
  ) {
    await this.repository.createQuoteSamples(
      tx,
      side.validSamples.map((sample) => ({
        providerSnapshotId,
        sourceAdId: sample.sourceAdId,
        priceToRmb: sample.priceToRmb.toString(),
        minAmountRmb: sample.minAmountRmb.toString(),
        maxAmountRmb: sample.maxAmountRmb.toString(),
        tradableAmountUsdt: sample.tradableAmountUsdt.toString(),
        paymentMethods: sample.paymentMethods,
        merchantType: sample.merchantType,
        completedOrderCount: sample.completedOrderCount,
        completionRate: sample.completionRate.toString(),
        positiveReviewRate: sample.positiveReviewRate?.toString() ?? null
      }))
    );
  }

  private async persistFailure(
    runId: string,
    input: {
      triggerType: IdBusinessV2ExchangeRateTrigger;
      triggeredByUserId?: string;
      requestId?: string;
    },
    startedAt: Date,
    failure: NormalizedFailure
  ) {
    const finishedAt = new Date();
    await this.transactionManager.execute(
      async (tx) => {
        await this.repository.updateRunFailure(tx, runId, {
          finishedAt,
          errorCode: failure.code,
          errorMessage: failure.message,
          errorProvider: failure.provider,
          errorSide: failure.side,
          errorRetryable: failure.retryable,
          errorDetails: failure.details
        });
        await this.audit.append(tx, {
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
            startedAt: startedAt.toISOString(),
            finishedAt: finishedAt.toISOString()
          },
          remark: failure.message
        });
      },
      { requestId: input.requestId ?? `exchange-rate-run-failure-${runId}`, retryMode: 'none' }
    );
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
