import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2CurrencyApiPurchaseRateProvider } from './id-business-v2-currencyapi-purchase-rate.provider';
import { IdBusinessV2PurchaseRateProviderError } from './id-business-v2-purchase-rate-provider.types';

describe('IdBusinessV2CurrencyApiPurchaseRateProvider', () => {
  const originalKey = process.env.CURRENCY_API_KEY;
  const originalTimeout = process.env.CURRENCY_RATE_REQUEST_TIMEOUT_MS;

  beforeEach(() => {
    process.env.CURRENCY_API_KEY = 'test-api-key';
    delete process.env.CURRENCY_RATE_REQUEST_TIMEOUT_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (originalKey === undefined) delete process.env.CURRENCY_API_KEY;
    else process.env.CURRENCY_API_KEY = originalKey;
    if (originalTimeout === undefined) delete process.env.CURRENCY_RATE_REQUEST_TIMEOUT_MS;
    else process.env.CURRENCY_RATE_REQUEST_TIMEOUT_MS = originalTimeout;
  });

  it('requests an explicit CNY base and keeps the API key out of the URL', async () => {
    const providerTimestamp = new Date(Date.now() - 60_000).toISOString();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          meta: { last_updated_at: providerTimestamp },
          data: {
            USD: { code: 'USD', value: 0.125 },
            EUR: { code: 'EUR', value: 0.11 }
          }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    vi.stubGlobal('fetch', fetchMock);
    const provider = new IdBusinessV2CurrencyApiPurchaseRateProvider();

    const result = await provider.fetchLatest(['USD', 'EUR']);

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.searchParams.get('base_currency')).toBe('CNY');
    expect(url.searchParams.get('currencies')).toBe('USD,EUR');
    expect(url.toString()).not.toContain('test-api-key');
    expect(init.headers).toMatchObject({ apikey: 'test-api-key' });
    expect(result.quotePerCny).toEqual({ USD: '0.125', EUR: '0.11' });
    expect(result.providerUpdatedAt.toISOString()).toBe(providerTimestamp);
  });

  it('rejects incomplete responses without fabricating a zero rate', async () => {
    const providerTimestamp = new Date(Date.now() - 60_000).toISOString();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { last_updated_at: providerTimestamp },
            data: { USD: { code: 'USD', value: 0.125 } }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      )
    );
    const provider = new IdBusinessV2CurrencyApiPurchaseRateProvider();

    await expect(provider.fetchLatest(['USD', 'EUR'])).rejects.toMatchObject({
      code: 'purchase_rate_provider_incomplete_response',
      retryable: true
    } satisfies Partial<IdBusinessV2PurchaseRateProviderError>);
  });

  it.each([
    [429, true],
    [503, true],
    [401, false]
  ] as const)(
    'classifies HTTP %s retryability without exposing response bodies',
    async (status, retryable) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('sensitive body', { status })));
      const provider = new IdBusinessV2CurrencyApiPurchaseRateProvider();

      await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
        code: `purchase_rate_provider_http_${status}`,
        message: `自动汇率供应商返回 HTTP ${status}`,
        retryable
      } satisfies Partial<IdBusinessV2PurchaseRateProviderError>);
    }
  );

  it('rejects zero, non-numeric and future-dated provider data', async () => {
    const provider = new IdBusinessV2CurrencyApiPurchaseRateProvider();
    for (const value of [0, 'NaN']) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              meta: { last_updated_at: new Date(Date.now() - 60_000).toISOString() },
              data: { USD: { code: 'USD', value } }
            }),
            { status: 200 }
          )
        )
      );
      await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
        code: 'purchase_rate_provider_incomplete_response'
      });
    }

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            meta: { last_updated_at: new Date(Date.now() + 10 * 60_000).toISOString() },
            data: { USD: { code: 'USD', value: 0.125 } }
          }),
          { status: 200 }
        )
      )
    );
    await expect(provider.fetchLatest(['USD'])).rejects.toMatchObject({
      code: 'purchase_rate_provider_timestamp_invalid'
    });
  });
});
