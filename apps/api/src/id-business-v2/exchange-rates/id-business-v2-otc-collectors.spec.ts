import { describe, expect, it, vi } from 'vitest';
import { Amount4 } from '../runtime/public-api';
import { IdBusinessV2BinanceOtcCollector } from './id-business-v2-binance-otc.collector';
import { IdBusinessV2OkxOtcCollector } from './id-business-v2-okx-otc.collector';

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

function binanceItem(tradeType: 'BUY' | 'SELL', overrides: Record<string, unknown> = {}) {
  return {
    adv: {
      advNo: `${tradeType}-ad`,
      tradeType,
      asset: 'USDT',
      fiatUnit: 'CNY',
      price: tradeType === 'BUY' ? '6.71' : '6.75',
      minSingleTransAmount: '1000',
      maxSingleTransAmount: '10000',
      tradableQuantity: '2000',
      tradeMethods: [{ payType: 'BANK' }],
      ...overrides
    },
    advertiser: {
      userType: 'merchant',
      monthOrderCount: 100,
      monthFinishRate: 0.99,
      positiveRate: 0.98
    }
  };
}

function okxItem(side: 'buy' | 'sell', overrides: Record<string, unknown> = {}) {
  return {
    id: `${side}-ad`,
    side,
    baseCurrency: 'usdt',
    quoteCurrency: 'cny',
    merchantId: `${side}-merchant`,
    creatorType: 'certified',
    price: side === 'buy' ? '6.71' : '6.75',
    quoteMinAmountPerOrder: '1000',
    quoteMaxAmountPerOrder: '10000',
    availableAmount: '2000',
    paymentMethods: ['bank'],
    completedOrderQuantity: 100,
    completedRate: '0.99',
    posReviewPercentage: '0.98',
    ...overrides
  };
}

describe('V2 OTC collectors', () => {
  it('maps Binance taker directions and sends merchant plus target-amount filters', async () => {
    const collector = new IdBusinessV2BinanceOtcCollector();
    const fetcher = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tradeType: 'BUY' | 'SELL' };
      const responseTradeType = body.tradeType === 'SELL' ? 'BUY' : 'SELL';
      return jsonResponse({
        code: '000000',
        data: [
          binanceItem(responseTradeType),
          binanceItem(responseTradeType, {
            advNo: `${responseTradeType}-wrong-amount`,
            minSingleTransAmount: '6000'
          })
        ]
      });
    });
    collector.setFetchImplementationForTest(fetcher as typeof fetch);

    const result = await collector.collect(Amount4.from('5000'));

    expect(result.merchantBuy.quotes[0]?.side).toBe('merchant_buy');
    expect(result.merchantSell.quotes[0]?.side).toBe('merchant_sell');
    expect(result.merchantBuy.acceptedAdCount).toBe(1);
    expect(result.merchantSell.acceptedAdCount).toBe(1);
    for (const [, init] of fetcher.mock.calls) {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({
        asset: 'USDT',
        fiat: 'CNY',
        publisherType: 'merchant',
        transAmount: '5000.00'
      });
    }
    expect(
      fetcher.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).tradeType).sort()
    ).toEqual(['BUY', 'SELL']);
  });

  it('requests 100 OKX ads per side and filters target limits locally', async () => {
    const collector = new IdBusinessV2OkxOtcCollector();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const side = new URL(String(input)).searchParams.get('side') as 'buy' | 'sell';
      return jsonResponse({
        code: 0,
        data: {
          buy: [
            okxItem('buy'),
            okxItem('buy', { id: 'buy-too-small', quoteMaxAmountPerOrder: '4999' })
          ],
          sell: [
            okxItem('sell'),
            okxItem('sell', { id: 'sell-too-large', quoteMinAmountPerOrder: '5001' })
          ],
          requestedSide: side
        }
      });
    });
    collector.setFetchImplementationForTest(fetcher as typeof fetch);

    const result = await collector.collect(Amount4.from('5000'));

    expect(result.merchantBuy.acceptedAdCount).toBe(1);
    expect(result.merchantSell.acceptedAdCount).toBe(1);
    for (const [input] of fetcher.mock.calls) {
      const url = new URL(String(input));
      expect(url.searchParams.get('limit')).toBe('100');
      expect(['buy', 'sell']).toContain(url.searchParams.get('side'));
    }
  });

  it('normalizes provider negative review-rate sentinels to missing data', async () => {
    const binance = new IdBusinessV2BinanceOtcCollector();
    binance.setFetchImplementationForTest((async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const body = JSON.parse(String(init?.body)) as { tradeType: 'BUY' | 'SELL' };
      const responseTradeType = body.tradeType === 'SELL' ? 'BUY' : 'SELL';
      const item = binanceItem(responseTradeType);
      item.advertiser.positiveRate = -1;
      return jsonResponse({ code: '000000', data: [item] });
    }) as typeof fetch);

    const okx = new IdBusinessV2OkxOtcCollector();
    okx.setFetchImplementationForTest((async (input: RequestInfo | URL) => {
      const side = new URL(String(input)).searchParams.get('side') as 'buy' | 'sell';
      return jsonResponse({
        code: 0,
        data: {
          buy: [okxItem('buy', { posReviewPercentage: -1 })],
          sell: [okxItem('sell', { posReviewPercentage: -1 })],
          requestedSide: side
        }
      });
    }) as typeof fetch);

    const [binanceResult, okxResult] = await Promise.all([
      binance.collect(Amount4.from('5000')),
      okx.collect(Amount4.from('5000'))
    ]);

    expect(binanceResult.merchantBuy.quotes[0]?.positiveReviewRate).toBeNull();
    expect(binanceResult.merchantSell.quotes[0]?.positiveReviewRate).toBeNull();
    expect(okxResult.merchantBuy.quotes[0]?.positiveReviewRate).toBeNull();
    expect(okxResult.merchantSell.quotes[0]?.positiveReviewRate).toBeNull();
  });
});
