import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateApiPurchaseRateProvider } from './id-business-v2-exchange-rate-api-purchase-rate.provider';
import { IdBusinessV2PurchaseRateProviderError } from './id-business-v2-purchase-rate-provider.types';

function payload(
  rates: Record<string, unknown>,
  timeLastUpdateUnix = Math.floor((Date.now() - 60_000) / 1000)
) {
  return {
    result: 'success',
    provider: 'https://www.exchangerate-api.com',
    documentation: 'https://www.exchangerate-api.com/docs/free',
    terms_of_use: 'https://www.exchangerate-api.com/terms',
    time_last_update_unix: timeLastUpdateUnix,
    base_code: 'CNY',
    rates
  };
}

describe('IdBusinessV2ExchangeRateApiPurchaseRateProvider', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the no-key CNY endpoint and returns only requested currency rates', async () => {
    const providerTimestamp = Math.floor((Date.now() - 60_000) / 1000);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(payload({ USD: 0.125, EUR: 0.11 }, providerTimestamp)), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();

    const result = await provider.fetchLatest(['USD', 'EUR', 'USD']);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://open.er-api.com/v6/latest/CNY');
    expect(init.headers).toEqual({ accept: 'application/json' });
    expect(result).toMatchObject({
      provider: 'exchange_rate_api',
      baseCurrency: 'CNY',
      quotePerCny: { USD: '0.125', EUR: '0.11' },
      sourceContract: 'exchange-rate-api-open-v6-daily-cny-base',
      sourceReference: 'https://open.er-api.com/v6/latest/CNY'
    });
    expect(result.providerUpdatedAt.toISOString()).toBe(
      new Date(providerTimestamp * 1000).toISOString()
    );
  });

  it('preserves provider decimal tokens without JavaScript floating-point conversion', async () => {
    const body = JSON.stringify(payload({ USD: 0 })).replace(
      '"USD":0',
      '"USD":0.123456789012345678'
    );
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body, { status: 200 })));
    const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();

    await expect(provider.fetchLatest(['USD'])).resolves.toMatchObject({
      quotePerCny: { USD: '0.123456789012345678' }
    });
  });

  it('rejects responses that do not match the pinned provider contract', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ ...payload({ USD: 0.125 }), base_code: 'USD' }), {
          status: 200
        })
      )
    );
    const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();

    await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
      code: 'purchase_rate_provider_contract_invalid',
      retryable: true
    } satisfies Partial<IdBusinessV2PurchaseRateProviderError>);
  });

  it('rejects incomplete responses without fabricating a zero rate', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify(payload({ USD: 0.125 })), { status: 200 }))
    );
    const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();

    await expect(provider.fetchLatest(['USD', 'TWD'])).rejects.toMatchObject({
      code: 'purchase_rate_provider_incomplete_response',
      retryable: true
    } satisfies Partial<IdBusinessV2PurchaseRateProviderError>);
  });

  it.each([
    [429, true],
    [503, true],
    [403, false]
  ] as const)(
    'classifies HTTP %s retryability without exposing response bodies',
    async (status, retryable) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive body', { status })));
      const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();

      await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
        code: `purchase_rate_provider_http_${status}`,
        message: `自动汇率供应商返回 HTTP ${status}`,
        retryable
      } satisfies Partial<IdBusinessV2PurchaseRateProviderError>);
    }
  );

  it('rejects zero, non-numeric and future-dated provider data', async () => {
    const provider = new IdBusinessV2ExchangeRateApiPurchaseRateProvider();
    for (const value of [0, 'NaN']) {
      vi.stubGlobal(
        'fetch',
        vi
          .fn()
          .mockResolvedValue(new Response(JSON.stringify(payload({ USD: value })), { status: 200 }))
      );
      await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
        code: 'purchase_rate_provider_incomplete_response'
      });
    }

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify(payload({ USD: 0.125 }, Math.floor(Date.now() / 1000) + 10 * 60)),
            { status: 200 }
          )
        )
    );
    await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
      code: 'purchase_rate_provider_timestamp_invalid'
    });
  });
});
