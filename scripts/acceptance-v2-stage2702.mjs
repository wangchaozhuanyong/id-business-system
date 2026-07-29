import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  IdBusinessV2OkxOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-okx-otc.collector.js');

const collector = new IdBusinessV2OkxOtcCollector();
const result = await collector.collect();

assert.equal(result.provider, 'OKX');
assert.equal(result.sourceContract, 'okx-public-trading-orders-books-v3');
assert.equal(result.asset, 'USDT');
assert.equal(result.fiat, 'CNY');
assert.equal(result.merchantBuy.sideParam, 'buy');
assert.equal(result.merchantSell.sideParam, 'sell');
assert.ok(result.merchantBuy.ads.length > 0, 'OKX merchant buy samples are empty');
assert.ok(result.merchantSell.ads.length > 0, 'OKX merchant sell samples are empty');
assert.ok(
  result.merchantBuy.ads.every(
    (item) =>
      item.side === 'merchant_buy' &&
      item.priceToRmb.greaterThan(0) &&
      item.merchantType !== 'common'
  ),
  'OKX merchant buy samples contain invalid side, price or merchant type'
);
assert.ok(
  result.merchantSell.ads.every(
    (item) =>
      item.side === 'merchant_sell' &&
      item.priceToRmb.greaterThan(0) &&
      item.merchantType !== 'common'
  ),
  'OKX merchant sell samples contain invalid side, price or merchant type'
);

const serialized = JSON.stringify(result);
for (const forbiddenField of ['averageBuyRate', 'averageSellRate', 'midRate']) {
  assert.equal(
    serialized.includes(forbiddenField),
    false,
    `V2702 must not calculate ${forbiddenField}`
  );
}

function summarizeSide(side) {
  const prices = side.ads.map((item) => item.priceToRmb);
  const lowest = prices.reduce((current, value) => (value.lessThan(current) ? value : current));
  const highest = prices.reduce((current, value) => (value.greaterThan(current) ? value : current));
  return {
    sideParam: side.sideParam,
    receivedAdCount: side.receivedAdCount,
    acceptedAdCount: side.acceptedAdCount,
    rejectedAdCount: side.rejectedAdCount,
    lowestPriceToRmb: lowest.toString(),
    highestPriceToRmb: highest.toString(),
    merchantTypes: [...new Set(side.ads.map((item) => item.merchantType))].sort()
  };
}

console.log(
  JSON.stringify(
    {
      ok: true,
      provider: result.provider,
      sourceContract: result.sourceContract,
      asset: result.asset,
      fiat: result.fiat,
      collectedAt: result.collectedAt.toISOString(),
      merchantBuy: summarizeSide(result.merchantBuy),
      merchantSell: summarizeSide(result.merchantSell),
      businessCalculationsDeferred: {
        effectiveQuoteFiltering: 'V2703',
        platformAverages: 'V2703',
        midRate: 'V2704'
      }
    },
    null,
    2
  )
);
