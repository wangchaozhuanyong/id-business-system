import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  IdBusinessV2OtcAverageError,
  IdBusinessV2OtcAverageService
} from './id-business-v2-otc-average.service';
import { IdBusinessV2OtcMidRateService } from './id-business-v2-otc-mid-rate.service';
import { Amount4, Rate8 } from '../runtime/public-api';
import type {
  IdBusinessV2OtcCollection,
  IdBusinessV2OtcProviderName,
  IdBusinessV2OtcQuote,
  IdBusinessV2OtcSide
} from './id-business-v2-otc.types';

function quote(
  side: IdBusinessV2OtcSide,
  id: string,
  price: string,
  overrides: Partial<IdBusinessV2OtcQuote> = {}
): IdBusinessV2OtcQuote {
  return {
    sourceAdId: id,
    side,
    priceToRmb: Rate8.from(price),
    minAmountRmb: Amount4.from('1000'),
    maxAmountRmb: Amount4.from('10000'),
    tradableAmountUsdt: Amount4.from('2000'),
    paymentMethods: ['BANK'],
    merchantType: 'merchant',
    completedOrderCount: 100,
    completionRate: Rate8.from('0.99'),
    positiveReviewRate: Rate8.from('0.98'),
    ...overrides
  };
}

function collection(
  provider: IdBusinessV2OtcProviderName,
  buyBase: string,
  sellBase: string
): IdBusinessV2OtcCollection {
  const side = (name: IdBusinessV2OtcSide, base: string) => {
    const quotes = [
      quote(name, `${provider}-${name}-1`, base),
      quote(name, `${provider}-${name}-2`, new Prisma.Decimal(base).plus('0.01').toString()),
      quote(name, `${provider}-${name}-3`, new Prisma.Decimal(base).minus('0.01').toString()),
      quote(name, `${provider}-${name}-outlier`, new Prisma.Decimal(base).plus('1').toString()),
      quote(name, `${provider}-${name}-low-quality`, base, {
        completedOrderCount: 9
      })
    ];
    return {
      side: name,
      sourceUrl: provider === 'Binance' ? 'https://p2p.binance.com/' : 'https://www.okx.com/',
      receivedAdCount: quotes.length,
      acceptedAdCount: quotes.length,
      rejectedAdCount: 0,
      quotes
    };
  };
  return {
    provider,
    sourceContract:
      provider === 'Binance'
        ? 'binance-p2p-friendly-adv-search-v2'
        : 'okx-public-trading-orders-books-v3',
    asset: 'USDT',
    fiat: 'CNY',
    targetAmountRmb: Amount4.from('5000'),
    collectedAt: new Date(),
    merchantBuy: side('merchant_buy', buyBase),
    merchantSell: side('merchant_sell', sellBase)
  };
}

describe('IdBusinessV2OtcAverageService', () => {
  it('filters quality and outliers, weights platforms equally, and calculates Decimal mid rate', () => {
    const service = new IdBusinessV2OtcAverageService({} as never, {} as never);
    const averages = service.averageCollections(
      collection('Binance', '6.70', '6.74'),
      collection('OKX', '6.72', '6.76')
    );
    const result = new IdBusinessV2OtcMidRateService({} as never).calculate(averages);

    expect(averages.platforms[0].merchantBuy.validAdCount).toBe(3);
    expect(averages.platforms[0].merchantBuy.excludedByReason.low_order_count).toBe(1);
    expect(averages.platforms[0].merchantBuy.excludedByReason.price_outlier).toBe(1);
    expect(averages.combinedMerchantBuyAverageRateToRmb.toString()).toBe('6.71');
    expect(averages.combinedMerchantSellAverageRateToRmb.toString()).toBe('6.75');
    expect(result.midRateToRmb.toString()).toBe('6.73');
  });

  it('fails strictly when either provider fails instead of using one platform', async () => {
    const service = new IdBusinessV2OtcAverageService(
      {
        collect: vi.fn().mockResolvedValue(collection('Binance', '6.70', '6.74'))
      } as never,
      {
        collect: vi.fn().mockRejectedValue(new Error('upstream unavailable'))
      } as never
    );

    await expect(service.collectAndAverage(Amount4.from('5000'))).rejects.toBeInstanceOf(
      IdBusinessV2OtcAverageError
    );
    await expect(service.collectAndAverage(Amount4.from('5000'))).rejects.toMatchObject({
      code: 'otc_average_provider_collection_failed',
      provider: 'OKX'
    });
  });

  it('fails when a provider side has fewer than three valid quotes', () => {
    const service = new IdBusinessV2OtcAverageService({} as never, {} as never);
    const okx = collection('OKX', '6.72', '6.76');
    okx.merchantSell.quotes = okx.merchantSell.quotes.slice(0, 2);
    okx.merchantSell.receivedAdCount = 2;
    okx.merchantSell.acceptedAdCount = 2;

    expect(() => service.averageCollections(collection('Binance', '6.70', '6.74'), okx)).toThrow(
      IdBusinessV2OtcAverageError
    );
  });
});
