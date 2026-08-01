import { Injectable } from '@nestjs/common';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  IdBusinessV2BinanceOtcCollector,
  IdBusinessV2BinanceOtcError
} from './id-business-v2-binance-otc.collector';
import {
  IdBusinessV2OkxOtcCollector,
  IdBusinessV2OkxOtcError
} from './id-business-v2-okx-otc.collector';
import type {
  IdBusinessV2OtcCollection,
  IdBusinessV2OtcProviderFailure,
  IdBusinessV2OtcProviderName,
  IdBusinessV2OtcQuote,
  IdBusinessV2OtcSide,
  IdBusinessV2OtcSideCollection
} from './id-business-v2-otc.types';

export type IdBusinessV2OtcExclusionReason =
  | 'missing_tradable_amount'
  | 'non_positive_tradable_amount'
  | 'missing_order_count'
  | 'low_order_count'
  | 'missing_completion_rate'
  | 'low_completion_rate'
  | 'price_outlier';

export interface IdBusinessV2OtcPolicy {
  minCompletedOrderCount: number;
  minCompletionRate: Rate8;
  maxPriceDeviationRate: Rate8;
  minValidAdsPerSide: number;
  decimalPlaces: number;
}

export interface IdBusinessV2OtcSideAverage {
  side: IdBusinessV2OtcSide;
  sourceUrl: string;
  receivedAdCount: number;
  collectorAcceptedAdCount: number;
  collectorRejectedAdCount: number;
  validAdCount: number;
  filteredAdCount: number;
  excludedByReason: Record<IdBusinessV2OtcExclusionReason, number>;
  medianRateToRmb: Rate8;
  lowestValidRateToRmb: Rate8;
  highestValidRateToRmb: Rate8;
  averageRateToRmb: Rate8;
  validSamples: Array<{
    sourceAdId: string;
    priceToRmb: Rate8;
    minAmountRmb: Amount4;
    maxAmountRmb: Amount4;
    tradableAmountUsdt: Amount4;
    paymentMethods: string[];
    merchantType: string;
    completedOrderCount: number;
    completionRate: Rate8;
    positiveReviewRate: Rate8 | null;
  }>;
}

export interface IdBusinessV2OtcPlatformAverage {
  provider: IdBusinessV2OtcProviderName;
  sourceContract: string;
  collectedAt: Date;
  merchantBuy: IdBusinessV2OtcSideAverage;
  merchantSell: IdBusinessV2OtcSideAverage;
}

export interface IdBusinessV2OtcAverageResult {
  asset: 'USDT';
  fiat: 'CNY';
  targetAmountRmb: Amount4;
  averagedAt: Date;
  policy: IdBusinessV2OtcPolicy;
  platforms: [IdBusinessV2OtcPlatformAverage, IdBusinessV2OtcPlatformAverage];
  combinedMerchantBuyAverageRateToRmb: Rate8;
  combinedMerchantSellAverageRateToRmb: Rate8;
}

const POLICY: IdBusinessV2OtcPolicy = {
  minCompletedOrderCount: 10,
  minCompletionRate: Rate8.from('0.9'),
  maxPriceDeviationRate: Rate8.from('0.03'),
  minValidAdsPerSide: 3,
  decimalPlaces: V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES
};

const EXCLUSION_REASONS: IdBusinessV2OtcExclusionReason[] = [
  'missing_tradable_amount',
  'non_positive_tradable_amount',
  'missing_order_count',
  'low_order_count',
  'missing_completion_rate',
  'low_completion_rate',
  'price_outlier'
];

export class IdBusinessV2OtcAverageError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly provider: IdBusinessV2OtcProviderName | 'multiple' | null,
    readonly side: IdBusinessV2OtcSide | null,
    readonly retryable: boolean,
    readonly validAdCount: number | null = null,
    readonly requiredValidAdCount: number | null = null,
    readonly failures: IdBusinessV2OtcProviderFailure[] = []
  ) {
    super(message);
    this.name = 'IdBusinessV2OtcAverageError';
  }
}

@Injectable()
export class IdBusinessV2OtcAverageService {
  constructor(
    private readonly binanceCollector: IdBusinessV2BinanceOtcCollector,
    private readonly okxCollector: IdBusinessV2OkxOtcCollector
  ) {}

  async collectAndAverage(targetAmountRmb: Amount4) {
    const [binance, okx] = await Promise.allSettled([
      this.binanceCollector.collect(targetAmountRmb),
      this.okxCollector.collect(targetAmountRmb)
    ]);
    const failures = this.collectFailures(binance, okx);
    if (failures.length) {
      throw new IdBusinessV2OtcAverageError(
        'otc_average_provider_collection_failed',
        `双平台汇率采集失败：${failures.map((item) => item.provider).join('、')}`,
        failures.length > 1 ? 'multiple' : failures[0]!.provider,
        failures.length === 1 ? failures[0]!.side : null,
        failures.some((item) => item.retryable),
        null,
        null,
        failures
      );
    }
    if (binance.status !== 'fulfilled' || okx.status !== 'fulfilled') {
      throw new IdBusinessV2OtcAverageError(
        'otc_average_provider_collection_failed',
        '双平台汇率采集失败',
        'multiple',
        null,
        true
      );
    }
    return this.averageCollections(binance.value, okx.value);
  }

  averageCollections(
    binance: IdBusinessV2OtcCollection,
    okx: IdBusinessV2OtcCollection
  ): IdBusinessV2OtcAverageResult {
    if (
      binance.provider !== 'Binance' ||
      okx.provider !== 'OKX' ||
      !binance.targetAmountRmb.equals(okx.targetAmountRmb)
    ) {
      throw new IdBusinessV2OtcAverageError(
        'otc_average_invalid_collection',
        '双平台采集契约或目标成交额不一致',
        null,
        null,
        false
      );
    }

    const binanceAverage = this.averagePlatform(binance);
    const okxAverage = this.averagePlatform(okx);
    return {
      asset: 'USDT',
      fiat: 'CNY',
      targetAmountRmb: Amount4.from(binance.targetAmountRmb),
      averagedAt: new Date(),
      policy: this.policySnapshot(),
      platforms: [binanceAverage, okxAverage],
      combinedMerchantBuyAverageRateToRmb: this.averageDecimals([
        binanceAverage.merchantBuy.averageRateToRmb,
        okxAverage.merchantBuy.averageRateToRmb
      ]),
      combinedMerchantSellAverageRateToRmb: this.averageDecimals([
        binanceAverage.merchantSell.averageRateToRmb,
        okxAverage.merchantSell.averageRateToRmb
      ])
    };
  }

  private averagePlatform(collection: IdBusinessV2OtcCollection): IdBusinessV2OtcPlatformAverage {
    return {
      provider: collection.provider,
      sourceContract: collection.sourceContract,
      collectedAt: collection.collectedAt,
      merchantBuy: this.averageSide(collection.provider, collection.merchantBuy),
      merchantSell: this.averageSide(collection.provider, collection.merchantSell)
    };
  }

  private averageSide(
    provider: IdBusinessV2OtcProviderName,
    collection: IdBusinessV2OtcSideCollection
  ): IdBusinessV2OtcSideAverage {
    const excludedByReason = this.emptyExclusions();
    const qualityQuotes: IdBusinessV2OtcQuote[] = [];
    for (const quote of collection.quotes) {
      const reason = this.qualityExclusion(quote);
      if (reason) excludedByReason[reason] += 1;
      else qualityQuotes.push(quote);
    }

    const median = qualityQuotes.length
      ? this.median(qualityQuotes.map((quote) => quote.priceToRmb))
      : null;
    const validQuotes = median
      ? qualityQuotes.filter((quote) => {
          const deviation = quote.priceToRmb.sub(median).abs().div(median);
          if (deviation.gt(POLICY.maxPriceDeviationRate)) {
            excludedByReason.price_outlier += 1;
            return false;
          }
          return true;
        })
      : [];

    if (validQuotes.length < POLICY.minValidAdsPerSide) {
      throw new IdBusinessV2OtcAverageError(
        'otc_average_insufficient_valid_quotes',
        `${provider} ${this.sideLabel(collection.side)}有效报价不足`,
        provider,
        collection.side,
        true,
        validQuotes.length,
        POLICY.minValidAdsPerSide
      );
    }

    const prices = validQuotes.map((quote) => quote.priceToRmb);
    const sorted = [...prices].sort((left, right) => left.compare(right));
    return {
      side: collection.side,
      sourceUrl: collection.sourceUrl,
      receivedAdCount: collection.receivedAdCount,
      collectorAcceptedAdCount: collection.acceptedAdCount,
      collectorRejectedAdCount: collection.rejectedAdCount,
      validAdCount: validQuotes.length,
      filteredAdCount: collection.acceptedAdCount - validQuotes.length,
      excludedByReason,
      medianRateToRmb: Rate8.from(median!),
      lowestValidRateToRmb: Rate8.from(sorted[0]!),
      highestValidRateToRmb: Rate8.from(sorted[sorted.length - 1]!),
      averageRateToRmb: this.averageDecimals(prices),
      validSamples: validQuotes.map((quote) => ({
        sourceAdId: quote.sourceAdId,
        priceToRmb: quote.priceToRmb,
        minAmountRmb: quote.minAmountRmb,
        maxAmountRmb: quote.maxAmountRmb,
        tradableAmountUsdt: quote.tradableAmountUsdt!,
        paymentMethods: [...quote.paymentMethods],
        merchantType: quote.merchantType,
        completedOrderCount: quote.completedOrderCount!,
        completionRate: quote.completionRate!,
        positiveReviewRate: quote.positiveReviewRate
      }))
    };
  }

  private qualityExclusion(quote: IdBusinessV2OtcQuote): IdBusinessV2OtcExclusionReason | null {
    if (quote.tradableAmountUsdt === null) return 'missing_tradable_amount';
    if (quote.tradableAmountUsdt.lte(0)) return 'non_positive_tradable_amount';
    if (quote.completedOrderCount === null) return 'missing_order_count';
    if (quote.completedOrderCount < POLICY.minCompletedOrderCount) return 'low_order_count';
    if (quote.completionRate === null) return 'missing_completion_rate';
    if (quote.completionRate.lt(POLICY.minCompletionRate)) return 'low_completion_rate';
    return null;
  }

  private averageDecimals(values: Rate8[]) {
    return values.reduce((sum, value) => sum.add(value), Rate8.zero()).div(values.length);
  }

  private median(values: Rate8[]) {
    const sorted = [...values].sort((left, right) => left.compare(right));
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[middle]! : sorted[middle - 1]!.add(sorted[middle]!).div(2);
  }

  private collectFailures(
    binance: PromiseSettledResult<IdBusinessV2OtcCollection>,
    okx: PromiseSettledResult<IdBusinessV2OtcCollection>
  ) {
    const failures: IdBusinessV2OtcProviderFailure[] = [];
    if (binance.status === 'rejected') failures.push(this.failure('Binance', binance.reason));
    if (okx.status === 'rejected') failures.push(this.failure('OKX', okx.reason));
    return failures;
  }

  private failure(provider: IdBusinessV2OtcProviderName, error: unknown) {
    if (error instanceof IdBusinessV2BinanceOtcError || error instanceof IdBusinessV2OkxOtcError) {
      return {
        provider,
        causeCode: error.code,
        side: error.side,
        retryable: error.retryable
      };
    }
    return {
      provider,
      causeCode: 'unexpected_collection_error',
      side: null,
      retryable: true
    };
  }

  private policySnapshot(): IdBusinessV2OtcPolicy {
    return {
      ...POLICY,
      minCompletionRate: Rate8.from(POLICY.minCompletionRate),
      maxPriceDeviationRate: Rate8.from(POLICY.maxPriceDeviationRate)
    };
  }

  private emptyExclusions() {
    return Object.fromEntries(EXCLUSION_REASONS.map((reason) => [reason, 0])) as Record<
      IdBusinessV2OtcExclusionReason,
      number
    >;
  }

  private sideLabel(side: IdBusinessV2OtcSide) {
    return side === 'merchant_buy' ? '商家买入' : '商家卖出';
  }
}
