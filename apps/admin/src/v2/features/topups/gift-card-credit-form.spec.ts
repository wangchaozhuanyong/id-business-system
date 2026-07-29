import { describe, expect, it } from 'vitest';
import type { V2ExchangeRateOverview } from '@/v2/types/exchangeRates';
import {
  buildManualGiftCardCreditPayload,
  resolveUsdtRateReference
} from './gift-card-credit-form';

function overviewWithRates(): V2ExchangeRateOverview {
  return {
    latestRun: null,
    lastSuccess: {
      id: 'run-1',
      status: 'success',
      triggerType: 'scheduled',
      targetAmountRmb: '1000',
      startedAt: '2026-07-29T03:00:00.000Z',
      finishedAt: '2026-07-29T03:00:10.000Z',
      triggeredBy: null,
      error: null,
      stale: false,
      expiresAt: '2026-07-29T03:12:00.000Z',
      snapshot: {
        id: 'snapshot-1',
        averagedAt: '2026-07-29T03:00:00.000Z',
        combinedMerchantBuyAverageRateToRmb: '6.74',
        combinedMerchantSellAverageRateToRmb: '6.78',
        midRateToRmb: '6.76',
        providerSnapshotCount: 4,
        validSampleCount: 20,
        providers: []
      }
    },
    effective: {
      available: true,
      reason: null,
      snapshotId: 'snapshot-1',
      midRateToRmb: '6.76',
      averagedAt: '2026-07-29T03:00:00.000Z'
    },
    calculationRule: 'test'
  };
}

describe('gift card manual rate form', () => {
  it('uses the latest USDT buy, sell and mid rates for read-only reference', () => {
    expect(resolveUsdtRateReference(overviewWithRates())).toEqual({
      merchantBuyRateToRmb: '6.74',
      merchantSellRateToRmb: '6.78',
      midRateToRmb: '6.76',
      averagedAt: '2026-07-29T03:00:00.000Z',
      stale: false
    });
  });

  it('keeps the card exchange rate manual and omits automatic snapshot fields', () => {
    const payload = buildManualGiftCardCreditPayload({
      code: 'ABCD123456',
      faceValue: ' 200 ',
      exchangeRate: ' 5.7 ',
      supplierOptionId: 'supplier-1',
      idempotencyKey: 'request-1',
      remark: ' manual rate '
    });

    expect(payload).toEqual({
      code: 'ABCD123456',
      faceValue: '200',
      exchangeRate: '5.7',
      supplierOptionId: 'supplier-1',
      idempotencyKey: 'request-1',
      remark: 'manual rate'
    });
    expect(payload).not.toHaveProperty('exchangeRateSnapshotId');
    expect(payload).not.toHaveProperty('exchangeRatePrefilledValue');
  });
});
