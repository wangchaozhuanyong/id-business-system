import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  IdBusinessV2ExchangeRatePersistenceService,
  IdBusinessV2ExchangeRateRunError
} from './id-business-v2-exchange-rate-persistence.service';
import { IdBusinessV2OtcAverageError } from './id-business-v2-otc-average.service';

function side(sideValue: 'merchant_buy' | 'merchant_sell') {
  return {
    side: sideValue,
    sourceUrl: 'https://provider.example',
    receivedAdCount: 1,
    collectorAcceptedAdCount: 1,
    collectorRejectedAdCount: 0,
    validAdCount: 1,
    filteredAdCount: 0,
    excludedByReason: {
      missing_tradable_amount: 0,
      non_positive_tradable_amount: 0,
      missing_order_count: 0,
      low_order_count: 0,
      missing_completion_rate: 0,
      low_completion_rate: 0,
      price_outlier: 0
    },
    medianRateToRmb: Rate8.from('6.7'),
    lowestValidRateToRmb: Rate8.from('6.7'),
    highestValidRateToRmb: Rate8.from('6.7'),
    averageRateToRmb: Rate8.from('6.7'),
    validSamples: [
      {
        sourceAdId: `sample-${sideValue}`,
        priceToRmb: Rate8.from('6.7'),
        minAmountRmb: Amount4.from('100'),
        maxAmountRmb: Amount4.from('10000'),
        tradableAmountUsdt: Amount4.from('2000'),
        paymentMethods: ['bank'],
        merchantType: 'merchant',
        completedOrderCount: 100,
        completionRate: Rate8.from('0.99'),
        positiveReviewRate: Rate8.from('0.98')
      }
    ]
  };
}

function successfulResult() {
  const averagedAt = new Date('2026-08-01T00:00:00.000Z');
  return {
    asset: 'USDT' as const,
    fiat: 'CNY' as const,
    targetAmountRmb: Amount4.from('5000'),
    averagedAt,
    policy: {
      minCompletedOrderCount: 10,
      minCompletionRate: Rate8.from('0.9'),
      maxPriceDeviationRate: Rate8.from('0.03'),
      minValidAdsPerSide: 1,
      decimalPlaces: 8
    },
    platforms: [
      {
        provider: 'Binance' as const,
        sourceContract: 'binance-p2p-friendly-adv-search-v2' as const,
        collectedAt: averagedAt,
        merchantBuy: side('merchant_buy'),
        merchantSell: side('merchant_sell')
      },
      {
        provider: 'OKX' as const,
        sourceContract: 'okx-public-trading-orders-books-v3' as const,
        collectedAt: averagedAt,
        merchantBuy: side('merchant_buy'),
        merchantSell: side('merchant_sell')
      }
    ] as const,
    combinedMerchantBuyAverageRateToRmb: Rate8.from('6.7'),
    combinedMerchantSellAverageRateToRmb: Rate8.from('6.8'),
    midRateToRmb: Rate8.from('6.75')
  };
}

describe('IdBusinessV2ExchangeRatePersistenceService transaction boundary', () => {
  const repository = {
    createRun: vi.fn(),
    createSnapshot: vi.fn(),
    createProviderSnapshot: vi.fn(),
    createQuoteSamples: vi.fn(),
    updateRunSuccess: vi.fn(),
    updateRunFailure: vi.fn()
  };
  const midRate = { collectAndCalculate: vi.fn() };
  const audit = { append: vi.fn() };
  const committedStatuses: string[] = [];
  const transactionManager = {
    execute: vi.fn(async (work: (tx: { staged: string[] }) => Promise<unknown>) => {
      const tx = { staged: [] as string[] };
      const result = await work(tx);
      committedStatuses.push(...tx.staged);
      return result;
    })
  };
  const service = new IdBusinessV2ExchangeRatePersistenceService(
    repository as never,
    midRate as never,
    transactionManager as never,
    audit as never
  );

  beforeEach(() => {
    vi.clearAllMocks();
    committedStatuses.length = 0;
    repository.createRun.mockResolvedValue({ id: 'run-1' });
    repository.createSnapshot.mockResolvedValue({ id: 'snapshot-1' });
    repository.createProviderSnapshot.mockResolvedValue({ id: 'provider-1' });
    repository.createQuoteSamples.mockResolvedValue({ count: 1 });
    repository.updateRunSuccess.mockImplementation(async (tx: { staged: string[] }) => {
      tx.staged.push('success');
    });
    repository.updateRunFailure.mockImplementation(async (tx: { staged: string[] }) => {
      tx.staged.push('failed');
    });
    midRate.collectAndCalculate.mockResolvedValue(successfulResult());
    audit.append.mockResolvedValue({ id: 'audit-1' });
  });

  it('atomically saves the snapshot, successful run and audit', async () => {
    await expect(
      service.collectAndPersist({
        triggerType: 'manual',
        targetAmountRmb: Amount4.from('5000'),
        triggeredByUserId: 'operator-1',
        requestId: 'request-1'
      })
    ).resolves.toMatchObject({ status: 'success', runId: 'run-1', midRateToRmb: '6.75' });
    expect(committedStatuses).toEqual(['success']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'id_business_v2.exchange_rate.collect.success' })
    );
  });

  it('keeps the active-run unique conflict as a non-retried command conflict', async () => {
    transactionManager.execute.mockRejectedValueOnce(new ConflictException('active'));
    await expect(
      service.collectAndPersist({ triggerType: 'manual', targetAmountRmb: Amount4.from('5000') })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(midRate.collectAndCalculate).not.toHaveBeenCalled();
  });

  it('atomically records collection failure status and audit evidence', async () => {
    midRate.collectAndCalculate.mockRejectedValue(
      new IdBusinessV2OtcAverageError(
        'otc_average_insufficient_valid_quotes',
        '有效报价不足',
        'OKX',
        'merchant_sell',
        true
      )
    );
    await expect(
      service.collectAndPersist({ triggerType: 'scheduled', targetAmountRmb: Amount4.from('5000') })
    ).rejects.toBeInstanceOf(IdBusinessV2ExchangeRateRunError);
    expect(committedStatuses).toEqual(['failed']);
    expect(audit.append).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'id_business_v2.exchange_rate.collect.failed' })
    );
  });

  it('does not commit success and does not rewrite it as a collection failure when audit fails', async () => {
    audit.append
      .mockResolvedValueOnce({ id: 'audit-start' })
      .mockRejectedValueOnce(new Error('audit unavailable'));
    await expect(
      service.collectAndPersist({ triggerType: 'system', targetAmountRmb: Amount4.from('5000') })
    ).rejects.toThrow('audit unavailable');
    expect(committedStatuses).toEqual([]);
    expect(repository.updateRunFailure).not.toHaveBeenCalled();
  });
});
