import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2VendureMailboxClient } from './id-business-v2-vendure-mailbox.client';

describe('IdBusinessV2VendureMailboxClient', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps the dedicated API key server-side on admin GraphQL requests', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(Response.json({ data: { icloudPrimaryAccounts: [] } }));
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    expect(client.isConfigured()).toBe(true);
    await expect(client.primaryAccounts()).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://vendure.example/admin-api');
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'vendure-api-key': 'dedicated-mailbox-key' })
    });
  });

  it('forwards the trusted client IP to the public Shop API without the admin key', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          icloudQueryMails: {
            success: true,
            message: null,
            targetType: 'virtual',
            aliasEmail: 'buyer@example.com',
            primaryEmail: null,
            codeExpiresAt: null,
            remainingDays: null,
            totalEmails: 0,
            items: [],
            virtualEmailsList: null
          }
        }
      })
    );
    vi.stubGlobal('fetch', fetchMock);
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_SHOP_API_URL: 'https://vendure.example/shop-api',
        VENDURE_MAILBOX_API_KEY: 'must-not-be-forwarded'
      })
    );

    await client.publicQuery('BUY-TEST-CODE', '203.0.113.25');
    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers['x-forwarded-for']).toBe('203.0.113.25');
    expect(headers['vendure-api-key']).toBeUndefined();
  });

  it('returns a sanitized service error when Vendure exposes GraphQL details', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json({ errors: [{ message: 'secret upstream detail' }] }))
    );
    const client = new IdBusinessV2VendureMailboxClient(
      new ConfigService({
        VENDURE_MAILBOX_ADMIN_API_URL: 'https://vendure.example/admin-api',
        VENDURE_MAILBOX_API_KEY: 'dedicated-mailbox-key'
      })
    );

    const error = await client.primaryAccounts().catch((value) => value);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(String(error.message)).not.toContain('secret upstream detail');
  });
});
