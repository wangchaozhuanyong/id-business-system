import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  IdBusinessV2BinanceOtcCollector
} = require('../apps/api/dist/id-business-v2/exchange-rates/id-business-v2-binance-otc.collector.js');

const collector = new IdBusinessV2BinanceOtcCollector();
const result = await collector.collect();

assert.equal(result.provider, 'Binance');
assert.equal(result.sourceContract, 'binance-public-agent-ad-list-v1');
assert.equal(result.asset, 'USDT');
assert.equal(result.fiat, 'CNY');
assert.equal(result.merchantBuy.tradeType, 'SELL');
assert.equal(result.merchantSell.tradeType, 'BUY');
assert.ok(result.merchantBuy.ads.length > 0, 'Binance merchant buy samples are empty');
assert.ok(result.merchantSell.ads.length > 0, 'Binance merchant sell samples are empty');
assert.ok(
  result.merchantBuy.ads.every(
    (item) => item.side === 'merchant_buy' && item.priceToRmb.greaterThan(0)
  ),
  'Binance merchant buy samples contain invalid side or price'
);
assert.ok(
  result.merchantSell.ads.every(
    (item) => item.side === 'merchant_sell' && item.priceToRmb.greaterThan(0)
  ),
  'Binance merchant sell samples contain invalid side or price'
);

const serialized = JSON.stringify(result);
for (const forbiddenField of ['averageBuyRate', 'averageSellRate', 'midRate']) {
  assert.equal(
    serialized.includes(forbiddenField),
    false,
    `V2701 must not calculate ${forbiddenField}`
  );
}

function summarizeSide(side) {
  const prices = side.ads.map((item) => item.priceToRmb);
  const lowest = prices.reduce((current, value) => (value.lessThan(current) ? value : current));
  const highest = prices.reduce((current, value) => (value.greaterThan(current) ? value : current));
  return {
    tradeType: side.tradeType,
    receivedAdCount: side.receivedAdCount,
    acceptedAdCount: side.acceptedAdCount,
    rejectedAdCount: side.rejectedAdCount,
    lowestPriceToRmb: lowest.toString(),
    highestPriceToRmb: highest.toString()
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
