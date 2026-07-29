import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  IdBusinessV2BinanceOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-binance-otc.collector.js');
const {
  IdBusinessV2OkxOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-okx-otc.collector.js');
const {
  IdBusinessV2OtcAverageService
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-average.service.js');

const service = new IdBusinessV2OtcAverageService(
  new IdBusinessV2BinanceOtcCollector(),
  new IdBusinessV2OkxOtcCollector()
);
const result = await service.collectAndAverage();

assert.equal(result.asset, 'USDT');
assert.equal(result.fiat, 'CNY');
assert.equal(result.platforms.length, 2);
assert.deepEqual(
  result.platforms.map((platform) => platform.provider),
  ['Binance', 'OKX']
);
assert.equal(result.policy.minCompletedOrderCount, 10);
assert.equal(result.policy.minCompletionRate.toString(), '0.9');
assert.equal(result.policy.maxPriceDeviationRate.toString(), '0.03');
assert.equal(result.policy.minValidAdsPerSide, 3);

for (const platform of result.platforms) {
  for (const side of [platform.merchantBuy, platform.merchantSell]) {
    assert.ok(
      side.validAdCount >= result.policy.minValidAdsPerSide,
      `${platform.provider} ${side.side} valid quote count is insufficient`
    );
    assert.equal(
      side.validAdCount + side.filteredAdCount,
      side.collectorAcceptedAdCount,
      `${platform.provider} ${side.side} filter counts do not reconcile`
    );
    assert.equal(
      side.validSamples.length,
      side.validAdCount,
      `${platform.provider} ${side.side} valid samples do not reconcile`
    );
    assert.ok(
      side.validSamples.every(
        (sample) =>
          sample.priceToRmb.greaterThan(0) &&
          sample.tradableAmountUsdt.greaterThan(0) &&
          sample.completedOrderCount >= result.policy.minCompletedOrderCount &&
          sample.completionRate.greaterThanOrEqualTo(result.policy.minCompletionRate)
      ),
      `${platform.provider} ${side.side} contains an invalid saved sample`
    );
    assert.ok(side.averageRateToRmb.greaterThan(0));
    assert.ok(side.lowestValidRateToRmb.lessThanOrEqualTo(side.averageRateToRmb));
    assert.ok(side.highestValidRateToRmb.greaterThanOrEqualTo(side.averageRateToRmb));
  }
}

const [binance, okx] = result.platforms;
const expectedCombinedBuy = binance.merchantBuy.averageRateToRmb
  .plus(okx.merchantBuy.averageRateToRmb)
  .div(2)
  .toDecimalPlaces(result.policy.decimalPlaces);
const expectedCombinedSell = binance.merchantSell.averageRateToRmb
  .plus(okx.merchantSell.averageRateToRmb)
  .div(2)
  .toDecimalPlaces(result.policy.decimalPlaces);
assert.ok(result.combinedMerchantBuyAverageRateToRmb.equals(expectedCombinedBuy));
assert.ok(result.combinedMerchantSellAverageRateToRmb.equals(expectedCombinedSell));

const serialized = JSON.stringify(result);
for (const forbiddenField of ['midRate', 'midPrice', 'fallbackRate', 'defaultRate']) {
  assert.equal(
    serialized.includes(forbiddenField),
    false,
    `V2703 must not expose ${forbiddenField}`
  );
}
for (const forbiddenIdentityField of ['merchantId', 'nickName', 'publicUserId']) {
  assert.equal(
    serialized.includes(forbiddenIdentityField),
    false,
    `V2703 must not expose ${forbiddenIdentityField}`
  );
}

function summarizeSide(side) {
  return {
    receivedAdCount: side.receivedAdCount,
    collectorAcceptedAdCount: side.collectorAcceptedAdCount,
    collectorRejectedAdCount: side.collectorRejectedAdCount,
    validAdCount: side.validAdCount,
    filteredAdCount: side.filteredAdCount,
    excludedByReason: side.excludedByReason,
    medianRateToRmb: side.medianRateToRmb.toString(),
    lowestValidRateToRmb: side.lowestValidRateToRmb.toString(),
    highestValidRateToRmb: side.highestValidRateToRmb.toString(),
    averageRateToRmb: side.averageRateToRmb.toString()
  };
}

console.log(
  JSON.stringify(
    {
      ok: true,
      asset: result.asset,
      fiat: result.fiat,
      averagedAt: result.averagedAt.toISOString(),
      policy: {
        minCompletedOrderCount: result.policy.minCompletedOrderCount,
        minCompletionRate: result.policy.minCompletionRate.toString(),
        maxPriceDeviationRate: result.policy.maxPriceDeviationRate.toString(),
        minValidAdsPerSide: result.policy.minValidAdsPerSide,
        decimalPlaces: result.policy.decimalPlaces
      },
      platforms: result.platforms.map((platform) => ({
        provider: platform.provider,
        sourceContract: platform.sourceContract,
        collectedAt: platform.collectedAt.toISOString(),
        merchantBuy: summarizeSide(platform.merchantBuy),
        merchantSell: summarizeSide(platform.merchantSell)
      })),
      combinedMerchantBuyAverageRateToRmb: result.combinedMerchantBuyAverageRateToRmb.toString(),
      combinedMerchantSellAverageRateToRmb: result.combinedMerchantSellAverageRateToRmb.toString(),
      deferred: {
        midRate: 'V2704',
        persistence: 'V2705',
        apiAndPage: 'V2706'
      }
    },
    null,
    2
  )
);
