import { calculateV2PurchaseRate } from '@apple-business/shared';
import { describe, expect, it } from 'vitest';

describe('V2 purchase-rate calculator', () => {
  it.each([
    ['7.15', '0.7', 4, '5.0050'],
    ['8.32', '0.6', 4, '4.9920'],
    ['5.72345678', '0.685', 4, '3.9205'],
    ['0.04508765', '0.7', 5, '0.03156'],
    ['0.00512143', '0.7', 6, '0.003585']
  ] as const)(
    'calculates market rate %s with ratio %s independently',
    (marketRate, purchaseRatio, decimalPlaces, expected) => {
      expect(
        calculateV2PurchaseRate({
          marketRateCnyPerUnit: marketRate,
          purchaseRatio,
          quoteUnit: '1',
          decimalPlaces,
          roundingMode: 'ROUND_DOWN'
        }).purchaseRateFormatted
      ).toBe(expected);
    }
  );

  it('supports all controlled rounding modes', () => {
    const base = {
      marketRateCnyPerUnit: '1.23456',
      purchaseRatio: '0.7',
      quoteUnit: '1',
      decimalPlaces: 4
    } as const;

    expect(
      calculateV2PurchaseRate({ ...base, roundingMode: 'ROUND_DOWN' }).purchaseRateFormatted
    ).toBe('0.8641');
    expect(
      calculateV2PurchaseRate({ ...base, roundingMode: 'ROUND_HALF_UP' }).purchaseRateFormatted
    ).toBe('0.8642');
    expect(
      calculateV2PurchaseRate({ ...base, roundingMode: 'ROUND_UP' }).purchaseRateFormatted
    ).toBe('0.8642');
  });

  it('supports quote unit 100 and keeps exact factor multiplication before rounding', () => {
    const result = calculateV2PurchaseRate({
      marketRateCnyPerUnit: '0.04508765',
      purchaseRatio: '0.7225',
      quoteUnit: '100',
      decimalPlaces: 4,
      roundingMode: 'ROUND_HALF_UP'
    });

    expect(result.purchaseRateRaw).toBe('3.25758271');
    expect(result.purchaseRateFormatted).toBe('3.2576');
  });

  it('does not introduce a USD dependency between currency calculations', () => {
    const eur = (ratio: string) =>
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '8.32',
        purchaseRatio: ratio,
        quoteUnit: '1',
        decimalPlaces: 4,
        roundingMode: 'ROUND_DOWN'
      }).purchaseRateFormatted;
    const usd = (ratio: string) =>
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '7.15',
        purchaseRatio: ratio,
        quoteUnit: '1',
        decimalPlaces: 4,
        roundingMode: 'ROUND_DOWN'
      }).purchaseRateFormatted;

    expect(eur('0.6')).toBe('4.9920');
    expect(usd('0.7')).toBe('5.0050');
    expect(usd('0.5')).toBe('3.5750');
    expect(eur('0.6')).toBe('4.9920');
  });

  it('rejects values below the persisted eight-decimal rate precision', () => {
    expect(() =>
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '0.00000001',
        purchaseRatio: '0.01',
        quoteUnit: '1',
        decimalPlaces: 8,
        roundingMode: 'ROUND_DOWN'
      })
    ).toThrow('收购价小于系统可保存的最小汇率精度');
  });

  it('rejects raw or rounded display values outside DECIMAL(18, 8)', () => {
    expect(
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '9999999999.99999999',
        purchaseRatio: '1',
        quoteUnit: '1',
        decimalPlaces: 8,
        roundingMode: 'ROUND_DOWN'
      }).purchaseRateFormatted
    ).toBe('9999999999.99999999');

    expect(() =>
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '9999999999.99999999',
        purchaseRatio: '1',
        quoteUnit: '2',
        decimalPlaces: 8,
        roundingMode: 'ROUND_DOWN'
      })
    ).toThrow('收购价超过系统可保存的最大汇率范围');

    expect(() =>
      calculateV2PurchaseRate({
        marketRateCnyPerUnit: '9999999999.6',
        purchaseRatio: '1',
        quoteUnit: '1',
        decimalPlaces: 0,
        roundingMode: 'ROUND_UP'
      })
    ).toThrow('收购价超过系统可保存的最大汇率范围');
  });
});
