import { ConfigService } from '@nestjs/config';
import { generateKeyPairSync, verify } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2WebsiteAnalyticsClient } from './id-business-v2-website-analytics.client';

afterEach(() => vi.unstubAllGlobals());

describe('dedicated website analytics client', () => {
  it('uses only the verified property, stream and hosts with a read-only signed grant', async () => {
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const credential = {
      type: 'service_account',
      client_email: 'test@fixture.iam.gserviceaccount.com',
      private_key: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
      token_uri: 'https://untrusted.example/token'
    };
    const client = new IdBusinessV2WebsiteAnalyticsClient(
      new ConfigService({ WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON: JSON.stringify(credential) })
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'test-only-token', expires_in: 3600 }))
      )
      .mockImplementation(async () => new Response(JSON.stringify({ reports: [] })));
    vi.stubGlobal('fetch', fetchMock);
    await client.reports(7);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/token');
    expect(options.redirect).toBe('error');
    const assertion = new URLSearchParams(options.body).get('assertion')!;
    const [header, payload, signature] = assertion.split('.');
    expect(
      verify(
        'RSA-SHA256',
        Buffer.from(header + '.' + payload),
        pair.publicKey,
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true);
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toMatchObject({
      scope: 'https://www.googleapis.com/auth/analytics.readonly'
    });
    const [reportUrl, reportOptions] = fetchMock.mock.calls[1];
    expect(reportUrl).toBe(
      'https://analyticsdata.googleapis.com/v1beta/properties/540413787:batchRunReports'
    );
    const request = JSON.parse(reportOptions.body);
    expect(request.requests).toHaveLength(2);
    expect(request.requests[0].dimensions).toEqual([]);
    expect(request.requests[1].dimensions).toEqual([{ name: 'date' }]);
    expect(JSON.stringify(request)).toContain('15010607367');
    expect(JSON.stringify(request)).toContain('flashcast.com.my');
    expect(JSON.stringify(request)).not.toContain('damatong');
    await client.reports(30);
    expect(
      fetchMock.mock.calls.filter(([target]) => target === 'https://oauth2.googleapis.com/token')
    ).toHaveLength(1);
  });
  it('rejects malformed credentials without an outbound request or exposing the input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2WebsiteAnalyticsClient(
      new ConfigService({ WEBSITE_ANALYTICS_SERVICE_ACCOUNT_JSON: 'private-invalid-json' })
    );
    await expect(client.reports(7)).rejects.toThrow('访问统计授权不可用');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
