import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Prisma } = require('@prisma/client');
const {
  IdBusinessV2BinanceOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-binance-otc.collector.js');
const {
  IdBusinessV2OkxOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-okx-otc.collector.js');
const {
  IdBusinessV2OtcAverageService
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-average.service.js');
const {
  IdBusinessV2OtcMidRateService
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-otc-mid-rate.service.js');

const averageService = new IdBusinessV2OtcAverageService(
  new IdBusinessV2BinanceOtcCollector(),
  new IdBusinessV2OkxOtcCollector()
);
const originalCollectAndAverage = averageService.collectAndAverage.bind(averageService);
let averageCollectionCallCount = 0;
let sourceAverageResult = null;
averageService.collectAndAverage = async () => {
  averageCollectionCallCount += 1;
  sourceAverageResult = await originalCollectAndAverage();
  return sourceAverageResult;
};

const service = new IdBusinessV2OtcMidRateService(averageService);
const result = await service.collectAndCalculate();

assert.equal(averageCollectionCallCount, 1);
assert.ok(sourceAverageResult);
assert.strictEqual(result.averagedAt, sourceAverageResult.averagedAt);
assert.strictEqual(result.platforms, sourceAverageResult.platforms);
assert.strictEqual(
  result.combinedMerchantBuyAverageRateToRmb,
  sourceAverageResult.combinedMerchantBuyAverageRateToRmb
);
assert.strictEqual(
  result.combinedMerchantSellAverageRateToRmb,
  sourceAverageResult.combinedMerchantSellAverageRateToRmb
);

const expectedMidRate = result.combinedMerchantBuyAverageRateToRmb
  .plus(result.combinedMerchantSellAverageRateToRmb)
  .div(new Prisma.Decimal(2))
  .toDecimalPlaces(result.policy.decimalPlaces, Prisma.Decimal.ROUND_HALF_UP);
assert.ok(result.midRateToRmb.equals(expectedMidRate));
assert.ok(
  result.midRateToRmb.greaterThanOrEqualTo(
    Prisma.Decimal.min(
      result.combinedMerchantBuyAverageRateToRmb,
      result.combinedMerchantSellAverageRateToRmb
    )
  )
);
assert.ok(
  result.midRateToRmb.lessThanOrEqualTo(
    Prisma.Decimal.max(
      result.combinedMerchantBuyAverageRateToRmb,
      result.combinedMerchantSellAverageRateToRmb
    )
  )
);

const serialized = JSON.stringify(result);
for (const forbiddenField of ['fallbackRate', 'defaultRate', 'cachedRate']) {
  assert.equal(
    serialized.includes(forbiddenField),
    false,
    `V2704 must not expose ${forbiddenField}`
  );
}
for (const forbiddenIdentityField of ['merchantId', 'nickName', 'publicUserId']) {
  assert.equal(
    serialized.includes(forbiddenIdentityField),
    false,
    `V2704 must not expose ${forbiddenIdentityField}`
  );
}

console.log(
  JSON.stringify(
    {
      ok: true,
      asset: result.asset,
      fiat: result.fiat,
      averagedAt: result.averagedAt.toISOString(),
      averageCollectionCallCount,
      providers: result.platforms.map((platform) => ({
        provider: platform.provider,
        collectedAt: platform.collectedAt.toISOString(),
        merchantBuyValidAdCount: platform.merchantBuy.validAdCount,
        merchantSellValidAdCount: platform.merchantSell.validAdCount
      })),
      combinedMerchantBuyAverageRateToRmb: result.combinedMerchantBuyAverageRateToRmb.toString(),
      combinedMerchantSellAverageRateToRmb: result.combinedMerchantSellAverageRateToRmb.toString(),
      midRateToRmb: result.midRateToRmb.toString(),
      sameAverageBatchVerified: true,
      deferred: {
        persistence: 'V2705',
        apiAndPage: 'V2706'
      }
    },
    null,
    2
  )
);
