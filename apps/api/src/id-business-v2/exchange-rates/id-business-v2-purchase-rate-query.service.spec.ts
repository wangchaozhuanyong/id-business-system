import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { IdBusinessV2PurchaseRateQueryService } from './id-business-v2-purchase-rate-query.service';

const candidate = {
  currencyCode: 'USD',
  marketRateCnyPerUnit: '8',
  providerQuotePerCny: '0.125',
  purchaseRatio: '0.7',
  quoteUnit: '1',
  purchaseRateRaw: '5.6',
  purchaseRateDisplay: '5.6',
  decimalPlaces: 4,
  roundingMode: 'ROUND_DOWN',
  previousMarketRateCnyPerUnit: '7',
  changeRate: '0.14285714',
  abnormal: true
};

function service() {
  return new IdBusinessV2PurchaseRateQueryService({} as never, {} as never, {} as never);
}

describe('IdBusinessV2PurchaseRateQueryService candidate validation', () => {
  it('accepts a complete candidate batch matching the originally requested currencies', () => {
    expect(service().parseCandidates([candidate], ['USD'])).toEqual([candidate]);
  });

  it('rejects partial, duplicated or malformed review candidates', () => {
    expect(() => service().parseCandidates([candidate], ['USD', 'EUR'])).toThrow(
      '异常批次候选币种与原始请求不一致'
    );
    expect(() => service().parseCandidates([candidate, candidate], ['USD'])).toThrow(
      '异常批次候选币种与原始请求不一致'
    );
    expect(() =>
      service().parseCandidates([{ ...candidate, purchaseRateRaw: '-1' }], ['USD'])
    ).toThrow(ConflictException);
    expect(() =>
      service().parseCandidates([{ ...candidate, purchaseRatio: '1.01' }], ['USD'])
    ).toThrow(ConflictException);
  });
});
